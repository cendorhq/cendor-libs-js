# @cendor/squeeze

## 0.3.3

### Patch Changes

- Updated dependencies [9e1e564]
  - @cendor/core@0.10.0

## 0.3.2

### Patch Changes

- Updated dependencies [83c0ca7]
  - @cendor/core@0.9.0

## 0.3.1

### Patch Changes

- Updated dependencies [60f2eaf]
  - @cendor/core@0.8.0

## 0.3.0

### Minor Changes

- ec4be36: Compression visibility on the bus (G21) — squeeze stops being dark to a monitor/audit.

  `compress()` now emits a metadata-only `CompressionEvent` (`technique`, `tokens_before`, `tokens_after`, `ratio`, `store_kind`, `handle_id`, `kind`, `trace_id`, `ts`). It carries **only the shape** of a compression — never the text — so a monitor or the acttrace audit can show squeeze activity and token savings without any content leaving the process. `@cendor/acttrace` (≥ 0.9) duck-types it into a `compression` audit entry + an `audit.compression` span.

### Patch Changes

- Updated dependencies [ec4be36]
  - @cendor/core@0.7.0

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

- d20450e: Deep-QA fixes.

  - Budgeted JSON compression recurses into a payload nested under a single key (`{"data":[…]}`, `{"results":{…}}`), peeling elements/keys largest-first, instead of collapsing the whole thing to `{}` — so `contextkit`'s `Block(evict="compress")` keeps real content under a budget. Output stays valid JSON; `expand()` is still byte-exact (H1).
  - A non-JSON-serializable input (bigint / function / symbol) now throws a clear `compress()` error instead of silently producing garbage (L4).

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
