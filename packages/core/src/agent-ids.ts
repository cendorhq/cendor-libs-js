/**
 * Provider-native agent identity — scopes that map an *existing* id onto the semconv attributes. TS
 * mirror of `cendor.core.agent_ids`.
 *
 * **Nothing here invents identity.** A chat-completions response carries no agent identity at all, so
 * for a plain model call the honest answer stays "there is none". But three products *do* own a real,
 * stable agent id, and Cendor was dropping all three on the floor (measured 2026-07-26, report §6.1):
 *
 * * **AWS Bedrock Agents** — `agentId` (+ `agentAliasId`) and `sessionId`
 *   → `gen_ai.agent.id` · `gen_ai.conversation.id`
 * * **OpenAI Assistants** — `assistant_id` and the thread id
 *   → `gen_ai.agent.id` · `gen_ai.conversation.id`
 * * **Microsoft Foundry Agent Service** — `agentId` / `threadId`; see `@cendor/core/foundry`
 *
 * Each is an **adapter**, exactly like `@cendor/core/foundry` and `@cendor/core/openai-agents`: the
 * framework owns the identity, the adapter forwards it, and `@cendor/core` itself still carries no
 * agent or app identity of its own (the locked core-identity principle — there is no
 * `CENDOR_AGENT_NAME`, and there never will be).
 *
 * **Attribution-only, and the limit is the point.** These scopes attribute the calls made inside
 * them. They do **not** make a server-side runtime's tokens or cost appear: when the agent loop runs
 * on the provider's side, no model call passes through `instrument()`, so there is nothing to price.
 * Anything else would be a fabricated number.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { type AmbientProvider, addAmbientProvider } from './ambient.js';

interface IdentityScope {
  agent?: string;
  agent_id?: string;
  conversation_id?: string;
}

/** The active scope's identity, bound to the current async flow — `run()`, never `enterWith`, so two
 * concurrent flows can never cross-attribute (and nothing survives a closed scope on any Node). */
const active = new AsyncLocalStorage<IdentityScope>();

const provider: AmbientProvider = () => {
  const s = active.getStore();
  if (!s) return undefined;
  const out: Record<string, unknown> = {};
  if (s.agent) out.agent = s.agent;
  if (s.agent_id) out.agent_id = s.agent_id;
  if (s.conversation_id) out.conversation_id = s.conversation_id;
  return Object.keys(out).length > 0 ? out : undefined;
};

/** Identity for {@link agentScope}. Every field optional; an absent one is **omitted**, never invented. */
export interface AgentIdentity {
  /** The agent's human-facing name → `gen_ai.agent.name`. */
  name?: string;
  /** Its stable id → `gen_ai.agent.id`. A name is a label; an id is identity. */
  agentId?: string;
  /** The thread/session id the run belongs to → `gen_ai.conversation.id`. Never synthesised. */
  conversationId?: string;
}

/**
 * Run `fn` with everything inside attributed to an agent you already have identity for.
 *
 * The generic form the product-specific scopes below are built on — use it for a framework Cendor has
 * no named adapter for. An empty scope stamps nothing.
 *
 * @example
 * ts-check: skip
 * ```ts
 * import { agentScope } from '@cendor/core/agent-ids';
 * await agentScope({ name: 'Billing', agentId: 'reg-42' }, async () => { ... });
 * ```
 */
export function agentScope<T>(identity: AgentIdentity, fn: () => T): T {
  addAmbientProvider(provider); // idempotent — dedups by identity
  return active.run(
    {
      agent: identity.name || undefined,
      agent_id: identity.agentId || undefined,
      conversation_id: identity.conversationId || undefined,
    },
    fn,
  );
}

/** Identity for {@link bedrockAgentScope}. */
export interface BedrockAgentIdentity {
  agentId?: string;
  agentAliasId?: string;
  sessionId?: string;
  name?: string;
}

/**
 * Run `fn` scoped to an **AWS Bedrock Agents** invocation: `agentId` → `gen_ai.agent.id`,
 * `sessionId` → `gen_ai.conversation.id`.
 *
 * With an alias the id becomes `"<agentId>/<agentAliasId>"`: an alias is what actually resolves to a
 * version, so two aliases of one agent are genuinely different things to attribute to — collapsing
 * them would report a number about the wrong thing. Bedrock's invocation carries no name, so pass
 * `name` if you want a label beside the id.
 *
 * @example
 * ts-check: skip
 * ```ts
 * import { bedrockAgentScope } from '@cendor/core/agent-ids';
 * await bedrockAgentScope({ agentId: 'AGENT123', agentAliasId: 'TSTALIASID', sessionId: 's-1' },
 *   async () => { ... });
 * ```
 */
export function bedrockAgentScope<T>(identity: BedrockAgentIdentity, fn: () => T): T {
  const full =
    identity.agentId && identity.agentAliasId
      ? `${identity.agentId}/${identity.agentAliasId}`
      : identity.agentId;
  return agentScope({ name: identity.name, agentId: full, conversationId: identity.sessionId }, fn);
}

/** Identity for {@link openaiAssistantScope}. */
export interface OpenAIAssistantIdentity {
  assistantId?: string;
  threadId?: string;
  name?: string;
}

/**
 * Run `fn` scoped to an **OpenAI Assistants** run: `assistant_id` → `gen_ai.agent.id`, the thread id
 * → `gen_ai.conversation.id`.
 *
 * @example
 * ts-check: skip
 * ```ts
 * import { openaiAssistantScope } from '@cendor/core/agent-ids';
 * await openaiAssistantScope({ assistantId: 'asst_abc', threadId: 'thread_xyz' }, async () => { ... });
 * ```
 */
export function openaiAssistantScope<T>(identity: OpenAIAssistantIdentity, fn: () => T): T {
  return agentScope(
    { name: identity.name, agentId: identity.assistantId, conversationId: identity.threadId },
    fn,
  );
}
