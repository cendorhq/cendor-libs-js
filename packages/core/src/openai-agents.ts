/**
 * Optional OpenAI Agents SDK (`@openai/agents`) integration — sourcing the framework's agent name.
 *
 * The OpenAI Agents SDK runs its own agent loop and emits lifecycle events (`agent_start`,
 * `agent_handoff`, `agent_end`) from its `Runner` (and each `Agent`). {@link observeOpenAIAgents}
 * attaches listeners to a `Runner` or `Agent` you pass in: for the duration of each agent turn it
 * stamps the **framework's** agent name onto a scoped ambient provider, so every bus event raised in
 * that turn carries `metadata.agent`. The agent's model calls ride the standard OpenAI client — which
 * `instrument()` already wraps — so **tokens, cost, and streaming come for free**; this adapter
 * supplies *only* the name (GLR-11c). It mirrors {@link CendorCallbackHandler} from
 * `@cendor/core/langchain` (GLR-11a): the framework owns agent identity; `@cendor/core` carries it
 * onto the bus.
 *
 * **Never-overwrite.** The name merges through core's ambient seam, which never overwrites a key
 * already present — so an explicit stamp (an SDK scope, a user `addAmbientProvider`) always wins.
 *
 * **Zero cost when unattached.** Importing this subpath registers nothing; the single ambient
 * provider is registered the first time you call {@link observeOpenAIAgents}. If you never attach,
 * core's zero-provider fast path is untouched.
 *
 * **Honest limit — process-wide, single-flight.** The SDK runs each model call in an async context
 * **isolated** from the lifecycle listeners (verified: neither `AsyncLocalStorage.enterWith` nor a
 * contextvar set in a listener reaches the call), so per-run scoping is impossible here. The active
 * agent is instead tracked in a **process-wide holder** the listeners update (set at agent start /
 * handoff, cleared at end) and the ambient provider reads live at each call — **correct for sequential
 * runs and handoffs (the common case), but concurrent `runner.run()` in the same process may
 * cross-attribute** agent names during overlap. Run concurrent multi-agent workloads in separate
 * processes. (The LangChain handler gets a `runId` on every callback, so it has no such limit.)
 *
 * @example
 * ts-check: skip
 * ```ts
 * import { Agent, Runner } from '@openai/agents';
 * import { instrument } from '@cendor/core';
 * import { observeOpenAIAgents } from '@cendor/core/openai-agents';
 * import OpenAI from 'openai';
 *
 * instrument(new OpenAI()); // tokens/cost/streaming — the agent's calls ride this client
 * const runner = new Runner();
 * observeOpenAIAgents(runner); // events now carry metadata.agent
 * await runner.run(new Agent({ name: 'Billing' }), 'refund my order');
 * ```
 */
import { addAmbientProvider } from './ambient.js';
import type { AmbientProvider } from './ambient.js';

/** The minimal event-emitter shape the OpenAI Agents SDK's `Runner` and `Agent` both satisfy — so
 * this adapter attaches without a hard dependency on `@openai/agents`. */
export interface AgentEventTarget {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** The agent currently executing a turn — a **process-wide holder** (not context-scoped). The SDK
 * runs each model call in an async context isolated from the listeners, so `AsyncLocalStorage` set in
 * a listener never reaches the call; a plain holder read live at construction does. Set at agent start
 * / handoff, cleared at agent end. Correct for sequential runs + handoffs; concurrent same-process
 * `runner.run()` may cross-attribute (documented limit — one runner per process). */
const active = { agent: '' };

/** Ambient provider: stamp `agent` from the active-turn holder. Empty ⇒ nothing (core's
 * never-overwrite seam keeps any explicit value). */
const provider: AmbientProvider = () => {
  return active.agent ? { agent: active.agent } : undefined;
};

/** The name of the last argument that looks like an Agent (an object with a string `name`). Handles
 * both the `Runner` event payloads (`agent_start(ctx, agent)`, `agent_handoff(ctx, from, to)`) and
 * the `Agent` payloads (`agent_start(ctx, agent)`, `agent_handoff(ctx, next)`) — the target agent is
 * always the last named arg. */
function lastAgentName(args: unknown[]): string | undefined {
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i] as { name?: unknown } | null | undefined;
    if (a && typeof a.name === 'string' && a.name) return a.name;
  }
  return undefined;
}

/**
 * Attach cendor's agent-name stamping to an OpenAI Agents SDK `Runner` or `Agent`. Registers the
 * single ambient provider (idempotent) and wires the lifecycle listeners. Returns a disposer that
 * removes the listeners (the ambient provider stays — it reads an empty store when no run is active).
 *
 * @example
 * ts-check: skip
 * ```ts
 * import { observeOpenAIAgents } from '@cendor/core/openai-agents';
 * const dispose = observeOpenAIAgents(runner);
 * // …later: dispose();
 * ```
 */
export function observeOpenAIAgents(target: AgentEventTarget): () => void {
  addAmbientProvider(provider); // idempotent — dedups by identity; nothing registered on import

  const onStartOrHandoff = (...args: unknown[]): void => {
    const name = lastAgentName(args);
    if (name) active.agent = name;
  };
  const onEnd = (): void => {
    active.agent = '';
  };

  target.on('agent_start', onStartOrHandoff);
  target.on('agent_handoff', onStartOrHandoff);
  target.on('agent_end', onEnd);

  return () => {
    target.off?.('agent_start', onStartOrHandoff);
    target.off?.('agent_handoff', onStartOrHandoff);
    target.off?.('agent_end', onEnd);
  };
}

/** Test helper: the active-agent holder value (so tests can assert scope behavior). Internal. */
export function _currentAgent(): string | undefined {
  return active.agent || undefined;
}
