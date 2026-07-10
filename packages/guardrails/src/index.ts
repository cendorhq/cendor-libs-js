/**
 * `@cendor/guardrails` — a local-first gate for LLM apps: define a check, attach it to a stage.
 * The TS port of `cendor.guardrails`.
 *
 * The **Gate** in the Cendor pipeline (`contextkit → squeeze → tokenguard → guardrails → cassette →
 * acttrace`). Deterministic checks — keyword/regex/URL/length/JSON-schema — run in microseconds for
 * $0, at four intervention points (`input | tool_call | tool_output | output`). Every trip or flag
 * emits a `GuardrailDecision` on the `@cendor/core` bus, so `@cendor/acttrace` chains it as
 * tamper-evident evidence with no import between the two.
 *
 * Imports ONLY `@cendor/core` (constitution rule 2). See docs/guardrails.md.
 */
import {
  LLMCall,
  MISS,
  Reroute,
  ToolCall,
  addInterceptor,
  bus,
  currentTraceId,
  removeInterceptor,
} from '@cendor/core';
import {
  type Context,
  type Guardrail,
  GuardrailDecision,
  GuardrailTripped,
  Verdict,
} from './decision.js';

export {
  STAGES,
  ACTIONS,
  ON_ERROR,
  Verdict,
  GuardrailDecision,
  GuardrailTripped,
  defineGuardrail,
  normalizeStages,
  validateExecutionPolicy,
} from './decision.js';
export type {
  Stage,
  Action,
  OnError,
  Context,
  Check,
  Guardrail,
  DefineGuardrailOptions,
} from './decision.js';
export * as rules from './rules.js';
export * as judge from './judge.js';
export * as adapters from './adapters.js';
export * as semantic from './semantic.js';
export * as intent from './intent.js';
export * as presets from './presets.js';
export * as embeddings from './embeddings.js';
export * as redteam from './redteam.js';
export { loadPolicy, POLICY_RULE_NAMES, policySchema } from './policy.js';
export type { LoadedPolicy, LoadPolicyOptions } from './policy.js';
export type { Embed } from './semantic.js';
export { loadCorpus, runRedteam, runRedteamAsync, RedTeamReport } from './redteam.js';
export type { AttackCase, LoadCorpusOptions } from './redteam.js';

/** The result of evaluating a stage: the (possibly redacted) payload plus the recorded decisions. */
export interface EvalResult {
  payload: unknown;
  decisions: GuardrailDecision[];
}

function applicable(guardrails: readonly Guardrail[], stage: string): Guardrail[] {
  return guardrails.filter((g) => g.stages.includes(stage));
}

function emit(g: Guardrail, stage: string, verdict: Verdict, ctx: Context): GuardrailDecision {
  const decision = new GuardrailDecision({
    guardrail: g.name,
    stage,
    action: verdict.action,
    reason: verdict.reason,
    agent: ctx.agent ?? '',
    tool: ctx.tool ?? '',
    traceId: ctx.traceId || currentTraceId(),
    ts: new Date(),
    // Three metadata layers, lowest precedence first: the guardrail's static metadata (e.g.
    // loadPolicy's policy_hash/version) is the base; the verdict's per-result annotations (the
    // reserved severity/detected/… keys — see bus-events.md) layer over it; the caller's per-call
    // Context.metadata is on top and still wins any key clash.
    metadata: { ...(g.metadata ?? {}), ...(verdict.metadata ?? {}), ...(ctx.metadata ?? {}) },
  });
  bus.emit(decision); // acttrace (if attached) chains this as a guardrail_decision entry
  return decision;
}

function handle(
  verdict: Verdict | null,
  g: Guardrail,
  stage: string,
  payload: unknown,
  ctx: Context,
  decisions: GuardrailDecision[],
): unknown {
  if (verdict === null) return payload;
  decisions.push(emit(g, stage, verdict, ctx));
  if (verdict.action === 'block') throw new GuardrailTripped(decisions);
  if (verdict.action === 'redact' && verdict.replacement != null) return verdict.replacement;
  return payload;
}

