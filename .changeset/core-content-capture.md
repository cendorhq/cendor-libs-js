---
"@cendor/core": minor
---

Opt-in content capture, a libs-only span emitter, and TTFT (Monitor v3 emission wave).

- **Opt-in content capture (OFF by default)** — `otel.captureContent({ mask, maxBytes })` and the standard `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` env var export prompts/responses/thinking/tool values onto the semconv content span attributes (`gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.system_instructions`). A `mask` scrubs before export (fail-closed if it throws); `maxBytes` caps each attribute with a truncation marker. Content never enters the acttrace evidence chain (rule 6). Helpers `otel.contentAttrs(...)` / `otel.toolContentAttrs(...)`.
- **`otel.responseMessages(call)`** — best-effort per-provider parse of assistant output into text + thinking parts (the content provider `parse()` drops).
- **`otel.useSpanEmitter()`** — an opt-in bus→span subscriber emitting a `chat`/`execute_tool` semconv span per event, so a libs-only app lights up a trace-based monitor. Defers to an active SDK `liveSpans` (no double spans) via `otel.enterLiveSpans()`/`exitLiveSpans()`.
- **TTFT** — streamed calls stamp `metadata.ttft_ms`, surfaced as `cendor.ttft_ms` on emitted chat spans.
