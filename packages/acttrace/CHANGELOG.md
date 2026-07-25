# @cendor/acttrace

## 0.11.4

### Patch Changes

- Updated dependencies [06f79a6]
  - @cendor/core@0.13.0

## 0.11.3

### Patch Changes

- Updated dependencies [84c2a2b]
  - @cendor/core@0.12.0

## 0.11.2

### Patch Changes

- 3f5b000: Declare `@opentelemetry/api` as an **optional** peer dependency (matching `@cendor/tokenguard`), so
  the OpenTelemetry mirror / native counters resolve a compatible version when OTel is installed and
  stay a clean no-op when it isn't. No runtime behavior change.
- Updated dependencies [3f5b000]
  - @cendor/core@0.11.0

## 0.11.1

### Patch Changes

- 053db63: Add `resetDetectors()` — restore the detector registry to the built-in defaults, dropping anything
  added by `registerDetector` / `enableEntropyDetector` / `enableLocalePack`. The registry is
  module-global (opt in once at startup); this is the inverse — for turning an opt-in detector back
  off, dynamic reconfiguration, and test isolation (so a registered detector can't leak into a later
  test and scrub, e.g., a high-entropy id from a later audit payload). `registerDetector` is now
  idempotent (a detector already present is not added twice).

## 0.11.0

### Minor Changes

- 9e1e564: Auto-captured `llm_call` / `tool_call` audit entries now take their `run_id` from the event's own
  captured `traceId` and their `decision_id` from context captured at call initiation (via the
  `@cendor/core` ambient seam), instead of re-reading the ambient run/decision scope at delivery time.
  A streamed call finalized outside the originating run/decision scope is therefore still joined to the
  right run and chained under the right decision. `budget_event` entries copy the tokenguard
  `BudgetEvent.traceId` into `run_id`, so a monitor's dual-key join links a budget action to its run.
  Audit-chain payloads are unchanged for in-scope calls (byte-identical); metadata never enters the
  chain. Requires `@cendor/core` >= 0.10.0.

### Patch Changes

- Updated dependencies [9e1e564]
  - @cendor/core@0.10.0

## 0.10.0

### Minor Changes

- 83c0ca7: Audit entries now carry `@cendor/core`'s ambient run id (`currentTraceId()`, set by the SDK's
  `trace(runId)` scope) as a `run_id` payload field, exposed by `OTelMirror` as `cendor.audit.run_id`.
  This lets an observability tool join a governance event to its run even when no OpenTelemetry span
  was active at append time (e.g. a post-hoc `spanTree` run, or an app with no context manager) — the
  fallback correlation alongside the existing `otel_trace_id`. No-op outside a run scope
  (`currentTraceId()` is `''`), so the default chain stays byte-identical and matches the Python
  implementation. No API change.

### Patch Changes

- Updated dependencies [83c0ca7]
  - @cendor/core@0.9.0

## 0.9.2

### Patch Changes

