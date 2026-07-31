# @cendor/contextkit

## 3.1.0

### Minor Changes

- a9f335e: First-class aws-sdk-v3 Bedrock capture, the output gate's helper-method escape closed, and the
  interceptor chain's ordering contract corrected.

  **`instrument()` now detects an aws-sdk-v3 `BedrockRuntimeClient`.** This was the most surprising
  capture gap in the JS port and the external black-box suite filed it as a challenge on _every_ run: v3
  exposes no `client.converse(...)`, so a libs-only TypeScript Bedrock app got **zero** capture — no
  budget, no guard, no audit, no cassette, measured at 0 `LLMCall`s. `send` is shared by every AWS
  command, so the capture is keyed on two things: the client is identified once
  (`config.serviceId === 'Bedrock Runtime'`, measured to be a plain synchronously-readable string on
  `@aws-sdk/client-bedrock-runtime` 3.1100.0) and the command per call. `ConverseCommand` and
  `ConverseStreamCommand` are captured; **everything else passes through completely untouched and emits
  nothing** — another AWS command, a non-Bedrock client, or `InvokeModelCommand` (deliberately excluded:
  its body is opaque per-model JSON, so any usage reading would be a guess). Pre-flight governance rides
  it — a budget block issues zero HTTP requests, and a `guard()` redaction is written back onto
  `command.input`, which is both writable and replaceable. `@cendor/sdk`'s synthetic `converse()`
  provider still works and **cannot double-count**: a `send` reached from inside another instrumented
  call stands down. Stop writing the `converse()` shim the old docs recommended.

  **A post-flight output guardrail now fires for a response consumed through an SDK helper method.**
  `openai-node` builds `responses.parse` / `chat.completions.parse` / `runTools` on
  `create(...)._thenUnwrap(...)`, and the same response that was **blocked** when awaited directly
  **resolved** when reached that way — so a `withStructuredOutput()` call delivered banned text. It had
  been documented OPEN with the mechanism unexplained, which is why an earlier attempt had not closed
  it. Measured: the gate _did_ run and _did_ decide `block` (a `GuardrailDecision keyword_deny:block`
  was on the bus every time), and its exception rejected core's capture chain — which core deliberately
  marks handled so a `withResponse()`-only caller gets no noisy unhandled-rejection warning. But
  `_thenUnwrap` derives a new promise from the **SDK's own** object, so the promise the caller awaited
  had never touched that chain. The gate was never the problem; the promise was. Core now gates the
  derived promise (recursively, since these chain), while `asResponse()` and a nested `_thenUnwrap` stay
  reachable and an ungated call is untouched.

  **A `Reroute` no longer ends the interceptor chain; only a returned response does.** A recorded
  response (cassette's replay) means the provider is never called, so nothing is left to rewrite and
  stopping is right — but a `Reroute` still goes to the provider, so every remaining interceptor must
  still be consulted, and against the rerouted call. Before this, the first interceptor that rewrote a
  request silently skipped every one after it, and what you lost was silent and in the dangerous
  direction: measured, a `tokenguard` clamp registered before an `acttrace.guard()` sent the PII to the
  provider **unredacted**, and the reverse order left the token cap **silently unbound**. Which one you
  lost depended on registration order, which a user has no way to observe. Reroutes now compose in
  registration order (later wins on the same field) and a raise still stops everything.

  **Fixed: `Reroute({ model })` lands on the provider's own model kwarg — `modelId` on Bedrock's Converse
  API.** It was assigned generically, so on Bedrock the rewrite went to a `model` member Converse does
  not have and the provider billed the **original, expensive** model while the `LLMCall`, the budget
  ledger and the audit chain all recorded the cheap one. `onExceed: 'downgrade'` did not downgrade on
  Bedrock. Found while analysing the ripple of the v3 work, not from a report.

  **`@cendor/contextkit`: `new Context({ onMissingCompressor: 'note' | 'warn' | 'error' })`.** A block
  asking for `evict: 'compress'` with no compressor available is **truncated** instead — a different
  operation, not a slightly worse one: it discards content and gives you no `Handle` to `.expand()`. It
  was always recorded as a note on the `BlockDecision`, and a note nobody reads is how a forgotten
  `@cendor/squeeze` quietly degraded every compress block while the assembly still reported success.
  **The default is `'note'`, i.e. unchanged.** It fires only when the compressor is genuinely missing — a
  block that asked for `truncate`, or one that fitted the budget, is untouched in every mode.

### Patch Changes

- Updated dependencies [a9f335e]
  - @cendor/core@3.3.0

## 3.0.1

### Patch Changes

- Re-pinned to `@cendor/core@^3.0.0` so the whole family resolves one core. `@cendor/contextkit`
  was already on major 3 and stays there — see the shared-major note in the sibling packages and
  https://cendor.ai/docs/languages#versioning-and-support.

## 3.0.0

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
  - @cendor/squeeze@1.0.0

## 2.0.9

### Patch Changes

- Updated dependencies [95c4f39]
  - @cendor/core@0.16.0

## 2.0.8

### Patch Changes

- Updated dependencies [ca57a91]
  - @cendor/core@0.15.0

## 2.0.7

### Patch Changes

- Updated dependencies [6c87f98]
  - @cendor/core@0.14.0

## 2.0.6

### Patch Changes

- Updated dependencies [06f79a6]
  - @cendor/core@0.13.0

## 2.0.5

### Patch Changes

- Updated dependencies [84c2a2b]
  - @cendor/core@0.12.0

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

> Note: the jump to `2.0.0` was an automatic **major** bump emitted by changesets — **not** a breaking
> API change. The `@cendor/squeeze` peer dependency was versioned out of its previous `^0.2.x` range at
> `0.3.0`, and with `onlyUpdatePeerDependentsWhenOutOfRange` that forces a major on the dependent. The
> public `@cendor/contextkit` API is unchanged. Versions are independent per-language (see the parity
> page), so a `2.0.0` alongside `0.x` siblings is expected. (Same shape as the `1.0.0` note below.)

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