function isPromise(x: unknown): x is Promise<unknown> {
  return x != null && typeof (x as { then?: unknown }).then === 'function';
}

const ERROR_REASON_MAX = 200;

/** A timeout marker error — a check that outran its `timeout` on the async path. */
class GuardrailTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Map a check error/timeout to a verdict per `g.onError`. Either way this becomes a
 * `GuardrailDecision`, so the audit chain records that the check could not run — never a silently
 * swallowed exception. The reason carries the error *name* + a truncated message, never the payload
 * the check saw.
 */
function onErrorVerdict(g: Guardrail, exc: unknown): Verdict {
  const name =
    (exc as { name?: string })?.name ??
    (exc as { constructor?: { name?: string } })?.constructor?.name ??
    'Error';
  const message = (exc as { message?: string })?.message ?? String(exc);
  let detail = `${name}: ${message}`;
  if (detail.length > ERROR_REASON_MAX) detail = `${detail.slice(0, ERROR_REASON_MAX)}…`;
  if ((g.onError ?? 'fail_closed') === 'fail_open') {
    return new Verdict('flag', `check errored (fail-open): ${detail}`);
  }
  return new Verdict('block', `check errored (fail-closed): ${detail}`);
}

/**
 * Run one guardrail's check on the async path, bounding an `async` check to `g.timeout` via
 * `Promise.race`. A *sync* check runs inline (a sync `timeout` cannot be enforced without threads —
 * see {@link Guardrail}). Throws propagate to the caller's `onError` mapping.
 */
async function runCheckAsync(
  g: Guardrail,
  payload: unknown,
  ctx: Context,
): Promise<Verdict | null> {
  const result = g.check(payload, ctx);
  if (isPromise(result) && g.timeout !== undefined) {
    const seconds = g.timeout;
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      handle = setTimeout(
        () =>
          reject(
            new GuardrailTimeoutError(
              `guardrail ${JSON.stringify(g.name)} check exceeded ${seconds}s`,
            ),
          ),
        seconds * 1000,
      );
    });
    try {
      return (await Promise.race([result, timeout])) as Verdict | null;
    } finally {
      if (handle !== undefined) clearTimeout(handle);
    }
  }
  return (await result) as Verdict | null;
}

/**
 * Run the `stage` guardrails over `payload` **synchronously**. Returns `{ payload, decisions }`
 * with any redactions applied in order; throws `GuardrailTripped` on the first block. An `async`
 * check throws here — use {@link evaluateAsync}. A *throwing* sync check honours its `onError`
 * policy; `timeout` applies to the async path only (no sync threads in JS).
 */
export function evaluate(
  guardrails: readonly Guardrail[],
  stage: string,
  payload: unknown,
  ctx?: Context,
): EvalResult {
  const context: Context = ctx ?? { stage };
  const decisions: GuardrailDecision[] = [];
  let current = payload;
  for (const g of applicable(guardrails, stage)) {
    let result: Verdict | null | Promise<Verdict | null>;
    try {
      result = g.check(current, context);
    } catch (err) {
      if (err instanceof GuardrailTripped) throw err;
      // a THROWING sync check → its on_error policy (recorded), never a swallowed exception
      current = handle(onErrorVerdict(g, err), g, stage, current, context, decisions);
      continue;
    }
    // An async check on the sync path is a misuse: this TypeError is raised OUTSIDE the on_error
    // try above so it always propagates (parity with Python `_invoke_sync`), never mapped to a block.
    if (isPromise(result)) {
      void result.catch(() => {}); // swallow the rejection of the discarded promise
      throw new TypeError(`guardrail ${JSON.stringify(g.name)} is async; use evaluateAsync`);
    }
    current = handle(result, g, stage, current, context, decisions);
  }
  return { payload: current, decisions };
}

/**
 * Async counterpart of {@link evaluate}: awaits `async` checks (bounded by each guardrail's
 * `timeout`), calls sync ones directly, and applies each guardrail's `onError` policy on a
 * throw/timeout.
 */
