# @cendor/core

## 0.3.0

### Minor Changes

- 9b7817a: instrument(): detect four more providers — HuggingFace (`chatCompletion`, checked first), Ollama
  (callable `chat`), google-genai (`models.generateContent`, sync + async, plus the legacy
  `generateContent` with a model default), and Bedrock (`converse`). Per-provider usage + streaming
  extraction added. (Bedrock note: aws-sdk v3 uses `client.send(new ConverseCommand(...))` which can't
  be duck-typed, so auto-detection matches only a boto-shaped `converse()` method — see the code
  comment; first-class aws-sdk-v3 support rides the SDK provider.)

  New `otel` module: `span(model, opts, fn)` opens an OpenTelemetry GenAI span (a no-op that still runs
  `fn(null)` when `@opentelemetry/api` — a new optional peer dep — is absent) and `ingest(attrs)` emits
  a priced `LLMCall` on the bus from `gen_ai.*` attributes (no OTel dependency).

### Patch Changes

- 09d44d2: instrument(): the streaming proxy now forwards the full SDK stream surface. The wrapped value is a
  `Proxy` that keeps usage-capturing iteration while forwarding every other member (`.tee()`,
  `.controller`, `.response`, `.finalMessage()`, `.close()`, `Symbol.asyncDispose`, …) to the
  underlying provider stream, and finalizes the `LLMCall` exactly once — on iterate-to-exhaustion or
  early close/dispose.

## 0.2.0

### Minor Changes

- 911383f: Initial release of `@cendor/core` — the TypeScript port of `cendor.core`. Cross-language vocabulary
  (`Money`, `Usage`, `LLMCall`, `ToolCall`), event bus, decimal-safe prices (`prices/1`), token
  counting via `js-tiktoken`, and `instrument()` for the OpenAI (Chat Completions + Responses) and
  Anthropic JS SDKs, including streaming, interceptors (record/replay), and `Reroute`. Verified against
  golden conformance vectors generated from the Python reference implementation.