- 5552cdc: fix(otel): emit `llm_call` audit `latency_ms` as a number, not `"[object Object]"`

  The audit payload wraps floats in `PyFloat` (for int/float JSON-parity on the JSONL/hash side).
  `OTelMirror` stringified that wrapper, so the mirrored `audit.llm_call` span carried
  `cendor.audit.latency_ms = "[object Object]"` (the step span's own `latency_ms` was always correct).
  `setScalar`/`setInt` and the flat attribute loop now unwrap `PyFloat` to its numeric value before
  setting the span attribute. Added the missing `cendor.audit.latency_ms` assertion to the mirror test.

## 0.9.1

### Patch Changes

- Updated dependencies [60f2eaf]
  - @cendor/core@0.8.0

## 0.9.0

### Minor Changes

- ec4be36: Compression enters the audit chain (G21) — squeeze's `CompressionEvent` becomes evidence + a span.

  A `@cendor/squeeze` `CompressionEvent` (≥ 0.3) on the bus is duck-typed (keys `technique` + `ratio`) into a `compression` chain entry (metadata only) and mirrored as an `audit.compression` span (`cendor.audit.technique` / `.tokens_before` / `.tokens_after` / `.ratio` / `.store_kind` / `.handle_id` / `.kind`). Metadata-only, so not auto-redacted. Framework control mappings added for all four bundled frameworks. Backward-compatible; the file remains the sole verifiable evidence.

### Patch Changes

- Updated dependencies [ec4be36]
  - @cendor/core@0.7.0

## 0.8.0

### Minor Changes

- 16e627b: Mirror completeness — the `OTelMirror` now carries the structured fields an audit-history / monitoring view needs, not just labels. `audit.budget_event` spans gain the budget's name (`cendor.audit.budget`), description, `scope`, `to_model`, and the projected-vs-cap figures as dedicated attributes (`cendor.audit.projected_usd`/`cap_usd` as strings, `projected_tokens`/`cap_tokens` as ints) plus each `track()` tag as `cendor.audit.tag.<key>` (G10/G11). `audit.llm_call` gains `input_tokens`/`output_tokens`/`reasoning_tokens`/`latency_ms`/`replayed`; `audit.guardrail_decision` gains `agent`/`tool` and the guardrail's nested `severity`/`policy_version`/`policy_hash`; `audit.context_assembly` gains `budget_tokens`/`used_tokens` and non-zero per-action block counts (`kept`/`truncated`/`summarized`/`compressed`/`dropped`); `audit.human_oversight` gains the reviewer's `note`; `audit.audit_open` gains `risk_tier`; the correlation `otel_span_id` is now exposed as a queryable attribute (G12/G16). Backward-compatible; the file remains the sole verifiable evidence and the default (no-OTel) chain is byte-identical.

## 0.7.0

### Minor Changes

- ea7cfa9: OpenTelemetry observability export.

  - **acttrace**: `new AuditLog(system, { mirror })` + `OTelMirror` stream the audit chain to any OpenTelemetry backend as an operational copy — the hash-chained file stays the sole `verify()` evidence. New `budget_event` entry type; entries carry `otel_trace_id`/`otel_span_id` when a span is active. All no-ops without `@opentelemetry/api`; the default chain is byte-identical.
  - **tokenguard**: `BudgetEvent` (blocked/downgraded/clamped) is emitted on the bus so acttrace chains it and an OTel mirror can alert on it; `OTelSink` now dimensions spend counters by the active `track(...)` tags (`new OTelSink({ tags: false })` for model-only, to bound metric cardinality).

  See https://cendor.ai/docs/observability

## 0.6.0

### Minor Changes

- b774bd0: The dual-shape guard: `guard()` is now scope-capable, so the SDK can re-export the identical object (`Object.is(sdk.guard, acttrace.guard)`). Backward-compatible — the raw interceptor form is unchanged.

  - **`guard(opts, fn)` scope form.** `guard({ policy, audit, onBlock }, fn)` installs the interceptor on core's seam, runs `fn`, and removes it on the way out (exception-safe) — the TS analogue of Python's `with guard(...):`. The raw form `guard(policy, audit?, onBlock?)` still returns the plain interceptor for `addInterceptor`. Enforcement still lives on core's seam — the recorder/enforcer split is intact.
  - **`resolveFindings(findings, policy?)`** — the per-category action resolution `guard()` applies, exported: partitions findings into `{ block, redact, flag }`; with `policy` given, each finding is re-resolved against it (scan under one policy, enforce under another). Composers (like the SDK's pii/secrets bridge) can now honor per-category actions instead of flattening to one.
  - New exported types: `GuardOptions`, `OnBlock`, `ResolvedFindings`.

### Patch Changes

- Updated dependencies [b774bd0]
  - @cendor/core@0.6.0

## 0.5.3

### Patch Changes

- 3ae2af6: AI-assistant onboarding: inline Type Teach now ships in every package — `@example` + correct-shape JSDoc on public symbols, the `budget(cfg, fn): never` decoy overload (the wrong shape is a compile error), Literal-narrowed string params, and `@deprecated` casing aliases — plus the bundled `INTEGRATION.md`. No runtime behavior change for correct code; the wrong call-shape just fails to typecheck with a message stating the right one. Full trap sheet: https://cendor.ai/docs/for-ai-assistants
- Updated dependencies [3ae2af6]
  - @cendor/core@0.5.1

## 0.5.2

### Patch Changes

- Updated dependencies [d20450e]
  - @cendor/core@0.5.0

## 0.5.1

### Patch Changes

- 4d26329: `guardrail_decision` chain entries now capture the decision's `metadata`, so a guardrail's provenance is recorded as tamper-evident evidence — notably `@cendor/guardrails`' `loadPolicy()` stamps `policy_hash` / `policy_version`, letting an audit prove which policy was active. Still duck-typed (no sibling import); `metadata` defaults to `{}`, so a chain with no metadata is byte-identical to before. A patch so `@cendor/sdk`'s existing `^0.5.0` caret picks it up without an SDK dep bump.

## 0.5.0

### Minor Changes

- 7679740: Auto-capture guardrail decisions. When `@cendor/guardrails` is in use, every trip or flag it emits on the `@cendor/core` bus is now chained as a tamper-evident `guardrail_decision` entry (recording the guardrail name, stage, action, and reason — never the raw payload). Captured by **duck typing** (`guardrail`/`stage`/`action` present), so acttrace still imports no sibling tool — the same pattern already used for contextkit's assembly report. No API change; a log with no guardrails in play is byte-identical to before.

## 0.4.2

### Patch Changes

- 3b517c3: acttrace: `AuditLog(path)` no longer truncates an existing log on construction. It now opens the file in append mode and resumes the hash chain from the last on-disk entry instead of restarting from genesis and overwriting prior entries — a silent data-loss bug that broke long-term retention. A reopen is a pure resume (no new `audit_open` marker, existing entries preserved, `verify()` spans the full chain); a fresh log is unchanged; a corrupt/unparseable tail throws instead of silently restarting. `export()` still truncates as before.

  core: eagerly warm the default `o200k_base` token encoder at module import so the first guarded pre-flight (or first `tokens.count`) in a process no longer pays the one-time js-tiktoken encoder build. Pure optimization — the warm-up is once-guarded and never throws.

- Updated dependencies [3b517c3]
  - @cendor/core@0.4.1

## 0.4.1

### Patch Changes

- 0383592: Docs: correct the README to reflect the optional `compromise`-backed NER shipped in 0.4.0.

  The published README still described the pre-0.4.0 state ("regex/pattern detectors only", `nerAvailable()` → `false`, `nerRedactor()` throws, "NER intentionally absent"). It now documents the actual capability: `nerRedactor()` is a working name/place/org redactor when the optional `compromise` peer dep is installed (English-only, lighter than Python's Presidio — not full parity), and `nerAvailable()` reports its presence. No code change — this republishes the corrected README to npm.

## 0.4.0

### Minor Changes

- df3a2a8: Add optional NER-backed redaction to `@cendor/acttrace`, backed by the `compromise` peer dependency.

  `nerRedactor(entities, language, compose)` now returns a working redactor (previously a throwing
  stub): it walks dicts/arrays, runs the optional `compose` redactor first (e.g. `defaultRedactor` for
  the regex categories), then scrubs detected `PERSON` / `LOCATION` / `ORGANIZATION` / `DATE_TIME` spans
  with the `<redacted>` token — preserving the surrounding text. `nerAvailable()` reports whether the
  backend is present; `nerRedactor()` throws a clear install hint when it isn't. Plug it into
  `new AuditLog(system, { redactor })` (a custom redactor owns its own flagging).

  `compromise` is an **optional** peer dependency, lazy-loaded synchronously (acttrace's tamper-evident
  append path is synchronous). **Honest coverage:** this is English-only and lighter than Python's
  Presidio backend — a useful extra layer, not a sole PII control. A transformer NER (transformers.js)
  would match Presidio's quality but is async + heavy, so it can't plug into the sync append path. See
  the parity matrix.

### Patch Changes

- Updated dependencies [05fdc78]
  - @cendor/core@0.4.0

## 0.3.3

### Patch Changes

- aa12f36: Packaging and docs: ship LICENSE + NOTICE inside each published tarball, add `homepage` and
  `bugs` metadata, and add npm-version + Apache-2.0 badges plus a README banner. No API or runtime
  changes.
- Updated dependencies [aa12f36]
  - @cendor/core@0.3.3

## 0.3.2

### Patch Changes

- 0045081: Plain-language README openers (the tagline npm renders at the top of each package page) — matches the rewritten one-line descriptions. Docs only.
- Updated dependencies [0045081]
  - @cendor/core@0.3.2

## 0.3.1

### Patch Changes

- 0536aae: Plain-language npm package descriptions (metadata only — no code change).
- Updated dependencies [0536aae]
  - @cendor/core@0.3.1

## 0.3.0

### Minor Changes

- 0092224: Add the `acttrace` CLI bin so `npx acttrace verify <path> [--key K] [--expect-head H]
[--expect-entries N]` works, and correct the NER hint for JS: `nerRedactor()` now throws an honest
  message stating NER-backed redaction is Python-only (regex/pattern detectors ship in the JS port) —
  no more misleading `pip install` suggestion.

### Patch Changes

- Updated dependencies [9b7817a]
- Updated dependencies [09d44d2]
  - @cendor/core@0.3.0

## 0.2.0

### Minor Changes

- 595004d: Initial releases of the I/O libraries — byte-conformant TS ports of `cendor.cassette` and
  `cendor.acttrace`.

  - **@cendor/cassette** — record an agent run once, replay it forever (offline, deterministic). Rides
    core's bus (record) + interceptor (replay) seams; FIFO-per-hash matching; the 7-pattern built-in
    redactor; `promote`/`drift`/`semantic_match`; pluggable memory/fs storage; `AsyncLocalStorage`
    session isolation. **A Python-recorded cassette replays in JS** (verified against committed vectors).
  - **@cendor/acttrace** — a tamper-evident, auto-populated audit chain (regex/pattern detectors only,
    no Presidio). Canonical hashing byte-identical to Python (recursive key sort, compact separators,
    int/float-preserving numbers), HMAC signing, `verify()`, the 20-detector registry + validators,
    `Policy`/`scan`/`redact`, `guard()`, framework control mapping + signed `_meta` export.
    **A JS-written chain `verify()`s in Python** (HMAC + metadata signatures verified end-to-end).

  Both share a vendored Python-`json`-compatible serializer + number-preserving parser so hashed bytes
  match across languages exactly.

### Patch Changes

- Updated dependencies [911383f]
  - @cendor/core@0.2.0