export async function evaluateAsync(
  guardrails: readonly Guardrail[],
  stage: string,
  payload: unknown,
  ctx?: Context,
): Promise<EvalResult> {
  const context: Context = ctx ?? { stage };
  const decisions: GuardrailDecision[] = [];
  let current = payload;
  for (const g of applicable(guardrails, stage)) {
    let verdict: Verdict | null;
    try {
      verdict = await runCheckAsync(g, current, context);
    } catch (err) {
      if (err instanceof GuardrailTripped) throw err; // a block from a nested handle propagates
      verdict = onErrorVerdict(g, err); // throw / timeout → on_error policy (recorded)
    }
    // handle() throws GuardrailTripped on a block — OUTSIDE the try, so a block is never caught as
    // an on_error (only the CHECK's own throws map to on_error).
    current = handle(verdict, g, stage, current, context, decisions);
  }
  return { payload: current, decisions };
}

/** Gate `payload` and return the recorded decisions (throws `GuardrailTripped` on a block). */
export function apply(
  guardrails: readonly Guardrail[],
  stage: string,
  payload: unknown,
  ctx?: Context,
): GuardrailDecision[] {
  return evaluate(guardrails, stage, payload, ctx).decisions;
}

/** Async counterpart of {@link apply}. */
export async function applyAsync(
  guardrails: readonly Guardrail[],
  stage: string,
  payload: unknown,
  ctx?: Context,
): Promise<GuardrailDecision[]> {
  return (await evaluateAsync(guardrails, stage, payload, ctx)).decisions;
}

// --------------------------------------------------------------------------- standalone wiring

let installedInterceptor: ((event: unknown) => unknown) | null = null;
let installedSubscriber: ((event: unknown) => void) | null = null;

/**
 * The shared interceptor body used by {@link install} and {@link scoped} — gate an `LLMCall` at the
 * `input` stage (redact reroutes, block raises, pass declines) and a `ToolCall` at the `tool_call`
 * stage (block raises; redact/flag recorded but the call proceeds).
 */
function gateInterceptor(gl: readonly Guardrail[], event: unknown): unknown {
  if (event instanceof LLMCall) {
    const ctx: Context = { stage: 'input', traceId: event.traceId };
    const { payload, decisions } = evaluate(gl, 'input', event.messages, ctx);
    if (decisions.some((d) => d.action === 'redact')) return new Reroute({ messages: payload });
    return MISS;
  }
  if (event instanceof ToolCall) {
    const ctx: Context = {
      stage: 'tool_call',
      tool: event.name,
      toolArgs: event.arguments,
      traceId: event.traceId,
    };
    evaluate(gl, 'tool_call', event.arguments, ctx); // block throws; else record + proceed
    return MISS;
  }
  return MISS;
}

/**
 * The shared post-flight output subscriber body: gate the completed `LLMCall`'s response text at the
 * `output` stage (block raises after the call ran).
 */
function gateOutput(gl: readonly Guardrail[], event: unknown): void {
  if (!(event instanceof LLMCall)) return;
  const text = responseText(event);
  if (text === null) return;
  const ctx: Context = { stage: 'output', traceId: event.traceId };
  evaluate(gl, 'output', text, ctx); // block throws post-flight
}

/**
 * Gate every instrumented call by registering ONE `@cendor/core` interceptor (+ an output
 * subscriber). Framework-independent. Input: a block raises (nothing spends), a redact reroutes the
 * cleaned messages, a pass declines. tool_call: a block raises; else record + proceed (tools have
 * no message-rewrite seam). Output: a bus subscriber raises **post-flight** on a block (same
 * overshoot semantics as tokenguard's `onExceed:"raise"`). Runs sync checks only. Call
 * {@link uninstall} to remove. `install()` is **process-global** — for a concurrent server that
 * varies guardrails per request, use {@link scoped} instead.
 */
export function install(guardrails: readonly Guardrail[]): void {
  uninstall();
  const gl = [...guardrails];
  const interceptor = (event: unknown): unknown => gateInterceptor(gl, event);
  const subscriber = (event: unknown): void => gateOutput(gl, event);
  addInterceptor(interceptor);
  bus.subscribe(subscriber);
  installedInterceptor = interceptor;
  installedSubscriber = subscriber;
}

