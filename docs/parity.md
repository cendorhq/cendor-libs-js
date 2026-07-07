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
| `prices.register()` | ✅* | ✅ | *Py registers via core's loaded table; TS adds a public seam |
| Token counting | ✅ | ✅ | `tiktoken` ↔ `js-tiktoken` — exact counts match |
| `instrument()` providers | ✅ 6 (OpenAI, Anthropic, HuggingFace, google-genai, Bedrock, Ollama) | ✅ 6 (OpenAI, Anthropic, HuggingFace, google-genai, Bedrock, Ollama) | Bedrock JS auto-detects a boto-shaped `converse()`; aws-sdk-v3 rides the SDK provider |
| `instrument()` streaming / interceptors / `Reroute` | ✅ | ✅ | |
| core `otel` spans / `ingest()` | ✅ | ✅ | `span()` + `ingest()`; `@opentelemetry/api` optional peer — span is a no-op without it |
| LangChain `CendorCallbackHandler` | ✅ | ✅ | `@cendor/core/langchain`; recording-only in both; reads `usage_metadata`, correlates by root-run `traceId` |
| `trace()` correlation | ✅ contextvars | ✅ | AsyncLocalStorage-injectable; ambient fallback |
| **tokenguard** budgets/track/report/sinks | ✅ | ✅ | `AsyncLocalStorage` scoping; SQLite/Queue/OTel sinks |
| **contextkit** assemble/evict/order | ✅ | ✅ | single async `assemble()` (Py sync+async collapsed) |
| **squeeze** compress/decompress | ✅ | ✅ | deterministic; sha256 handle ids match |
| **cassette** record/replay | ✅ | ✅ | Python-recorded cassette replays in JS (vector-verified) |
| cassette `local_embedding_scorer` (bundled model2vec) | ✅ | **Py-only** | no JS static-embedding package exists; TS uses the BYO `embeddingScorer(embedFn)` / `openaiEmbeddingScorer` seam instead |
| cassette storage | fs | fs + memory (+ IndexedDB-shaped) | pluggable adapters |
| **acttrace** chain/verify/sign | ✅ | ✅ | JS-written chain `verify()`s in Python (HMAC + `_meta`) |
| acttrace detectors | ✅ regex **+ Presidio NER** | ✅ regex/pattern (20 detectors + validators) **+ NER** | 🚧 NER via optional `compromise` (English-only, sync, lighter than Presidio — not parity); `nerAvailable()` reports presence |
| acttrace storage | fs | fs + memory | pluggable adapters |

## Runtime targets (TS)

| Package | Node | Edge (Workers) | Browser |
|---|---|---|---|
| `@cendor/core` | ✅ | ✅ | 🚧 (types/bus/prices/tokens pure; `instrument` wraps fetch SDKs) |
| `@cendor/contextkit`, `@cendor/squeeze` | ✅ | ✅ | ✅ pure compute |
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
`@cendor/core`'s provider detection (released together).
