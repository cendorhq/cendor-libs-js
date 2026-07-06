# @cendor/contextkit

## 1.0.0

> Note: the jump to `1.0.0` was an automatic **major** bump emitted by changesets when the
> `@cendor/squeeze` peer dependency was versioned — not a breaking API change. This is the initial
> public release of `@cendor/contextkit`. Package versions are independent per-package and
> per-language (see the parity page), so a `1.0.0` alongside `0.2.0` siblings is expected.

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

- Updated dependencies [94d7d95]
- Updated dependencies [911383f]
  - @cendor/squeeze@0.2.0
  - @cendor/core@0.2.0