/** Remove the interceptor + output subscriber registered by {@link install} (idempotent). */
export function uninstall(): void {
  if (installedInterceptor) removeInterceptor(installedInterceptor);
  if (installedSubscriber) bus.unsubscribe(installedSubscriber);
  installedInterceptor = null;
  installedSubscriber = null;
}

// --------------------------------------------------------------------------- scoped (per-request)

/** The minimal async-context store `scoped()` needs (Node's `AsyncLocalStorage` satisfies it). */
interface ScopeStore {
  getStore(): readonly Guardrail[] | undefined;
  run<T>(gl: readonly Guardrail[], fn: () => T): T;
}

//: The guardrails active in *this* execution context, or `undefined` outside any `scoped` block.
//: With a real `AsyncLocalStorage` installed (Node), overlapping async tasks each see their own
//: value; the ambient fallback is single-context (documented — not concurrency-safe).
let scopeStore: ScopeStore | undefined;
let ambientScope: readonly Guardrail[] | undefined;
let alsRequested = false;

/**
 * Lazily install a real `AsyncLocalStorage`-backed scope store (Node only), so overlapping async
 * requests stay isolated. Best-effort + idempotent: on edge/browser (`node:async_hooks` missing) it
 * quietly keeps the ambient fallback, so `@cendor/guardrails` stays all-runtime (no `node:*` at the
 * module top). Mirrors the spirit of `@cendor/core`'s `installTraceContext`.
 */
async function ensureAls(): Promise<void> {
  if (alsRequested) return;
  alsRequested = true;
  try {
    const { AsyncLocalStorage } = await import('node:async_hooks');
    if (!scopeStore) scopeStore = new AsyncLocalStorage<readonly Guardrail[]>();
  } catch {
    // node:async_hooks unavailable (edge/browser) — keep the ambient fallback (single-context)
  }
}
void ensureAls(); // best-effort auto-install so real Node usage gets concurrency-correct isolation

function activeScope(): readonly Guardrail[] | undefined {
  return scopeStore ? scopeStore.getStore() : ambientScope;
}

function scopedInterceptor(event: unknown): unknown {
  const gl = activeScope();
  if (!gl || gl.length === 0) return MISS; // no active scope in this context — decline
  return gateInterceptor(gl, event);
}

function scopedSubscriber(event: unknown): void {
  const gl = activeScope();
  if (!gl || gl.length === 0) return;
  gateOutput(gl, event);
}

/**
 * Register the context-gated interceptor + subscriber (idempotent — `addInterceptor` / `bus.subscribe`
 * de-dupe). They stay registered and are no-ops outside a {@link scoped} block, so leaving them
 * installed costs a store lookup per call and needs no teardown.
 */
function ensureScopedSeam(): void {
  addInterceptor(scopedInterceptor);
  bus.subscribe(scopedSubscriber);
}

/**
 * Gate every instrumented call for the duration of `fn` — like {@link install}, but **scoped to the
 * current execution context** rather than process-global. Runs `fn` with `guardrails` active and
 * returns its result (sync or a `Promise`); the previous scope is restored on exit.
 *
 * With a real `AsyncLocalStorage` (auto-installed on Node), a concurrent server (async tasks) can
 * vary guardrails per request without one request's set leaking into another. On edge/browser the
 * fallback is a save/restore module variable — correct for sequential/nested use, **not**
 * concurrency-safe. Nest freely — an inner `scoped` replaces the set for its block. Runs sync checks
 * only (the seam is sync).
 *
 * ```ts
 * await scoped([rules.keywordDeny(['secret'], { action: 'block' })], async () => {
 *   await client.chat.completions.create(...); // gated here
 * });
 * ```
 */
export function scoped<T>(
  guardrails: readonly Guardrail[],
  fn: () => T | Promise<T>,
): T | Promise<T> {
  ensureScopedSeam();
  void ensureAls();
  const gl = [...guardrails];
  if (scopeStore) return scopeStore.run(gl, fn);
  // Ambient fallback (single-context): save/restore, honouring sync or async `fn` like core's trace.
  const previous = ambientScope;
  ambientScope = gl;
  let result: T | Promise<T>;
  try {
    result = fn();
  } catch (err) {
    ambientScope = previous;
    throw err;
  }
  if (result instanceof Promise) {
    return result.finally(() => {
      ambientScope = previous;
    });
  }
  ambientScope = previous;
  return result;
}

