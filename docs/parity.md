# Parity matrix — Python ↔ TypeScript

How the `@cendor/*` npm packages map to the reference Python `cendor.*` libraries. Both are one
implementation of the shared [format specs](https://github.com/cendorhq/cendor-libs/tree/main/docs/specs);
cross-language artifacts (cassettes, audit chains, prices, bus events) are byte-for-byte interoperable,
checked by committed conformance vectors (replayed in the cendor-libs-js CI today; Python-side replay
of JS-written artifacts lands with JS-6).

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
| `instrument()` providers | ✅ 6 (OpenAI, Anthropic, HuggingFace, google-genai, Bedrock, Ollama) | 🚧 OpenAI (Chat+Responses) + Anthropic | HuggingFace / google-genai / Bedrock / Ollama detection are **Py-only** today; same seam |
| `instrument()` streaming / interceptors / `Reroute` | ✅ | ✅ | |
| core `otel` spans / `ingest()` | ✅ | **Py-only** | OTel *export* ships via tokenguard's `OTelSink` in both; core's `otel` module is Py-only for now |
| LangChain `CendorCallbackHandler` | ✅ | **Py-only** | LangChain.js handler not ported (lands by demand) |
| `trace()` correlation | ✅ contextvars | ✅ | AsyncLocalStorage-injectable; ambient fallback |
| **tokenguard** budgets/track/report/sinks | ✅ | ✅ | `AsyncLocalStorage` scoping; SQLite/Queue/OTel sinks |
| **contextkit** assemble/evict/order | ✅ | ✅ | single async `assemble()` (Py sync+async collapsed) |
| **squeeze** compress/decompress | ✅ | ✅ | deterministic; sha256 handle ids match |
| **cassette** record/replay | ✅ | ✅ | Python-recorded cassette replays in JS (vector-verified) |
| cassette `local_embedding_scorer` | ✅ | **Py-only** | TS ships a declared stub; static-embedding scorer is Py-only for now |
| cassette storage | fs | fs + memory (+ IndexedDB-shaped) | pluggable adapters |
| **acttrace** chain/verify/sign | ✅ | ✅ | JS-written chain `verify()`s in Python (HMAC + `_meta`) |
| acttrace detectors | ✅ regex **+ Presidio NER** | ✅ regex/pattern (20 detectors + validators) | **NER is Py-only** (`ner_available()` → false) |
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

See the [SDK parity page](https://github.com/cendorhq/cendor-sdk-js) — Agent loop, OpenAI + Anthropic
providers first (others scaffolded behind the same `Provider` seam), zod tool schemas, sessions
(better-sqlite3 + memory adapters), handoff/supervisor/sequential/parallel, structured outputs,
streaming (**buffered today**; incremental + multi-agent streaming land in JS-6), and the v1.1
surface (progress hooks, prompt caching, live OTel spans).
