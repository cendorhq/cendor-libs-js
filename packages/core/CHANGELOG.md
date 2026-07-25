# @cendor/core

## 0.13.0

### Minor Changes

- 06f79a6: **Telemetry truth fixes — attach order and concurrency no longer break the OTel path.**

  Two silent defects, both found by a zero-telemetry-code study against a live monitor, both fixed
  before the auto-wiring work that depends on them. Neither changes an API.

  **`@cendor/tokenguard` — `OTelSink` acquires its meter lazily.** The JS metrics API has no proxy
  provider: before your app calls `metrics.setGlobalMeterProvider` (i.e. before `NodeSDK.start()`),
  `metrics.getMeterProvider()` is a `NoopMeterProvider` and a counter taken from it stays a no-op
  **forever**. Because the sink acquired its counters in the constructor, `useSink(new OTelSink())`
  placed above your OTel setup recorded **zero** datapoints, permanently and silently — an undocumented
  ordering trap (Python was always safe: its providers proxy). The meter is now acquired on `write()`
  and cached only once a real provider answers, so attach order is irrelevant. If your spend counters
  were mysteriously empty, this is why.

  **`@cendor/core` — the live-spans latch is context-local.** `enterLiveSpans`/`exitLiveSpans` (the
  latch that makes the G20 span emitter stand down inside an SDK run) used a module-global counter, so
  **one** open scope suppressed the emitter for **every** concurrent async context in the process: an
  app mixing an SDK run with concurrent libs-only calls silently lost the flat spans for the latter, and
  an unclosed `liveSpans()` handle stuck the latch forever, killing the emitter process-wide. It is now
  `AsyncLocalStorage`-backed (falling back to the old counter off-Node), matching Python's `ContextVar`.
  Signatures are unchanged.

  Also: `bus._subscriberCount()` (a test helper, mirroring Python's `bus._subscriber_count()`).

## 0.12.2

### Patch Changes

- 3487a13: `instrument()` now detects a boto-shaped `converse_stream` as an always-stream Bedrock target, routed through the existing Bedrock stream/usage branches — closing the last undocumented `instrument()` detection asymmetry with the Python library. The public provider stays `bedrock`; the response object's `stream` member is wrapped and handed back unchanged, so `for await (const e of response.stream)` still works.

## 0.12.1

### Patch Changes

- db14433: Fix: `@cendor/core/openai-agents` now stamps the agent name on **live** calls. The OpenAI Agents SDK runs each model call in an async context isolated from the lifecycle listeners, so the `AsyncLocalStorage` set in a listener never reached the call — the name was silently dropped live (the offline fixture passed because it drove listeners + call in one context; `instrument()` always captured the call with real usage, so "the calls ride the standard client" held — only the name was missing). Now tracks the active agent in a process-wide holder read live at event construction. **Honest limit:** correct for sequential runs + handoffs (the common case); concurrent `runner.run()` in the same process may cross-attribute during overlap (per-run scoping is impossible — the SDK isolates the call's context from the listeners; run concurrent multi-agent workloads in separate processes). `@cendor/core/foundry` is unaffected (its `foundryAgentScope` is a synchronous callback wrap).

## 0.12.0

### Minor Changes

- 84c2a2b: Framework agent-name adapters — two optional integrations that source a third-party framework's agent identity onto the bus, mirroring the shipped `@cendor/core/langchain` handler. Core carries no identity of its own; the framework owns the name, these adapters carry it. Additive — importing an adapter registers no ambient provider (the zero-provider fast path holds until you attach).

  - **`@cendor/core/openai-agents`** (`observeOpenAIAgents(runnerOrAgent)`) — attach to the OpenAI Agents SDK's `Runner`/`Agent`; stamps the framework's agent name per turn (set at `agent_start`/`agent_handoff`, cleared at `agent_end`) via `AsyncLocalStorage.enterWith`. The agent's model calls ride the standard OpenAI client, so `instrument()` still captures tokens/cost/streaming — this supplies only the name (GLR-11c). Returns a disposer; optional peer `@openai/agents`.
  - **`@cendor/core/foundry`** (`observeFoundryAgents(client)` + `foundryAgentScope(agentId, threadId, fn)`) — a correlation adapter for Azure AI Foundry Agents. Wraps `client.runs.{create,createAndPoll,createThreadAndRun}` to stamp `agent` + `conversation_id` for the run's duration. **Attribution only** — the model runs server-side, so no per-step token/cost (documented honest limit). Duck-typed on `.runs` (no `@azure/ai-agents` import needed to import the adapter); optional peer `@azure/ai-agents`.

## 0.11.0

### Minor Changes

- 3f5b000: Add a per-chunk **stream-observer seam** (`addStreamObserver`/`removeStreamObserver`): register
  `fn(call, deltaText, deltaThinking)` on every instrumented stream; **throwing aborts the stream**
  (closes the underlying provider stream, finalizes the `LLMCall` once with the partial estimated
  usage, re-throws) — interceptor discipline, with a zero-observer fast path (one length check per
  chunk). This is the generic seam `@cendor/tokenguard`'s mid-stream budget breaker
  (`budget({ onExceed: 'break' })`) rides; core learns no budget vocabulary.

  Streamed usage estimation now also counts **visible** thinking (Anthropic `thinking_delta`, Ollama
  `message.thinking`, OpenAI-compat `reasoning_content`, Bedrock `reasoningContent`) into output +
  reasoning — narrowing the documented limit from "can't see thinking" to "can't see _hidden_
  thinking". `closeUnderlying` now also aborts the SDK stream's fetch controller when present.

## 0.10.0

### Minor Changes

- 9e1e564: Add the ambient metadata seam — the one core-owned pre-emit capture point. `addAmbientProvider(fn)` /
  `removeAmbientProvider(fn)` register a `(event) => metadata | undefined` provider that runs at every
  event's construction (the caller's synchronous frame, before interceptors), merging its metadata onto
  `event.metadata` with never-throw / never-overwrite / registration-order semantics and a zero-provider
  single-length-check fast path. This is how a library (or app) attaches run context — agent,
  conversation id, budget frames, cassette session — at the moment it is unconditionally correct,
  instead of re-reading async-local storage at bus-delivery time (which breaks for streams finalized
  outside the originating scope, context-losing layers, subscriber order, and concurrent runs).

  Also: `otel.ingest()` now stamps the ambient `traceId` at construction so an ingested call joins its
  run; the libs-only span emitter maps `metadata.agent` → `gen_ai.agent.name`; and the LangChain
  callback handler stamps the agent/chain/LangGraph-node name into `metadata.agent` (explicit
  `metadata.agent` wins). No shape change to `events/1` — everything rides the sanctioned `metadata`
  extension point.

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
