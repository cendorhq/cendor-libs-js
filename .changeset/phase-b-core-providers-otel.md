---
"@cendor/core": minor
---

instrument(): detect four more providers — HuggingFace (`chatCompletion`, checked first), Ollama
(callable `chat`), google-genai (`models.generateContent`, sync + async, plus the legacy
`generateContent` with a model default), and Bedrock (`converse`). Per-provider usage + streaming
extraction added. (Bedrock note: aws-sdk v3 uses `client.send(new ConverseCommand(...))` which can't
be duck-typed, so auto-detection matches only a boto-shaped `converse()` method — see the code
comment; first-class aws-sdk-v3 support rides the SDK provider.)

New `otel` module: `span(model, opts, fn)` opens an OpenTelemetry GenAI span (a no-op that still runs
`fn(null)` when `@opentelemetry/api` — a new optional peer dep — is absent) and `ingest(attrs)` emits
a priced `LLMCall` on the bus from `gen_ai.*` attributes (no OTel dependency).
