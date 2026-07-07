/**
 * Optional LangChain.js / LangGraph integration — the SDK-aligned way to observe a framework.
 *
 * The SDK-aligned integration point for a framework is its **callback system**, not client
 * monkeypatching: `@langchain/openai` consumes usage through its own response path and streams via
 * async iterators, so `instrument()` on the raw client can miss usage — observing through callbacks
 * sidesteps that. {@link CendorCallbackHandler} reads LangChain's own `usage_metadata` (which carries
 * **reasoning** and **cached** token breakdowns), prices the call offline, correlates multi-node /
 * multi-agent runs via `traceId`, and emits normalized {@link LLMCall} / {@link ToolCall} events on
 * the bus — so `tokenguard`, `acttrace`, and any other subscriber see LangChain activity with no
 * client touch.
 *
 * **Recording-only.** This path is post-call: it *observes*, it never enforces. `tokenguard`'s caps
 * and `acttrace`'s `guard()` act on the `instrument()` seam, which the callback path does not touch —
 * so pre-flight enforcement (budget blocking, redact-before-send) is a **no-op** here. Use the direct
 * provider SDK with `instrument()` when you need enforcement.
 *
 * Requires the optional peer dependency, keeping `@cendor/core` dependency-light (like
 * `@opentelemetry/api`). Importing this subpath without `@langchain/core` installed throws a clear
 * error.
 *
 *     npm install @langchain/core
 *
 * Usage:
 *
 * ```ts
 * import { CendorCallbackHandler } from '@cendor/core/langchain';
 * const handler = new CendorCallbackHandler();
 *
 * const llm = new ChatOpenAI({ model: 'gpt-4o', callbacks: [handler] });  // every call recorded
 * await llm.invoke('hi');
 *
 * // or per-call / per-agent — propagates to all LangGraph nodes, correlated by root run:
 * await agent.invoke({ messages: [...] }, { callbacks: [handler] });
 * ```
 */
import { createRequire } from 'node:module';

import type {
  BaseCallbackHandlerInput,
  BaseCallbackHandler as LangChainBaseCallbackHandler,
} from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import type { UsageMetadata } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';

import * as bus from './bus.js';
import * as prices from './prices.js';
import { LLMCall, ToolCall, Usage } from './types.js';

type LangChainBaseCtor = new (input?: BaseCallbackHandlerInput) => LangChainBaseCallbackHandler;

/**
 * Load LangChain's `BaseCallbackHandler` synchronously so this class can extend it, mirroring the
 * Python handler's import-time `ImportError` when the optional dependency is absent. LangChain
 * accepts handlers by duck-typing (`copy`/`name`/`awaitHandlers`), so the CJS build resolved here
 * interoperates with an ESM-imported `@langchain/core` in the host app.
 */
function loadBaseCallbackHandler(): LangChainBaseCtor {
  try {
    const req = createRequire(import.meta.url);
    const mod = req('@langchain/core/callbacks/base') as { BaseCallbackHandler: LangChainBaseCtor };
    return mod.BaseCallbackHandler;
  } catch (cause) {
    throw new Error(
      '@cendor/core/langchain requires @langchain/core. Install it with:  npm install @langchain/core',
      { cause },
    );
  }
}

const BaseCallbackHandler = loadBaseCallbackHandler();

/**
 * A LangChain / LangGraph callback handler that records usage, reasoning, tool calls, and run
 * correlation onto cendor's bus. **Recording-only** — never enforces (see the module docstring).
 *
 * Attach it globally (`new ChatOpenAI({ callbacks: [new CendorCallbackHandler()] })`), per call
 * (`{ callbacks: [handler] }`), or on an agent (`agent.invoke(..., { callbacks: [handler] })`) — for
 * LangGraph it propagates to every node and its tools.
 *
 * **Correlation.** Every emitted event carries a `traceId` that is the **root run id** of the
 * invocation — resolved by tracking the callback run tree (each run's `parentRunId`) and walking to
 * the top. So all model/tool calls of one `agent.invoke` (across its nodes and the react loop) share
 * one `traceId`, while separate invocations get distinct ones. A standalone `llm.invoke` uses its own
 * run id. This is a correlation *hook*, not an orchestrator: cendor groups by the framework's own run
 * tree; it invents no run graph.
 *
 * Every handler body is exception-safe (a recorder must never break the app); `raiseError` is left
 * `false` (the base default) so LangChain also swallows any escape.
 */
export class CendorCallbackHandler extends BaseCallbackHandler {
  override name = 'CendorCallbackHandler';

  // runId -> parentRunId (or null for a root), built from the *Start callbacks so each event can be
  // resolved to the root run it belongs to. Bounded: entries are removed on run end/error.
  private readonly parents = new Map<string, string | null>();
  // tool runId -> pending { name, input }, bridged from handleToolStart to handleToolEnd.
  private readonly toolRuns = new Map<string, { name: string; input: unknown }>();

