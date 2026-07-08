# @cendor/core

## 0.4.1

### Patch Changes

- 3b517c3: acttrace: `AuditLog(path)` no longer truncates an existing log on construction. It now opens the file in append mode and resumes the hash chain from the last on-disk entry instead of restarting from genesis and overwriting prior entries — a silent data-loss bug that broke long-term retention. A reopen is a pure resume (no new `audit_open` marker, existing entries preserved, `verify()` spans the full chain); a fresh log is unchanged; a corrupt/unparseable tail throws instead of silently restarting. `export()` still truncates as before.

  core: eagerly warm the default `o200k_base` token encoder at module import so the first guarded pre-flight (or first `tokens.count`) in a process no longer pays the one-time js-tiktoken encoder build. Pure optimization — the warm-up is once-guarded and never throws.

## 0.4.0

### Minor Changes

- 05fdc78: Add a LangChain.js / LangGraph callback handler at the `@cendor/core/langchain` subpath.

  `CendorCallbackHandler` mirrors the Python handler: attach it via `callbacks: [...]` and it records
  usage (including reasoning + cache breakdowns from LangChain's `usage_metadata`), prices each call
  offline, emits normalized `LLMCall` / `ToolCall` events on the bus, and correlates multi-node /
  multi-agent runs by walking the callback run tree to a shared root-run `traceId`. It is
  **recording-only** — post-call, so it never enforces (use the provider SDK with `instrument()` for
  pre-flight budget/redaction).

  `@langchain/core` is an **optional** peer dependency, lazy-loaded; importing the subpath without it
  throws a clear install error.

## 0.3.3

### Patch Changes

- aa12f36: Packaging and docs: ship LICENSE + NOTICE inside each published tarball, add `homepage` and
  `bugs` metadata, and add npm-version + Apache-2.0 badges plus a README banner. No API or runtime
  changes.

## 0.3.2

### Patch Changes

- 0045081: Plain-language README openers (the tagline npm renders at the top of each package page) — matches the rewritten one-line descriptions. Docs only.

## 0.3.1

### Patch Changes

- 0536aae: Plain-language npm package descriptions (metadata only — no code change).

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
