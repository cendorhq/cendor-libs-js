---
'@cendor/core': minor
'@cendor/acttrace': minor
---

**`trace()` groups your calls into one trace, and a governance row can finally name the agent it stopped.**

### `trace()` is a real span — the behaviour change to read before upgrading

`trace('id', fn)` used to stamp an ambient id onto every `LLMCall`/`ToolCall` and nothing more, so every
call inside still arrived as its **own root span**: one logical unit of work became N unrelated traces in
any backend that groups by trace. Measured against Cendor Monitor on 2026-07-26, a scope around a chat
call *and* a tool call produced **two** traces sharing one id — one run, two rows, no parent, its
governance fanned out to both, and per-run governance counts doubled.

The scope now brackets its calls with a `cendor.trace <id>` span (instrumentation scope `cendor.core`,
carrying `cendor.run.id` and `cendor.scope: 'trace'`), so **one scope is one trace**, and each child call
carries a 1-based `cendor.step`. The ambient id is stamped exactly as before, so correlation by
`cendor.trace_id` is unaffected. The scope binds through `context.with` — i.e. `AsyncLocalStorage.run()`,
never `enterWith`, verified in docker on node 20.20 / 22.23 / 24.18.

Nothing is emitted when there is nobody to emit to (no `@opentelemetry/api`, no configured provider, or
`CENDOR_TELEMETRY=off`), and **no span is opened inside a `@cendor/sdk` run** — that run already owns its
trace, so the calls attach to it rather than to a competing root. Nesting is a no-op for the inner scope.

**If your backend groups by trace id today and you want the old shape**, one switch restores it:
`CENDOR_TRACE_SPAN=off`, or `trace(id, fn, { span: false })` for a single scope.

### `trace()` is now concurrency-correct on Node without any setup

Correlation fell back to a save/restore module variable unless a host injected a store via
`installTraceContext`, so two **overlapping** scopes shared one variable: the second scope's id leaked
into the first's remaining work, and the last to finish left its id behind for everything after. Core now
installs a real `AsyncLocalStorage` for the trace id by default on Node. `installTraceContext` still
accepts your own implementation.

### Agent identity

* `gen_ai.agent.id` is emitted on a call span whenever something stamped one — **never** hashed and never
  a placeholder. A name is a label (two apps can share one, and a rename loses that agent's history); an
  id is identity.
* **New `@cendor/core/agent-ids`**: `bedrockAgentScope({ agentId, agentAliasId, sessionId }, fn)`,
  `openaiAssistantScope({ assistantId, threadId }, fn)` and the generic `agentScope(identity, fn)`,
  mapping the ids those products already own onto `gen_ai.agent.id` / `gen_ai.conversation.id`.
* `@cendor/core/foundry` also maps its `agentId` onto `gen_ai.agent.id` now (it keeps stamping `agent`, so
  a dashboard grouping on the name dimension does not lose its rows).
* All three stay **attribution-only**: mapping identity does not make a server-side runtime's tokens or
  cost appear.

### `ambientAttrs()` — so a governance record can name its actor

`applyAmbient` covers everything that *is* an event. A governance record is not: an audit entry or an
enforcement decision is built by `@cendor/acttrace` / `@cendor/tokenguard` / `@cendor/guardrails`, which
must not import the SDK, and so had no way to learn which agent was acting. Measured: **13 of 386**
governance rows named their agent. `ambientAttrs()` is a **read** of the same registry — core still
carries no identity of its own — and both core's `governance.*` spans and `@cendor/acttrace`'s
`OTelMirror` now use it, so a **budget block** (an event with no agent field at all) stops being an
anonymous row. `OTelMirror` stamps `cendor.audit.agent` / `cendor.audit.agent_id` on **every** entry, not
just a guardrail decision; the entry's own payload always wins. Nothing about the hash-chained evidence
file changes — this is the operational copy.
