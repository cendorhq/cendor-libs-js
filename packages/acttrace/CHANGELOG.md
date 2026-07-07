# @cendor/acttrace

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
