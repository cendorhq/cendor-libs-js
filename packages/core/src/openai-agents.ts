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
 * **Honest limit.** The name is scoped per active agent turn (set at agent start / handoff, cleared
 * at agent end); handoffs — the SDK's primary multi-agent model — re-stamp correctly. Uses
 * `AsyncLocalStorage.enterWith` so a fire-and-return event listener can scope the following async
 * flow (a callback wrapper is impossible from a listener). Requires Node's async_hooks (Node ≥ 18).
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
import { AsyncLocalStorage } from 'node:async_hooks';
import { addAmbientProvider } from './ambient.js';
import type { AmbientProvider } from './ambient.js';

/** The minimal event-emitter shape the OpenAI Agents SDK's `Runner` and `Agent` both satisfy — so
 * this adapter attaches without a hard dependency on `@openai/agents`. */
export interface AgentEventTarget {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** The agent currently executing a turn, scoped to the run's async flow. `enterWith` (not `run`) is
 * used because the SDK's listeners fire and return — they can't wrap the following code in a
 * callback. Set at agent start / handoff, cleared (undefined) at agent end. */
const activeAgent = new AsyncLocalStorage<string>();

/** Ambient provider: stamp `agent` from the active-turn store. Undefined ⇒ nothing (core's
 * never-overwrite seam keeps any explicit value). */
const provider: AmbientProvider = () => {
  const name = activeAgent.getStore();
  return name ? { agent: name } : undefined;
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
    if (name) activeAgent.enterWith(name);
  };
  const onEnd = (): void => {
    activeAgent.enterWith(undefined as unknown as string);
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

/** Test helper: the active-agent store getter (so tests can assert scope behavior). Internal. */
export function _currentAgent(): string | undefined {
  return activeAgent.getStore();
}
