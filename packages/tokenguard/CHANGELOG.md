# @cendor/tokenguard

## 0.4.3

### Patch Changes

- Updated dependencies [83c0ca7]
  - @cendor/core@0.9.0

## 0.4.2

### Patch Changes

- Updated dependencies [60f2eaf]
  - @cendor/core@0.8.0

## 0.4.1

### Patch Changes

- Updated dependencies [ec4be36]
  - @cendor/core@0.7.0

## 0.4.0

### Minor Changes

- 16e627b: Budget identity + a native governance counter. `budget({ name, description })` gives a budget a human identity that rides every `BudgetEvent` it fires (mirrored by `@cendor/acttrace >= 0.8` as `cendor.audit.budget` / `cendor.audit.description`), so an audit stream / monitor shows _which_ budget acted. Every pre-flight budget action also increments a `cendor.tokenguard.budget.events` counter (meter `cendor.tokenguard`; no-op without OpenTelemetry) — `cendor_tokenguard_budget_events_total` in Prometheus — so budget-block rates are chartable. Both additive and backward-compatible; keep `name` a bounded identifier (it is also a counter label).

## 0.3.0

### Minor Changes

- ea7cfa9: OpenTelemetry observability export.

  - **acttrace**: `new AuditLog(system, { mirror })` + `OTelMirror` stream the audit chain to any OpenTelemetry backend as an operational copy — the hash-chained file stays the sole `verify()` evidence. New `budget_event` entry type; entries carry `otel_trace_id`/`otel_span_id` when a span is active. All no-ops without `@opentelemetry/api`; the default chain is byte-identical.
  - **tokenguard**: `BudgetEvent` (blocked/downgraded/clamped) is emitted on the bus so acttrace chains it and an OTel mirror can alert on it; `OTelSink` now dimensions spend counters by the active `track(...)` tags (`new OTelSink({ tags: false })` for model-only, to bound metric cardinality).

  See https://cendor.ai/docs/observability

## 0.2.8

### Patch Changes

- b774bd0: Re-pin `@cendor/core` to the 0.6.0 shelf (no code change). A 0.x caret never crosses a minor, so without this bump a fresh install mixing these libs with `@cendor/core@0.6.0` consumers (e.g. `@cendor/sdk` ≥ 0.10.0) would resolve two coexisting core copies — two buses, split governance. One deduped core restores the single seam.
- Updated dependencies [b774bd0]
  - @cendor/core@0.6.0

## 0.2.7

### Patch Changes

- 3ae2af6: AI-assistant onboarding: inline Type Teach now ships in every package — `@example` + correct-shape JSDoc on public symbols, the `budget(cfg, fn): never` decoy overload (the wrong shape is a compile error), Literal-narrowed string params, and `@deprecated` casing aliases — plus the bundled `INTEGRATION.md`. No runtime behavior change for correct code; the wrong call-shape just fails to typecheck with a message stating the right one. Full trap sheet: https://cendor.ai/docs/for-ai-assistants
- Updated dependencies [3ae2af6]
  - @cendor/core@0.5.1

## 0.2.6

### Patch Changes

- d20450e: Deep-QA fix: under `onExceed: 'clamp'`, the provider output ceiling (`max_completion_tokens` / `max_tokens` = the tokens left in the budget) is now **always** injected on a call under a token budget — not only when the 256-token reserve heuristic would breach. A single surprise-long call can no longer overshoot the `tokens=` cap while headroom exists (M1).
- Updated dependencies [d20450e]
  - @cendor/core@0.5.0

## 0.2.5

### Patch Changes

- Updated dependencies [05fdc78]
  - @cendor/core@0.4.0

## 0.2.4

### Patch Changes

- aa12f36: Packaging and docs: ship LICENSE + NOTICE inside each published tarball, add `homepage` and
  `bugs` metadata, and add npm-version + Apache-2.0 badges plus a README banner. No API or runtime
  changes.
- Updated dependencies [aa12f36]
  - @cendor/core@0.3.3

## 0.2.3

### Patch Changes

- 0045081: Plain-language README openers (the tagline npm renders at the top of each package page) — matches the rewritten one-line descriptions. Docs only.
- Updated dependencies [0045081]
  - @cendor/core@0.3.2

## 0.2.2

### Patch Changes

- 0536aae: Plain-language npm package descriptions (metadata only — no code change).
- Updated dependencies [0536aae]
  - @cendor/core@0.3.1

## 0.2.1

### Patch Changes

- Updated dependencies [9b7817a]
- Updated dependencies [09d44d2]
  - @cendor/core@0.3.0

## 0.2.0

### Minor Changes

- 94d7d95: Initial releases of the pure-compute libraries — TS ports of `cendor.squeeze`, `cendor.tokenguard`,
  and `cendor.contextkit`.

  - **@cendor/squeeze** — content-aware, deterministic, reversible context compression (`compress`/
    `decompress`/`detect`/`SqueezeCompressor`/`Handle`) with `MemoryStore` (LRU) + `SQLiteStore`
    content-addressed backends. Satisfies core's `Compressor` protocol by shape.
  - **@cendor/tokenguard** — pre-flight cost caps + per-tag spend attribution (`budget`/`withBudget`,
    `track`, `estimate`, `report`, sinks) over core's bus + interceptor seam, with `AsyncLocalStorage`
    scoping and `BudgetExceeded`/`UnpricedModelWarning`.
  - **@cendor/contextkit** — assemble context to a token budget with priority, pinning, eviction
    strategies, ordering modes, history peeling, and provider adapters; auto-discovers `@cendor/squeeze`
    for `evict: 'compress'`.

### Patch Changes

- Updated dependencies [911383f]
  - @cendor/core@0.2.0
