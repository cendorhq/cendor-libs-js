# @cendor/libs

## 3.0.0

### Major Changes

- **The Cendor libraries now share one major version.** Every `@cendor/*` library moves its major
  together from here: anything on major 3 works with anything else on major 3. Minors and patches
  stay independent per package, so `@cendor/core 3.4.1` beside `@cendor/squeeze 3.0.2` is normal
  and correct.

  **No API changed in this release.** Nothing was removed, renamed, or reshaped — code that compiles
  today compiles after upgrading, and there is no migration. Upgrade the set together:
  `npm i @cendor/libs@latest`.

  These libraries cooperate through a single in-process event bus in `@cendor/core`. If two of them
  resolve *different* copies of core, that is two buses and cooperation stops silently — a guardrail
  decision never reaches the code listening for it, with nothing failing to say so. A shared major
  makes an incoherent set obvious at a glance rather than at runtime, and a caret spanning the whole
  major keeps the resolver on one copy.

  Policy: https://cendor.ai/docs/languages#versioning-and-support — a new capability is a **minor**,
  deprecations warn in-band for at least two minors before removal, security fixes land on the
  previous major for six months, and majors are announced 30 days ahead. Versions stay **independent
  across languages**; the parity matrix, not matching numbers, is the contract.

## 1.0.0

### Major Changes