  // Node is single-threaded, so — unlike the Python handler — there is no lock guarding the maps.

  /**
   * Share one handler instance across merged callback managers instead of copying. A stateful
   * correlation handler must observe the *whole* run tree; the base `copy()` returns a fresh clone
   * with empty maps, which would break trace-id resolution. Sharing is safe here: every handler body
   * is exception-safe and the map operations are idempotent, and returning the same identity also
   * lets LangChain's identity-based handler de-duplication work.
   */
  override copy(): this {
    return this;
  }

  // ------------------------------------------------------------------ run-tree bookkeeping

  private register(runId: string | undefined, parentRunId: string | undefined): void {
    if (!runId) return;
    this.parents.set(runId, parentRunId ?? null);
  }

  private forget(runId: string | undefined): void {
    if (!runId) return;
    this.parents.delete(runId);
  }

  /**
   * The root run id for this event: walk `parent` links up to the top. Falls back to
   * `parentRunId`/`runId` when the run tree wasn't observed (e.g. a bare model call).
   */
  private traceId(runId: string | undefined, parentRunId: string | undefined): string {
    let rid = runId ?? '';
    if (!rid) return parentRunId ?? '';
    const seen = new Set<string>();
    while (this.parents.has(rid) && this.parents.get(rid) && !seen.has(rid)) {
      seen.add(rid);
      rid = this.parents.get(rid) as string; // guarded truthy above
    }
    return rid;
  }

  override handleChainStart(
    _chain: Serialized,
    _inputs: unknown,
    runId: string,
    _runType?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    _runName?: string,
    parentRunId?: string,
  ): void {
    this.register(runId, parentRunId);
  }

  override handleChainEnd(_outputs: unknown, runId: string): void {
    this.forget(runId);
  }

  override handleChainError(_err: unknown, runId: string): void {
    this.forget(runId);
  }

  override handleChatModelStart(
    _llm: Serialized,
    _messages: unknown,
    runId: string,
    parentRunId?: string,
  ): void {
    this.register(runId, parentRunId);
  }

  override handleLLMStart(
    _llm: Serialized,
    _prompts: string[],
    runId: string,
    parentRunId?: string,
  ): void {
    this.register(runId, parentRunId);
  }

  // ------------------------------------------------------------------ LLM calls

  /** Emit an {@link LLMCall} with usage/reasoning/cost and a run-correlated `traceId`. */
  override handleLLMEnd(output: LLMResult, runId: string, parentRunId?: string): void {
    try {
      const usage = usageFromResult(output);
      const call = new LLMCall({
        id: uuidHex(),
        provider: 'langchain', // observed via the framework; the real model rides call.model
        model: modelFromResult(output),
        messages: [], // the callback path is usage-focused; prompts aren't recorded here
        usage,
        traceId: this.traceId(runId, parentRunId),
      });
      call.metadata.source = 'langchain';
      setCost(call, usage);
      bus.emit(call);
    } catch {
      // recording must never break the app
    } finally {
      this.forget(runId);
    }
  }

  /** Record a failed model call (no usage) with the error on metadata — never re-raised. */
  override handleLLMError(err: unknown, runId: string, parentRunId?: string): void {
    try {
      const call = new LLMCall({
        id: uuidHex(),
        provider: 'langchain',
        model: '',
        messages: [],
        traceId: this.traceId(runId, parentRunId),
      });
      call.metadata.source = 'langchain';
      call.metadata.error = errorMessage(err);
      bus.emit(call);
    } catch {
      // recording must never break the app
    } finally {
      this.forget(runId);
    }
  }

  // ------------------------------------------------------------------ tool calls

  /** Record the tool's parent (for correlation) and stash its name/args until it ends. */
  override handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
  ): void {
    this.register(runId, parentRunId);
    try {
      this.toolRuns.set(runId, { name: serializedName(tool) ?? 'tool', input });
    } catch {
      // recording must never break the app
    }
  }

  /** Emit a {@link ToolCall} (name, args, result) correlated to its run's root. */
  override handleToolEnd(output: unknown, runId: string, parentRunId?: string): void {
    try {
      const pending = this.toolRuns.get(runId);
      this.toolRuns.delete(runId);
      const tc = new ToolCall({
        id: uuidHex(),
        name: pending?.name ?? 'tool',
        arguments: { input: pending?.input },
        result: output,
        traceId: this.traceId(runId, parentRunId),
      });
      tc.metadata.source = 'langchain';
      bus.emit(tc);
    } catch {
      // recording must never break the app
    } finally {
      this.forget(runId);
    }
  }

  /** Emit a {@link ToolCall} marking the failure; drop the pending entry. Never re-raised. */
  override handleToolError(err: unknown, runId: string, parentRunId?: string): void {
    try {
      const pending = this.toolRuns.get(runId);
      this.toolRuns.delete(runId);
      const tc = new ToolCall({
        id: uuidHex(),
        name: pending?.name ?? 'tool',
        arguments: { input: pending?.input },
        traceId: this.traceId(runId, parentRunId),
      });
      tc.metadata.source = 'langchain';
      tc.metadata.error = errorMessage(err);
      bus.emit(tc);
    } catch {
      // recording must never break the app
    } finally {
      this.forget(runId);
    }
  }
}

