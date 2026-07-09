# @cendor/acttrace

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