function get(obj: unknown, name: string): unknown {
  return obj != null && typeof obj === 'object'
    ? (obj as Record<string, unknown>)[name]
    : undefined;
}

/** Best-effort assistant text off a completed LLMCall for the standalone output stage. For a
 * **streamed** call `@cendor/core` stores the raw delta chunks as an array here, so the completed
 * text is reconstructed by joining the per-chunk deltas — otherwise the output stage silently
 * no-ops on streamed responses (the banned text is delivered). */
export function responseText(call: LLMCall): string | null {
  const response = call.metadata?.response;
  if (response == null) return null;
  try {
    if (Array.isArray(response)) {
      // a streamed call: core stored the raw delta chunks
      const text = response.map(chunkText).join('');
      return text || null;
    }
    return extractText(response);
  } catch {
    return null; // extraction must never break the passthrough
  }
}

/** Text carried by one streamed delta chunk, across providers. A chunk matches exactly one provider
 * shape, so trying each and joining reconstructs the full assistant text. Mirrors `@cendor/core`'s
 * internal per-provider stream-delta join (kept local — guardrails imports only core's public
 * surface). */
function chunkText(chunk: unknown): string {
  // OpenAI / HuggingFace Chat Completions: choices[].delta.content
  const choices = get(chunk, 'choices');
  if (Array.isArray(choices) && choices.length > 0) {
    const parts = choices
      .map((c) => get(get(c, 'delta'), 'content'))
      .filter((t): t is string => typeof t === 'string');
    if (parts.length > 0) return parts.join('');
  }
  // OpenAI Responses API: response.output_text.delta events carry incremental text
  if (get(chunk, 'type') === 'response.output_text.delta') {
    const delta = get(chunk, 'delta');
    return typeof delta === 'string' ? delta : '';
  }
  // Anthropic: content_block_delta events with delta.text
  if (get(chunk, 'type') === 'content_block_delta') {
    const t = get(get(chunk, 'delta'), 'text');
    return typeof t === 'string' ? t : '';
  }
  // Ollama: message.content
  const message = get(chunk, 'message');
  if (message != null) {
    const t = get(message, 'content');
    if (typeof t === 'string') return t;
  }
  // Gemini: chunk.text
  const text = get(chunk, 'text');
  if (typeof text === 'string') return text;
  // Bedrock Converse: contentBlockDelta.delta.text
  const bt = get(get(get(chunk, 'contentBlockDelta'), 'delta'), 'text');
  return typeof bt === 'string' ? bt : '';
}

function extractText(response: unknown): string | null {
  const outputText = get(response, 'output_text'); // OpenAI Responses convenience field
  if (typeof outputText === 'string' && outputText) return outputText;
  const choices = get(response, 'choices'); // OpenAI/HF Chat Completions
  if (Array.isArray(choices) && choices.length > 0) {
    const content = get(get(choices[0], 'message'), 'content');
    if (typeof content === 'string') return content;
  }
  const content = get(response, 'content'); // Anthropic content blocks
  if (Array.isArray(content)) {
    const parts = content.map((b) => get(b, 'text')).filter((t) => t != null);
    if (parts.length > 0) return parts.map(String).join('');
  }
  const message = get(response, 'message'); // Ollama
  if (message != null) {
    const text = get(message, 'content');
    if (typeof text === 'string') return text;
  }
  const text = get(response, 'text'); // Gemini
  if (typeof text === 'string' && text) return text;
  const outMessage = get(get(response, 'output'), 'message'); // Bedrock Converse
  const outContent = get(outMessage, 'content');
  if (Array.isArray(outContent)) {
    const parts = outContent.map((b) => get(b, 'text')).filter((t) => t != null);
    if (parts.length > 0) return parts.map(String).join('');
  }
  return null;
}
