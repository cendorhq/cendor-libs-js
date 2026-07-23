---
"@cendor/core": minor
---

Add a per-chunk **stream-observer seam** (`addStreamObserver`/`removeStreamObserver`): register
`fn(call, deltaText, deltaThinking)` on every instrumented stream; **throwing aborts the stream**
(closes the underlying provider stream, finalizes the `LLMCall` once with the partial estimated
usage, re-throws) — interceptor discipline, with a zero-observer fast path (one length check per
chunk). This is the generic seam `@cendor/tokenguard`'s mid-stream budget breaker
(`budget({ onExceed: 'break' })`) rides; core learns no budget vocabulary.

Streamed usage estimation now also counts **visible** thinking (Anthropic `thinking_delta`, Ollama
`message.thinking`, OpenAI-compat `reasoning_content`, Bedrock `reasoningContent`) into output +
reasoning — narrowing the documented limit from "can't see thinking" to "can't see *hidden*
thinking". `closeUnderlying` now also aborts the SDK stream's fetch controller when present.