- **1.0 — a stability declaration, not a breaking change.**

  No API moved. Nothing was removed, renamed, or given a different shape. If your code compiles against
  `0.16.x` it compiles against `1.0.0`. **There is no migration.**

  **Why now.** Pre-1.0, a caret never crosses a minor: `^0.15.0` will not accept `0.16.0`. Because every
  `@cendor/*` library declares a caret on `@cendor/core`, one sibling left a minor behind resolved a
  **second copy of `@cendor/core`** — which is a second event bus. Cross-library cooperation then stops
  **silently**: a guardrail decision emitted on one bus never reaches an SDK listening on the other, and
  nothing fails to say so. That was measured in the wild three times (2026-07-25 `@cendor/guardrails
0.7.6` against an SDK on `0.15.0`; twice in `cendor-testsuits`).

  At `1.x` a caret spans the whole major — the same shape Python has had all along with
  `cendor-core>=1,<2` — and the entire class of failure disappears.

  **What to expect.**

  - Upgrading is `npm i @cendor/libs@latest` (or the individual packages). Nothing else.
  - A `^0.x` range will **not** pick this up on its own — a caret does not cross a major. That is
    deliberate: you move when you choose to.
  - Version numbers are **independent across languages**. `cendor-core 1.14` (PyPI) and
    `@cendor/core 1.0` (npm) are the same capability; the
    [parity matrix](https://cendor.ai/docs/languages) is the contract, not matching numbers.
  - `@cendor/contextkit` continues from `2.x` to `3.0.0` rather than counting backwards — it took an
    accidental major earlier when a peer range widened. Same release, same meaning.

  Alongside this, the versioning contract is now written down at
  https://cendor.ai/docs/languages#versioning-and-support — SemVer per package, deprecations warning
  in-band for at least two minors before removal, security fixes on the previous major for 6 months,
  and majors announced 30 days ahead.

### Patch Changes

- Updated dependencies
  - @cendor/core@1.0.0
  - @cendor/tokenguard@1.0.0
  - @cendor/contextkit@3.0.0
  - @cendor/squeeze@1.0.0
  - @cendor/cassette@1.0.0
  - @cendor/acttrace@1.0.0
  - @cendor/guardrails@1.0.0

## 0.2.24

### Patch Changes

- Updated dependencies [95c4f39]
  - @cendor/core@0.16.0
  - @cendor/acttrace@0.14.0
  - @cendor/cassette@0.3.7
  - @cendor/contextkit@2.0.9
  - @cendor/guardrails@0.7.10
  - @cendor/squeeze@0.3.9
  - @cendor/tokenguard@0.8.2

## 0.2.23

### Patch Changes

- Updated dependencies [ca57a91]
  - @cendor/core@0.15.0
  - @cendor/acttrace@0.13.0
  - @cendor/cassette@0.3.6
  - @cendor/contextkit@2.0.8
  - @cendor/guardrails@0.7.9
  - @cendor/squeeze@0.3.8
  - @cendor/tokenguard@0.8.1

## 0.2.22

### Patch Changes

- Updated dependencies [6c87f98]
  - @cendor/core@0.14.0
  - @cendor/tokenguard@0.8.0
  - @cendor/acttrace@0.12.0
  - @cendor/cassette@0.3.5
  - @cendor/contextkit@2.0.7
  - @cendor/guardrails@0.7.8
  - @cendor/squeeze@0.3.7

## 0.2.21

### Patch Changes

- Updated dependencies [06f79a6]
  - @cendor/tokenguard@0.7.0
  - @cendor/core@0.13.0
  - @cendor/acttrace@0.11.4
  - @cendor/cassette@0.3.4
  - @cendor/contextkit@2.0.6
  - @cendor/guardrails@0.7.7
  - @cendor/squeeze@0.3.6

## 0.2.20

### Patch Changes

- Updated dependencies [84c2a2b]
  - @cendor/core@0.12.0
  - @cendor/acttrace@0.11.3
  - @cendor/cassette@0.3.2
  - @cendor/contextkit@2.0.5
  - @cendor/guardrails@0.7.6
  - @cendor/squeeze@0.3.5
  - @cendor/tokenguard@0.6.1

## 0.2.19

### Patch Changes

- Updated dependencies [3f5b000]
- Updated dependencies [3f5b000]
- Updated dependencies [3f5b000]
  - @cendor/acttrace@0.11.2
  - @cendor/guardrails@0.7.5
  - @cendor/core@0.11.0
  - @cendor/tokenguard@0.6.0
  - @cendor/cassette@0.3.1
  - @cendor/contextkit@2.0.4
  - @cendor/squeeze@0.3.4

## 0.2.18

### Patch Changes

- Updated dependencies [9e1e564]
- Updated dependencies [9e1e564]
- Updated dependencies [9e1e564]
- Updated dependencies [9e1e564]
  - @cendor/acttrace@0.11.0
  - @cendor/cassette@0.3.0
  - @cendor/core@0.10.0
  - @cendor/tokenguard@0.5.0
  - @cendor/contextkit@2.0.3
  - @cendor/guardrails@0.7.4
  - @cendor/squeeze@0.3.3

## 0.2.17

### Patch Changes

- Updated dependencies [83c0ca7]
- Updated dependencies [83c0ca7]
  - @cendor/acttrace@0.10.0
  - @cendor/core@0.9.0
  - @cendor/cassette@0.2.11
  - @cendor/contextkit@2.0.2
  - @cendor/guardrails@0.7.3
  - @cendor/squeeze@0.3.2
  - @cendor/tokenguard@0.4.3

## 0.2.16

### Patch Changes

- Updated dependencies [60f2eaf]
  - @cendor/core@0.8.0
  - @cendor/acttrace@0.9.1
  - @cendor/cassette@0.2.10
  - @cendor/contextkit@2.0.1
  - @cendor/guardrails@0.7.2
  - @cendor/squeeze@0.3.1
  - @cendor/tokenguard@0.4.2

## 0.2.15

### Patch Changes

- Updated dependencies [ec4be36]
- Updated dependencies [ec4be36]
- Updated dependencies [ec4be36]
  - @cendor/acttrace@0.9.0
  - @cendor/core@0.7.0
  - @cendor/squeeze@0.3.0
  - @cendor/cassette@0.2.9
  - @cendor/contextkit@2.0.0
  - @cendor/guardrails@0.7.1
  - @cendor/tokenguard@0.4.1

## 0.2.14

### Patch Changes

- Updated dependencies [16e627b]
- Updated dependencies [16e627b]
- Updated dependencies [16e627b]
  - @cendor/acttrace@0.8.0
  - @cendor/guardrails@0.7.0
  - @cendor/tokenguard@0.4.0

## 0.2.13

### Patch Changes

- Updated dependencies [ea7cfa9]
  - @cendor/acttrace@0.7.0
  - @cendor/tokenguard@0.3.0

## 0.2.12

### Patch Changes

- Updated dependencies [b774bd0]
- Updated dependencies [b774bd0]
- Updated dependencies [b774bd0]
  - @cendor/core@0.6.0
  - @cendor/acttrace@0.6.0
  - @cendor/tokenguard@0.2.8
  - @cendor/contextkit@1.0.8
  - @cendor/squeeze@0.2.8
  - @cendor/guardrails@0.6.2
  - @cendor/cassette@0.2.8

## 0.2.11

### Patch Changes

- Updated dependencies [d20450e]
- Updated dependencies [d20450e]
- Updated dependencies [d20450e]
- Updated dependencies [d20450e]
- Updated dependencies [d20450e]
- Updated dependencies [d20450e]
  - @cendor/cassette@0.2.6
  - @cendor/contextkit@1.0.6
  - @cendor/core@0.5.0
  - @cendor/guardrails@0.6.0
  - @cendor/squeeze@0.2.6
  - @cendor/tokenguard@0.2.6
  - @cendor/acttrace@0.5.2

## 0.2.10

### Patch Changes

- Updated dependencies [eb92af0]
  - @cendor/guardrails@0.5.0

## 0.2.9

### Patch Changes

- Updated dependencies [524f350]
  - @cendor/guardrails@0.4.0

## 0.2.8

### Patch Changes

- Updated dependencies [6a7d8d7]
  - @cendor/guardrails@0.3.0

## 0.2.7

### Patch Changes

- Updated dependencies [4d26329]
- Updated dependencies [81ce71b]
- Updated dependencies [4d26329]
  - @cendor/acttrace@0.5.1
  - @cendor/guardrails@0.2.0

## 0.2.6

### Patch Changes

- 7679740: Add `@cendor/guardrails` to the umbrella — `@cendor/libs` now installs and re-exports the seventh library (`export * as guardrails`).
- Updated dependencies [7679740]
- Updated dependencies [7679740]
  - @cendor/acttrace@0.5.0
  - @cendor/guardrails@0.1.0

## 0.2.5

### Patch Changes

- Updated dependencies [df3a2a8]
- Updated dependencies [05fdc78]
  - @cendor/acttrace@0.4.0
  - @cendor/core@0.4.0
  - @cendor/cassette@0.2.5
  - @cendor/contextkit@1.0.5
  - @cendor/squeeze@0.2.5
  - @cendor/tokenguard@0.2.5

## 0.2.4

### Patch Changes

- aa12f36: Packaging and docs: ship LICENSE + NOTICE inside each published tarball, add `homepage` and
  `bugs` metadata, and add npm-version + Apache-2.0 badges plus a README banner. No API or runtime
  changes.
- Updated dependencies [aa12f36]
  - @cendor/core@0.3.3
  - @cendor/tokenguard@0.2.4
  - @cendor/contextkit@1.0.4
  - @cendor/squeeze@0.2.4
  - @cendor/cassette@0.2.4
  - @cendor/acttrace@0.3.3

## 0.2.3

### Patch Changes

- 0045081: Plain-language README openers (the tagline npm renders at the top of each package page) — matches the rewritten one-line descriptions. Docs only.
- Updated dependencies [0045081]
  - @cendor/core@0.3.2
  - @cendor/tokenguard@0.2.3
  - @cendor/contextkit@1.0.3
  - @cendor/squeeze@0.2.3
  - @cendor/cassette@0.2.3
  - @cendor/acttrace@0.3.2

## 0.2.2

### Patch Changes

- 0536aae: Plain-language npm package descriptions (metadata only — no code change).
- Updated dependencies [0536aae]
  - @cendor/core@0.3.1
  - @cendor/tokenguard@0.2.2
  - @cendor/contextkit@1.0.2
  - @cendor/squeeze@0.2.2
  - @cendor/cassette@0.2.2
  - @cendor/acttrace@0.3.1

## 0.2.1

### Patch Changes

- Updated dependencies [0092224]
- Updated dependencies [9b7817a]
- Updated dependencies [09d44d2]
  - @cendor/acttrace@0.3.0
  - @cendor/core@0.3.0
  - @cendor/cassette@0.2.1
  - @cendor/contextkit@1.0.1
  - @cendor/squeeze@0.2.1
  - @cendor/tokenguard@0.2.1

## 0.2.0

### Minor Changes

- a703789: Initial release of `@cendor/libs` — the umbrella meta-package that installs all six Cendor libraries
  and re-exports them as namespaces (`core`, `tokenguard`, `contextkit`, `squeeze`, `cassette`,
  `acttrace`), mirroring the Python `cendor-libs` meta-package.

### Patch Changes

- Updated dependencies [94d7d95]
- Updated dependencies [595004d]
- Updated dependencies [911383f]
  - @cendor/squeeze@0.2.0
  - @cendor/tokenguard@0.2.0
  - @cendor/contextkit@1.0.0
  - @cendor/cassette@0.2.0
  - @cendor/acttrace@0.2.0
  - @cendor/core@0.2.0
