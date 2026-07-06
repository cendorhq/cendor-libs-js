# @cendor/tokenguard

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
