---
"@cendor/core": minor
---

Add a LangChain.js / LangGraph callback handler at the `@cendor/core/langchain` subpath.

`CendorCallbackHandler` mirrors the Python handler: attach it via `callbacks: [...]` and it records
usage (including reasoning + cache breakdowns from LangChain's `usage_metadata`), prices each call
offline, emits normalized `LLMCall` / `ToolCall` events on the bus, and correlates multi-node /
multi-agent runs by walking the callback run tree to a shared root-run `traceId`. It is
**recording-only** — post-call, so it never enforces (use the provider SDK with `instrument()` for
pre-flight budget/redaction).

`@langchain/core` is an **optional** peer dependency, lazy-loaded; importing the subpath without it
throws a clear install error.
