# @cendor/contextkit

## 2.0.4

### Patch Changes

- Updated dependencies [3f5b000]
  - @cendor/core@0.11.0

## 2.0.3

### Patch Changes

- Updated dependencies [9e1e564]
  - @cendor/core@0.10.0

## 2.0.2

### Patch Changes

- Updated dependencies [83c0ca7]
  - @cendor/core@0.9.0

## 2.0.1

### Patch Changes

- Updated dependencies [60f2eaf]
  - @cendor/core@0.8.0

## 2.0.0

### Patch Changes

- Updated dependencies [ec4be36]
- Updated dependencies [ec4be36]
  - @cendor/core@0.7.0
  - @cendor/squeeze@0.3.0

## 1.0.8

### Patch Changes

- b774bd0: Re-pin `@cendor/core` to the 0.6.0 shelf (no code change). A 0.x caret never crosses a minor, so without this bump a fresh install mixing these libs with `@cendor/core@0.6.0` consumers (e.g. `@cendor/sdk` ≥ 0.10.0) would resolve two coexisting core copies — two buses, split governance. One deduped core restores the single seam.
- Updated dependencies [b774bd0]
  - @cendor/core@0.6.0

## 1.0.7

### Patch Changes

- 3ae2af6: AI-assistant onboarding: inline Type Teach now ships in every package — `@example` + correct-shape JSDoc on public symbols, the `budget(cfg, fn): never` decoy overload (the wrong shape is a compile error), Literal-narrowed string params, and `@deprecated` casing aliases — plus the bundled `INTEGRATION.md`. No runtime behavior change for correct code; the wrong call-shape just fails to typecheck with a message stating the right one. Full trap sheet: https://cendor.ai/docs/for-ai-assistants
- Updated dependencies [3ae2af6]
  - @cendor/core@0.5.1

## 1.0.6

### Patch Changes

- d20450e: Deep-QA fix: an empty history `Block({ messages: [] })` no longer reports the misleading `history: dropped all 0 turns (no room)` — it is recorded as `kept` with no note, even with a large budget (L5).
- Updated dependencies [d20450e]
  - @cendor/core@0.5.0

## 1.0.5

### Patch Changes

- Updated dependencies [05fdc78]
  - @cendor/core@0.4.0

## 1.0.4

### Patch Changes

- aa12f36: Packaging and docs: ship LICENSE + NOTICE inside each published tarball, add `homepage` and
  `bugs` metadata, and add npm-version + Apache-2.0 badges plus a README banner. No API or runtime
  changes.
- Updated dependencies [aa12f36]
  - @cendor/core@0.3.3

## 1.0.3

### Patch Changes

- 0045081: Plain-language README openers (the tagline npm renders at the top of each package page) — matches the rewritten one-line descriptions. Docs only.
- Updated dependencies [0045081]
  - @cendor/core@0.3.2

## 1.0.2

### Patch Changes

- 0536aae: Plain-language npm package descriptions (metadata only — no code change).
- Updated dependencies [0536aae]
  - @cendor/core@0.3.1

## 1.0.1

### Patch Changes

- Updated dependencies [9b7817a]
- Updated dependencies [09d44d2]
  - @cendor/core@0.3.0

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
