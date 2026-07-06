# @cendor/cassette

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
