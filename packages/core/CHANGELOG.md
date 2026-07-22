# @cendor/core

## 0.9.0

### Minor Changes

- 83c0ca7: `otel.span()` now makes its span the **active context span** for the duration of the callback (via
  `startActiveSpan`, parity with Python's `start_as_current_span`). Downstream reads of the active
  span — notably `@cendor/acttrace`'s audit-entry correlation — now see it and stamp its trace id, and
  child spans created inside the callback nest under it. Unchanged when `@opentelemetry/api` is absent
  (still a no-op that runs the callback with `null`) or when no OTel context manager is registered
  (the callback runs; the span is simply not propagated). No API change.

## 0.8.0

### Minor Changes

- 60f2eaf: Emission truth (Monitor v5, G-V4-3): the libs-only `otel.useSpanEmitter()` now stamps
  `cendor.usage_estimated="true"` on an emitted `chat` span when a streamed call reported no usage and
  the token count was recovered by an offline estimate (`metadata.usage_estimated`). Truth = the
  product — a monitor renders those tokens as _est._ rather than the provider's billed figure. Additive;
  stamped only when set (a real provider-reported count leaves the span unflagged).

## 0.7.0

### Minor Changes

- ec4be36: Opt-in content capture, a libs-only span emitter, and TTFT (Monitor v3 emission wave).

  - **Opt-in content capture (OFF by default)** — `otel.captureContent({ mask, maxBytes })` and the standard `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` env var export prompts/responses/thinking/tool values onto the semconv content span attributes (`gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.system_instructions`). A `mask` scrubs before export (fail-closed if it throws); `maxBytes` caps each attribute with a truncation marker. Content never enters the acttrace evidence chain (rule 6). Helpers `otel.contentAttrs(...)` / `otel.toolContentAttrs(...)`.
  - **`otel.responseMessages(call)`** — best-effort per-provider parse of assistant output into text + thinking parts (the content provider `parse()` drops).
  - **`otel.useSpanEmitter()`** — an opt-in bus→span subscriber emitting a `chat`/`execute_tool` semconv span per event, so a libs-only app lights up a trace-based monitor. Defers to an active SDK `liveSpans` (no double spans) via `otel.enterLiveSpans()`/`exitLiveSpans()`.
  - **TTFT** — streamed calls stamp `metadata.ttft_ms`, surfaced as `cendor.ttft_ms` on emitted chat spans.

## 0.6.1

### Patch Changes

- 60bd02d: Fix: `instrument()` no longer throws on clients whose task methods are non-writable, non-configurable own properties — notably `@huggingface/inference` v3+, whose `InferenceClient` defines every method with `Object.defineProperty(this, name, { value })`. Such a method can't be replaced in place (assignment raises `TypeError: Cannot assign to read only property 'chatCompletion'`), which crashed the whole Hugging Face path in JS. `instrument()` now falls back to a lightweight Proxy that serves the wrapped method (identity and in-place patching are unchanged for every other client), so HF capture works and the "unknown clients are returned untouched" contract holds even when patching fails.

## 0.6.0

### Minor Changes

- b774bd0: Embeddings capture, Usage arithmetic, and a survive-refresh price registry — the core half of the SDK↔lib inheritance fixes.

  - **`instrument()` now captures `embeddings.create`** on openai-shaped clients (OpenAI + Azure-via-openai): the pre-flight interceptor pass runs (budget block/clamp and guard redact-before-send now apply to embedding calls — a `Reroute({ messages })` maps back to the raw `input` shape), and the emitted `LLMCall` carries `metadata.embedding = true`, usage from `response.usage`, and cost from the price table. Embeddings leave the documented capture-gaps list.
  - **`sumUsage(usages)`** — field-complete `Usage` aggregation next to `sumMoney`: iterates the instances' own numeric fields, so a future `Usage` field can never silently vanish from an aggregate.
  - **`prices.register` registrations now survive `prices.refresh()`** — re-applied after every table swap instead of being dropped.
  - The bundled price snapshot gains the OpenAI embedding rows (`text-embedding-3-small` $0.02/1M · `text-embedding-3-large` $0.13/1M · `text-embedding-ada-002` $0.10/1M — verified on the official model pages), so USD budgets bind on embedding calls out of the box.

## 0.5.2

### Patch Changes

- a08a73d: Model-currency patch. The bundled price snapshot is regenerated for the current model generation
  (every rate verified against the official provider pricing pages, `_updated` 2026-07-11): adds the
  OpenAI gpt-5.x line, Anthropic claude-fable-5 / claude-mythos-5 / claude-sonnet-5 (standard
  post-2026-09-01 rate; intro rate noted in `_note`) / opus-4-7/-4-6/-4-5, Gemini 3.x, and xAI
  grok-4.3 / grok-4.5; corrects claude-haiku-4-5 to the official $1/$5 (+ $0.10 cache read / $1.25
  5m write) and the Gemini 2.5 cache-read rates; removes the dead gemini-2.0-flash / gemini-1.5-pro
  rows. Wire-level model ids now normalize at price lookup, so Bedrock modelIds
  (`anthropic.…-v1:0`, `us.`-region profiles) and dated Anthropic / OpenAI snapshot ids price like
  their base model instead of yielding a null cost — unknown models still throw.

## 0.5.1

### Patch Changes

- 3ae2af6: AI-assistant onboarding: inline Type Teach now ships in every package — `@example` + correct-shape JSDoc on public symbols, the `budget(cfg, fn): never` decoy overload (the wrong shape is a compile error), Literal-narrowed string params, and `@deprecated` casing aliases — plus the bundled `INTEGRATION.md`. No runtime behavior change for correct code; the wrong call-shape just fails to typecheck with a message stating the right one. Full trap sheet: https://cendor.ai/docs/for-ai-assistants

## 0.5.0

### Minor Changes

- d20450e: Deep-QA fixes: token accuracy for the open/hosted-model class + Gemini capture.

  - Non-OpenAI / unrecognized models — llama, mistral, deepseek, qwen, new o-series ids (`o5-mini`), and OpenAI fine-tunes (`ft:gpt-4o:*`) — now count via the `o200k` BPE proxy (`bpe-estimate`), exactly like Claude/Gemini, instead of the character heuristic. **This changes token counts** for the whole open/hosted-model class (hence a minor). The o-series match is generalized (`^o\d`) and an `ft:` fine-tune strips to its base model, counting `exact` (H2).
  - Gemini usage/cost capture in `instrument()` now reads the real `@google/genai` **camelCase** `usageMetadata` keys (`promptTokenCount`/`candidatesTokenCount`/`thoughtsTokenCount`), with a snake_case fallback, on both the non-streaming and streaming paths — previously `usage`/`cost` came back `null` (H3).

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