// --------------------------------------------------------------------------- extraction helpers

/** A hex UUID (no dashes), mirroring the ids `instrument()` stamps. */
function uuidHex(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '');
}

/** The `.message` on a chat `Generation` carries `usage_metadata`/`response_metadata` (AIMessage). */
interface GenerationLike {
  message?: {
    usage_metadata?: UsageMetadata;
    response_metadata?: Record<string, unknown>;
  };
}

function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

/**
 * Recover usage from an `LLMResult`: prefer a generation message's `usage_metadata` (it carries
 * reasoning + cache breakdowns), falling back to `llmOutput`'s token usage.
 */
function usageFromResult(result: LLMResult): Usage | null {
  for (const gens of result.generations ?? []) {
    for (const gen of gens) {
      const meta = (gen as GenerationLike).message?.usage_metadata;
      if (meta) return usageFromMetadata(meta);
    }
  }
  const llmOutput = (result.llmOutput ?? {}) as Record<string, unknown>;
  const tokenUsage = (llmOutput.tokenUsage ?? llmOutput.token_usage ?? llmOutput.usage) as
    | Record<string, unknown>
    | undefined;
  if (tokenUsage) {
    const inp = num(tokenUsage.promptTokens ?? tokenUsage.prompt_tokens ?? tokenUsage.input_tokens);
    const out = num(
      tokenUsage.completionTokens ?? tokenUsage.completion_tokens ?? tokenUsage.output_tokens,
    );
    const cdetails = (tokenUsage.completion_tokens_details ??
      tokenUsage.completionTokensDetails ??
      {}) as Record<string, unknown>;
    const reasoning = num(cdetails.reasoning_tokens ?? cdetails.reasoningTokens);
    const pdetails = (tokenUsage.prompt_tokens_details ??
      tokenUsage.promptTokensDetails ??
      {}) as Record<string, unknown>;
    const cached = num(pdetails.cached_tokens ?? pdetails.cachedTokens);
    return new Usage({
      inputTokens: inp,
      outputTokens: out,
      cachedTokens: cached,
      reasoningTokens: reasoning,
    });
  }
  return null;
}

/**
 * Map LangChain's `usage_metadata` to {@link Usage}. LangChain already reports `input_tokens`
 * *including* the cached read (`cached ⊆ input`, the same convention cendor normalizes to), so no
 * folding is needed. Reasoning is under `output_token_details.reasoning`; cache read/creation under
 * `input_token_details`.
 */
function usageFromMetadata(meta: UsageMetadata): Usage {
  return new Usage({
    inputTokens: num(meta.input_tokens),
    outputTokens: num(meta.output_tokens),
    cachedTokens: num(meta.input_token_details?.cache_read),
    reasoningTokens: num(meta.output_token_details?.reasoning),
    cacheWrite: num(meta.input_token_details?.cache_creation),
  });
}

/** Read the model id from `llmOutput` or a generation message's `response_metadata`. */
function modelFromResult(result: LLMResult): string {
  const llmOutput = (result.llmOutput ?? {}) as Record<string, unknown>;
  const direct = llmOutput.model_name ?? llmOutput.modelName ?? llmOutput.model;
  if (direct) return String(direct);
  for (const gens of result.generations ?? []) {
    for (const gen of gens) {
      const meta = (gen as GenerationLike).message?.response_metadata ?? {};
      const m = meta.model_name ?? meta.model;
      if (m) return String(m);
    }
  }
  return '';
}

/** Price the call offline from the bundled snapshot; unknown model ⇒ `cost` stays `null`. */
function setCost(call: LLMCall, usage: Usage | null): void {
  if (usage === null) return;
  try {
    call.cost = prices.estimate(call.model, usage.inputTokens, {
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      cacheWriteTokens: usage.cacheWrite,
    });
    call.metadata.cost_estimated = true;
  } catch (err) {
    if (err instanceof prices.UnknownModelError) {
      call.cost = null;
    } else {
      throw err;
    }
  }
}

/** LangChain's serialized tool descriptor carries a `name`; default when absent. */
function serializedName(tool: Serialized): string | undefined {
  const name = (tool as { name?: unknown } | null | undefined)?.name;
  return typeof name === 'string' ? name : undefined;
}

/** The message of an error, mirroring Python's `str(exc)`. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
