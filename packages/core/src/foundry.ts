/**
 * Optional Azure AI Foundry Agents correlation adapter — sourcing the agent + conversation id.
 *
 * Azure AI Foundry Agents runs a model **server-side**: your app calls
 * `client.runs.create(threadId, agentId, …)` (or `createAndPoll` / `createThreadAndRun`) and the run
 * executes on Azure. The wire calls `instrument()` wraps (chat/responses/embeddings/converse) never
 * see that run, so there is **no per-step token/cost to capture here** — this is a *correlation*
 * adapter, not a usage capture (GLR-11b1). It observes thread-run creation and, for the duration of
 * the call, sets a scoped ambient stamp so bus events raised in that async flow carry
 * `metadata.agent = <agent id>` and `metadata.conversation_id = <thread id>`.
 *
 * **Honest limit (attribution only).** Because the model runs server-side, a pure-Foundry flow
 * raises no instrumented model events — so it records agent/conversation *attribution* but **no
 * tokens or cost**. It is exact for correlating any *directly instrumented* calls you make inside a
 * run scope, and it is the standards-home for the agent/conversation identity a run carries.
 *
 * **No import dependency.** This adapter **wraps a client you pass in** (duck-typed on `.runs`) — so
 * importing `@cendor/core/foundry` needs no `@azure/ai-agents`. The optional peer just gives you a
 * client to wrap. Requires Node's async_hooks (Node ≥ 18).
 *
 * @example
 * ts-check: skip
 * ```ts
 * import { AgentsClient } from '@azure/ai-agents';
 * import { observeFoundryAgents } from '@cendor/core/foundry';
 *
 * const client = new AgentsClient(endpoint, credential);
 * observeFoundryAgents(client); // wraps runs.create / createAndPoll / createThreadAndRun
 * const run = await client.runs.createAndPoll(thread.id, agent.id); // scope carries the ids
 * ```
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { addAmbientProvider } from './ambient.js';
import type { AmbientProvider } from './ambient.js';

interface FoundryScope {
  agent?: string;
  conversation_id?: string;
}

/** The active Foundry run's ids, scoped to the current async flow. */
const active = new AsyncLocalStorage<FoundryScope>();

/** Ambient provider: stamp `agent` + `conversation_id` from the active run scope. Non-empty keys
 * only; core's never-overwrite seam keeps any explicit value. */
const provider: AmbientProvider = () => {
  const s = active.getStore();
  if (!s) return undefined;
  const out: Record<string, unknown> = {};
  if (s.agent) out.agent = s.agent;
  if (s.conversation_id) out.conversation_id = s.conversation_id;
  return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * Run `fn` scoped to a Foundry agent + conversation: registers the ambient provider (idempotent) and
 * stamps `agent` / `conversation_id` for the duration of `fn` (including its awaits). Both ids are
 * optional. Attribution-only (no server-side token/cost).
 *
 * @example
 * ts-check: skip
 * ```ts
 * import { foundryAgentScope } from '@cendor/core/foundry';
 * await foundryAgentScope('asst_123', 'thread_abc', async () => {
 *   // any instrumented call here is attributed to that agent + conversation
 * });
 * ```
 */
export function foundryAgentScope<T>(
  agentId: string | undefined,
  threadId: string | undefined,
  fn: () => T,
): T {
  addAmbientProvider(provider); // idempotent — dedups by identity
  return active.run({ agent: agentId || undefined, conversation_id: threadId || undefined }, fn);
}

/** The `.runs` operations group a Foundry `AgentsClient` exposes — the methods we wrap. */
interface FoundryRuns {
  [method: string]: unknown;
}
interface FoundryClient {
  runs?: FoundryRuns;
}

// method -> how to read (threadId, agentId) from its positional args:
//   create(threadId, assistantId, options) / createAndPoll(threadId, assistantId, options)
//   createThreadAndRun(assistantId, options)  — the thread is created server-side (unknown here)
const RUN_METHODS: Record<string, (args: unknown[]) => FoundryScope> = {
  create: (a) => ({ conversation_id: str(a[0]), agent: str(a[1]) }),
  createAndPoll: (a) => ({ conversation_id: str(a[0]), agent: str(a[1]) }),
  createThreadAndRun: (a) => ({ agent: str(a[0]) }),
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * Wrap a Foundry `AgentsClient`'s run-creation methods so each call scopes its execution to the
 * agent + conversation ids (via {@link foundryAgentScope}). Idempotent per method. Returns the client
 * for chaining. Throws if the object has no `.runs`. Attribution-only — the model runs server-side,
 * so no token/cost is captured here.
 */
export function observeFoundryAgents<C extends FoundryClient>(client: C): C {
  const runs = client.runs;
  if (!runs) {
    throw new TypeError(
      'observeFoundryAgents expects an Azure AI Foundry AgentsClient (with a `.runs` operations ' +
        'group). Use foundryAgentScope(agentId, threadId, fn) to scope a block manually instead.',
    );
  }
  for (const [method, extract] of Object.entries(RUN_METHODS)) {
    wrapRunMethod(runs, method, extract);
  }
  return client;
}

function wrapRunMethod(
  runs: FoundryRuns,
  method: string,
  extract: (args: unknown[]) => FoundryScope,
): void {
  const orig = runs[method];
  if (typeof orig !== 'function') return;
  const fn = orig as (...args: unknown[]) => unknown;
  if ((fn as { __cendorFoundryWrapped?: boolean }).__cendorFoundryWrapped) return;

  const wrapper = (...args: unknown[]): unknown => {
    const scope = extract(args);
    return foundryAgentScope(scope.agent, scope.conversation_id, () => fn.apply(runs, args));
  };
  (wrapper as { __cendorFoundryWrapped?: boolean }).__cendorFoundryWrapped = true;
  runs[method] = wrapper;
}

/** Test helper: the active scope (so tests can assert behavior). Internal. */
export function _currentFoundryScope(): FoundryScope | undefined {
  return active.getStore();
}
