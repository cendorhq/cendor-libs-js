# @cendor/cassette

## 0.3.3

### Patch Changes

- 3487a13: `_drift` is now anchored on the global symbol registry (`Symbol.for('cendor.cassette.drift')`), so two loaded copies of `@cendor/cassette` share one drift buffer instead of each splitting off its own — mirroring core's cross-copy sentinel pattern (the dual-copy hazard the 0.3.0 ambient-session fix closed for sessions). No API change.
- Updated dependencies [3487a13]
  - @cendor/core@0.12.2

## 0.3.2

### Patch Changes

- Updated dependencies [84c2a2b]
  - @cendor/core@0.12.0

## 0.3.1

### Patch Changes

- Updated dependencies [3f5b000]
  - @cendor/core@0.11.0

## 0.3.0

### Minor Changes

- 9e1e564: Record / replay now key off a session id stamped **at call initiation** (via the `@cendor/core`
  ambient seam), with the delivery-time async-local read kept only as a split-brain fallback. A
  streamed call created inside a `using()` block but drained on a detached consumer (or while a
  different session's scope is active) is now recorded into — and replayed from — the correct
  cassette, instead of being lost or captured by the wrong session. The session id is a reserved
  top-level metadata key, excluded from the replay fingerprint, so **every existing recorded cassette
  replays byte-identically** — nothing to re-record. Requires `@cendor/core` >= 0.10.0.

### Patch Changes

- Updated dependencies [9e1e564]
  - @cendor/core@0.10.0

## 0.2.11

### Patch Changes

- Updated dependencies [83c0ca7]
  - @cendor/core@0.9.0

## 0.2.10

### Patch Changes

- Updated dependencies [60f2eaf]
  - @cendor/core@0.8.0

## 0.2.9

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

- d20450e: Docs/typing: `localEmbeddingScorer` is now clearly documented as **Python-only — always throws** in JS (there is no maintained model2vec JS port). The symbol exists only so the name is discoverable and the failure is an immediate, clear error, not a working scorer; wire your own embedder via `embeddingScorer` (L9).
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
