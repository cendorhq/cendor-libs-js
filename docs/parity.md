# Parity matrix — Python ↔ TypeScript

How the `@cendor/*` npm packages map to the reference Python `cendor.*` libraries. Both are one
implementation of the shared [format specs](https://github.com/cendorhq/cendor-libs/tree/main/docs/specs);
cross-language artifacts (cassettes, audit chains, prices, bus events) are byte-for-byte interoperable,
checked by committed conformance vectors in both CIs — each language verifies artifacts written by the
other (the cendor-libs-js CI replays Python-written fixtures; the cendor-libs CI verifies a JS-written
audit chain).

Legend: ✅ ported · 🚧 partial/scoped · — not applicable · **Py-only** deliberately not ported.

## Libraries (`cendor-libs` ↔ `cendor-libs-js`)

| Capability | Python | TypeScript | Notes |
|---|---|---|---|
| `Money` (decimal, never float) | ✅ | ✅ | `Decimal` ↔ `decimal.js`; value-equal across langs |
| `Usage` / `LLMCall` / `ToolCall` | ✅ | ✅ | field names snake_case ↔ camelCase; type names identical |
| Event bus | ✅ | ✅ | subscribe/emit/unsubscribe; error isolation + re-raise first |
| Price table + `estimate()` | ✅ | ✅ | decimal-exact; same bundled snapshot; `refresh()` async in TS |
| `prices.register()` | ✅* | ✅ | *Py registers via core's contractual `prices._register` hook (the SDK's `register_model_price` writes through it); TS's seam is public. Registrations **survive `refresh()`** in both (≥ 1.6.0 / 0.6.0) |
| Token counting | ✅ | ✅ | `tiktoken` ↔ `js-tiktoken` — exact counts match |
| `instrument()` providers | ✅ 6 (OpenAI, Anthropic, HuggingFace, google-genai, Bedrock, Ollama) | ✅ 6 (OpenAI, Anthropic, HuggingFace, google-genai, Bedrock, Ollama) | Bedrock JS auto-detects a boto-shaped `converse()`; aws-sdk-v3 rides the SDK provider |
| `instrument()` embeddings capture | ✅ (≥ 1.6.0) | ✅ (≥ 0.6.0) | openai-shaped `embeddings.create` (OpenAI + Azure): `metadata.embedding`, pre-flight interceptors apply (budget block / guard redact-before-send maps back to the raw `input` shape); the snapshot prices `text-embedding-*` |
| `instrument()` streaming / interceptors / `Reroute` | ✅ | ✅ | |
| `Usage` arithmetic | ✅ `Usage.__add__` / `sum_usage` | ✅ `sumUsage` | field-complete by construction — a new `Usage` field can't silently vanish from aggregates |
| **acttrace** dual-shape `guard` + `resolve_findings` | ✅ (≥ 1.5.0) | ✅ (≥ 0.6.0) | the raw interceptor is also the scope form (`with guard(...):` / `guard(opts, fn)`); `resolve_findings`/`resolveFindings` export guard's per-category action resolution for composers |
| core `otel` spans / `ingest()` | ✅ | ✅ | `span()` + `ingest()`; `@opentelemetry/api` optional peer — span is a no-op without it |
| observability export (`OTelSink` tags / `OTelMirror` / `budget_event`) | ✅ | ✅ | `OTelSink` dimensioned by `track` tags (`tags:false` for model-only); `AuditLog({ mirror: new OTelMirror() })` streams the audit chain as `audit.<type>` spans (operational copy — file stays the sole `verify()` evidence); `tokenguard` emits `BudgetEvent` (blocked/downgraded/clamped), acttrace chains it as `budget_event`; entries carry `otel_trace_id`/`otel_span_id` when a span is active. SDK re-exports `OTelMirror`/`BudgetEvent` after the libs release. SDK `spanTree`/`liveSpans` accept `conversationId` → `gen_ai.conversation.id` on the root `agent.run` span for multi-turn grouping. |
| LangChain `CendorCallbackHandler` | ✅ | ✅ | `@cendor/core/langchain`; recording-only in both; reads `usage_metadata`, correlates by root-run `traceId` |
| `trace()` correlation | ✅ contextvars | ✅ | AsyncLocalStorage-injectable; ambient fallback |
| **tokenguard** budgets/track/report/sinks | ✅ | ✅ | `AsyncLocalStorage` scoping; SQLite/Queue/OTel sinks |
| **guardrails** rules/stages/install/scoped | ✅ | ✅ | deterministic gate at 4 stages (input/tool_call/tool_output/output); block/redact/flag → `guardrail_decision` on the bus; `apply`/`evaluate` (+ async), `install()` interceptor, `scoped()` per-request gating, per-guardrail `timeout` (async-only in TS — no threads) + `on_error`, `judge` helpers; no hard `node:*` — all-runtime (`scoped` uses `AsyncLocalStorage` when present, else an ambient fallback) |
| guardrails detection-tier adapters | ✅ `classifier` / `prompt_guard` / `language` / `openai_moderation` | ✅ `classifier` / `language` / `openaiModeration` | bring-your-own local classifier / `detect` callable / OpenAI client — no ML deps; re-exported as `rules.*` + `adapters.*`. **`prompt_guard` is Python-only** (needs `transformers`) — 🚧 in TS: wire an ONNX/transformers.js model through `rules.classifier`. `language` needs a BYO `detect` in TS (no bundled langid). No jailbreak-detection claim — see "Threat model". |
| guardrails hosted rails | ✅ | ✅ | `bedrockGuardrail` (AWS ApplyGuardrail) / `azureContentSafety` (Prompt Shields) / `modelArmor` (Google) — **duck-typed** cloud clients (no cloud SDK imported), metered by the vendor; every verdict emits a **local** `guardrail_decision` ("cloud check, local evidence"). Async (JS cloud SDKs are async) → use via the SDK loop / `applyAsync`, not the sync `install()` seam. |
| guardrails config-as-data (`loadPolicy`) | ✅ `load_policy` | ✅ `loadPolicy` | build deterministic rules from a versioned document; `policy_hash` (a bundled all-runtime SHA-256) + `policy_version` stamped into every decision. **Py** reads a file path (YAML via `[yaml]`); **TS** takes the parsed object or text (JSON built in; BYO `parse` for YAML — no `node:fs`). The hash is canonical-per-language, not promised byte-identical across languages. |
| guardrails grounding / denied topics | ✅ | ✅ | `groundedness` / `deniedTopics` over a **bring-your-own** `embed(text)` fn (cassette BYO-scorer precedent) — cosine similarity, no bundled model, no accuracy claim. |
| guardrails red-team eval | ✅ | ✅ | `runRedteam` + `loadCorpus` — trip rate + false-positive rate + per-category breakdown against a labeled corpus **you** supply (no vended data). Py reads a file path; TS takes text/array (no `node:fs`). |
| guardrails `Guardrail.metadata` | ✅ | ✅ | static per-guardrail metadata merged into every decision (under per-call `Context.metadata`); acttrace captures it into the chain. |
| guardrails `spotlight` (A1) | ✅ | ✅ | deterministic, `$0`, offline `redact`-action **mitigation** (inspired by Azure Spotlighting): wraps untrusted content (`input` / `tool_output`) in a trust-lowering delimiter (optionally base-64 via all-runtime `btoa`/`TextEncoder`). Never blocks; a mitigation, not a detector. |
| guardrails annotation-parity metadata (A2) | ✅ | ✅ | reserved `GuardrailDecision.metadata` keys (`severity` / `detected` / `filtered` / `redacted` / `citation` / `license`) — no event-shape change; a check attaches them via `Verdict.metadata` (a new 4th ctor arg, transient) and the adapters populate them from the vendor result. |
| guardrails `taskAdherence` (A3) | ✅ `task_adherence` | ✅ | BYO-judge alignment check for the `tool_call` stage (does the proposed call match the user's intent?), via `judge.taskAdherence` + the optional `Context.instruction`. The `@cendor/guardrails` helper is at parity, and the **`@cendor/sdk`** (>= 0.7.0) runner auto-threads the user's turn into `ctx.instruction` — no manual wiring. |
| guardrails matching maturity (G1) | ✅ | ✅ | `keywordDeny({ match: 'word', normalize: [...] })` — opt-in Unicode word boundaries + NFKC/zero-width/casefold folding (default substring, byte-for-byte back-compatible); `metadata.matched` records the term. TS uses `\p{L}\p{N}_` lookarounds under the `u` flag (its `\b` is ASCII-only). |
| guardrails custom categories (G2) | ✅ | ✅ | `customCategory(name, examples, embed, opts?)` — semantic category-by-example (Azure "rapid custom categories" done local, `$0`); the paraphrase catch a deny-list misses. `embed` is BYO; no catch-rate claim. |
| guardrails local embedder (G2) | ✅ `local_embedder` (model2vec, **sync**) | ✅ `localEmbedder` (transformers.js, **async**) | a zero-config offline `embed` behind an optional extra in both languages. No maintained model2vec JS port exists, so the backends differ (Py model2vec static embeddings / TS `@huggingface/transformers` optional peer) and TS's is **async** — so `embed` may now be sync or async across the semantic rules; an async embed gates via `applyAsync` / the SDK loop. No catch-rate claim. |
| guardrails intent screening (G3) | ✅ | ✅ | `rules.intent(intents, { embed \| classify, mode })` — a first-class pre-LLM intent gate (deny / off-topic-allow); `judge.intentPrompt` is the LLM-judge backend. No accuracy claim, no bundled taxonomy. |
| guardrails presets + policy schema (G4) | ✅ | ✅ | `presets.PROMPT_INJECTION_EN` / `presets.promptInjection()` (curated starter list — inline constant, **not detection**, no coverage claim) + `policySchema()` + `loadPolicy(src, { validate: true })` (structural check). Py ships `policy.schema.json`; TS ships the schema inline (all-runtime). |
| guardrails Azure adapter breadth (G5) | ✅ | ✅ | `azureContentSafety(client, { checks: ['harm_categories'], harmThreshold, blocklistNames })` now also wraps Azure's `analyzeText` harm classifier (severity → `metadata.severity`) + blocklists, alongside Prompt Shields (default). Groundedness-as-a-service is a planned follow-up. |
| **contextkit** assemble/evict/order | ✅ | ✅ | single async `assemble()` (Py sync+async collapsed) |
| **squeeze** compress/decompress | ✅ | ✅ | deterministic; sha256 handle ids match |
| **cassette** record/replay | ✅ | ✅ | Python-recorded cassette replays in JS (vector-verified) |
| cassette `local_embedding_scorer` (bundled model2vec) | ✅ | **Py-only** | no JS static-embedding package exists; TS uses the BYO `embeddingScorer(embedFn)` / `openaiEmbeddingScorer` seam instead |
| cassette storage | fs | fs + memory (+ IndexedDB-shaped) | pluggable adapters |
| **acttrace** chain/verify/sign | ✅ | ✅ | JS-written chain `verify()`s in Python (HMAC + `_meta`) |
| acttrace detectors | ✅ regex **+ Presidio NER** (the `[ner]` extra + a `spacy download` model) | ✅ regex/pattern (20 detectors + validators) **+ NER** | 🚧 NER via optional `compromise` (English-only, sync, lighter than Presidio — not parity); `nerAvailable()` reports presence. Python's `[ner]` extra installs Presidio + spaCy but not a language model — install one (`python -m spacy download en_core_web_sm`); `ner_available()` reflects both and `ner_redactor()` raises a clear error if the model is missing |
| acttrace storage | fs | fs + memory | pluggable adapters |

## Runtime targets (TS)

| Package | Node | Edge (Workers) | Browser |
|---|---|---|---|
| `@cendor/core` | ✅ | ✅ | 🚧 (types/bus/prices/tokens pure; `instrument` wraps fetch SDKs) |
| `@cendor/contextkit`, `@cendor/squeeze` | ✅ | ✅ | ✅ pure compute |
| `@cendor/guardrails` | ✅ | ✅ | ✅ deterministic compute; `scoped()` uses `AsyncLocalStorage` on Node, an ambient save/restore fallback elsewhere (no hard `node:*`) |
| `@cendor/tokenguard` | ✅ | ✅ | ⚠️ advisory only — enforcement is server-side |
| `@cendor/cassette` | ✅ (fs) | ✅ (adapter) | ⚠️ memory/IndexedDB adapter |
| `@cendor/acttrace` | ✅ | ✅ | ❌ never — signing keys can't live in a client |

## SDK (`cendor-sdk` ↔ `cendor-sdk-js`)

See the [SDK parity page](https://github.com/cendorhq/cendor-sdk-js) — Agent loop, all ten provider
paths (OpenAI, Anthropic, HuggingFace, Azure AI Foundry chat + responses, Foundry Local, Ollama, Gemini,
Bedrock), zod tool schemas, sessions (better-sqlite3 + memory adapters), handoff/supervisor/sequential/
parallel, structured outputs, incremental single- + multi-agent streaming, the v1.1 surface (progress
hooks, prompt caching, live OTel spans), plus MCP tool loading, checkpoint/resume, A2A server/client,
and the Foundry Bot-Framework adapter. Usage capture for HuggingFace/Ollama/Gemini/Bedrock rides
`@cendor/core`'s provider detection (released together). Since 1.7.0 / 0.10.0 the SDK↔lib
inheritance is CI-verified in both languages: `guard` is the identical acttrace object, the SDK
`rules` namespace carries the full library catalogue (TS gained spotlight + the detection-tier
adapters + the similarity checks), `embed()` is governed pre-flight, and a parity/identity test
suite pins every re-export so drift fails the build.
