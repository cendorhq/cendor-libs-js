---
"@cendor/core": minor
---

Framework agent-name adapters — two optional integrations that source a third-party framework's agent identity onto the bus, mirroring the shipped `@cendor/core/langchain` handler. Core carries no identity of its own; the framework owns the name, these adapters carry it. Additive — importing an adapter registers no ambient provider (the zero-provider fast path holds until you attach).

- **`@cendor/core/openai-agents`** (`observeOpenAIAgents(runnerOrAgent)`) — attach to the OpenAI Agents SDK's `Runner`/`Agent`; stamps the framework's agent name per turn (set at `agent_start`/`agent_handoff`, cleared at `agent_end`) via `AsyncLocalStorage.enterWith`. The agent's model calls ride the standard OpenAI client, so `instrument()` still captures tokens/cost/streaming — this supplies only the name (GLR-11c). Returns a disposer; optional peer `@openai/agents`.
- **`@cendor/core/foundry`** (`observeFoundryAgents(client)` + `foundryAgentScope(agentId, threadId, fn)`) — a correlation adapter for Azure AI Foundry Agents. Wraps `client.runs.{create,createAndPoll,createThreadAndRun}` to stamp `agent` + `conversation_id` for the run's duration. **Attribution only** — the model runs server-side, so no per-step token/cost (documented honest limit). Duck-typed on `.runs` (no `@azure/ai-agents` import needed to import the adapter); optional peer `@azure/ai-agents`.
