---
"@cendor/core": minor
---

Initial release of `@cendor/core` — the TypeScript port of `cendor.core`. Cross-language vocabulary
(`Money`, `Usage`, `LLMCall`, `ToolCall`), event bus, decimal-safe prices (`prices/1`), token
counting via `js-tiktoken`, and `instrument()` for the OpenAI (Chat Completions + Responses) and
Anthropic JS SDKs, including streaming, interceptors (record/replay), and `Reroute`. Verified against
golden conformance vectors generated from the Python reference implementation.
