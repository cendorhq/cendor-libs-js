# @cendor/tokenguard

## 3.1.0

### Minor Changes

- 9380b7d: feat: inject the OpenTelemetry tracer/meter instead of reaching for the global provider

  Three published APIs resolved their pipeline from the OpenTelemetry **global** provider with no
  parameter, so the only way to observe any of them was to install a process-global provider. The
  external black-box suite filed all three as product improvements — its keyless tree had to install
  in-memory global providers for exactly these APIs and no others, purely to assert anything about them.

  ```ts
  import { otel } from "@cendor/core";
  import { OTelSink } from "@cendor/tokenguard/sinks";
  import { useMeter } from "@cendor/guardrails";

  otel.span("gpt-4o", { tracer: myTracer }, (span) => {
    void span;
  });
  useSink(new OTelSink({ meter: myMeter }));
  useMeter(myMeter); // useMeter(null) restores the global default
  ```

  The global provider stays the default in all three, unchanged, and each has a negative control
  asserting it: omit the tracer/meter and the span or counter goes exactly where it went before. Names,
  attributes, and the without-`@opentelemetry/api` no-op are identical on both paths. In
  `OTelSink` an injected meter also skips the lazy re-acquisition — that dance exists because a global
  meter provider can be installed _after_ construction, which cannot happen to a meter you already hold.

  Use it for the three cases the global provider is wrong for: a **test** asserting spans/metrics without
  polluting the process, a **multi-tenant host** with a provider per tenant, and a **second pipeline**
  beside the app's own.

  **Also fixed, in `@cendor/guardrails`: the decisions counter can no longer fail a guardrail.** The
  comment above it has always said "best-effort observability", and the code did not implement that — an
  exception from the counter's `add` propagated out of the gate and took the **governance decision** with
  it. Found while writing the negative control for `useMeter` in the Python twin. A real OpenTelemetry
  counter does not throw, so only a custom or injected meter was ever exposed, but the failure mode is
  exactly backwards for this library: the increment is now guarded and the decision is taken, emitted,
  and chained regardless.

  Python parity: `otel.span(model, tracer=…)` in `cendor-core` 1.16.0, `OTelSink(meter=…)` in
  `cendor-tokenguard` 1.7.0, `guardrails.use_meter(meter)` in `cendor-guardrails` 1.7.0.

### Patch Changes

- 26b9402: fix(tokenguard): load the optional `better-sqlite3` lazily, so `@cendor/tokenguard/sinks` imports without it

  `sinks.ts` carried a **value** import of `better-sqlite3` at module scope. It is an
  `optionalDependency`, which npm silently SKIPS when it cannot be installed — so the whole
  `@cendor/tokenguard/sinks` subpath became unimportable in that case, taking `QueueSink` and
  `OTelSink` (neither of which touches SQLite) down with it.

  Measured 2026-07-31 on a clean `node:20-slim` container, linux-x64:

  ```
  prebuild-install warn install No prebuilt binaries found
    (target=20.20.2 runtime=node arch=x64 libc= platform=linux)
  gyp ERR! find Python  Could not find any Python installation to use
  ...
  Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'better-sqlite3'
    imported from …/node_modules/@cendor/tokenguard/dist/sinks.js
  ```

  `npm install` **succeeds** (a failed optional dependency is skipped), and the failure only appears at
  the first import. The same install succeeds on `node:22-slim`, where a prebuild exists — so the bug
  is green on Node 22 and red on Node 20.

  The fix is the pattern `@cendor/squeeze`'s `store.ts` already used: `import type` plus a
  `createRequire` load inside `SQLiteSink`'s constructor. `SQLiteSink` stays fully typed and behaves
  identically; it now throws only when you actually construct one without the native module installed,
  which is the correct time to find out.

  Pinned by `packages/tokenguard/test/sinks-optional-native.test.ts` — a source-level assertion (a
  value import is a syntactic property) with a negative control that fails when the eager form returns.

- Updated dependencies [9380b7d]
- Updated dependencies [9380b7d]
  - @cendor/core@3.2.0

## 3.0.2

### Patch Changes

- b79abce: **Gemini streaming is captured** — `client.models.generateContentStream` (and the `aio` twin, for
  parity with Python). The `@google/genai` SDK streams through a **separate method**, not a
  `stream: true` kwarg, so it needed its own always-stream detection target — the machinery Bedrock's
  `converseStream` already uses. Until now a streamed Gemini call emitted **nothing at all**: measured
  live 2026-07-31 against a real key, zero `LLMCall`s in both languages.

  One `LLMCall` lands when the stream completes, carrying `metadata.streamed`, with real usage read
  from the **last** usage-bearing chunk — Gemini reports _running totals_ on every chunk, so the
  generic "first usage-bearing chunk wins" rule would have under-counted every stream longer than one
  chunk. `thoughtsTokenCount` folds into output and surfaces as `reasoningTokens`; a stream that
  reports no usage falls back to a flagged offline estimate (`metadata.usage_estimated`); chunks pass
  through unchanged; and the per-chunk stream-observer seam fires, so `@cendor/tokenguard`'s
  `withBudget({ onExceed: 'break' })` cuts a runaway Gemini stream and closes it — pinned by a new
  tokenguard test with a negative control (an under-cap stream is not cut and settles on real usage).

  Also: the `prices.register` JSDoc no longer says Python has no public equivalent — `cendor-core`
  1.15.0 added `prices.register` and `prices.register_model_price`.

  Tests are red-first (5 of 7 fail against the pre-fix tree) and use a **real chunk cadence** rather
  than an instant stub; the built tarball was additionally exercised in `node:20-slim` and
  `node:22-slim` docker, including two **overlapping** streamed runs with different cadences, because
  an async-context test green on node 24 proves nothing about the LTS.

- Updated dependencies [b79abce]
  - @cendor/core@3.1.0

## 3.0.1

### Patch Changes

- 28db282: A post-flight `BudgetExceeded` now names the cap you actually set.

  The message was hardcoded in dollars, so a **token** budget's breach read

  ```
  budget exceeded: spent $0.0140800 > cap $null after 1 call(s); last model=gpt-4o.
  on_exceed='raise' is post-flight … use on_exceed='block' for a pre-flight hard cap …
  ```

  Three defects in one string: a `tokens` cap rendered as money, a literal **`cap $null`** where the
  number belongs, and advice to use the option the caller had **already passed**. Enforcement was never
  affected — but a governance library's exception text is what ends up in an incident channel, and this
  one told the reader nothing true about their cap.

  Now the breach is reported in the dimension that breached (`used 1408 tokens > cap 1000 tokens`), both
  dimensions are reported when a two-dimension budget breaches both (joined with `and`), and
  `onExceed: 'block'` gets its own sentence. `block` **is** pre-flight, so reaching the post-flight check
  means the estimate fitted and the settled usage did not — it now says exactly that and points at
  `outputReserve` / `reasoningReserve` / `onExceed: 'clamp'` instead of at itself.

  Found while writing the `cendor-cookbook` `providers/bedrock` recipe, whose fake returns a small prompt
  and a large completion — the precise shape that slips past a pre-flight token estimate. Reproduced on a
  **priced** model (`gpt-4o`) as well as an unpriced marketplace id, so it was never an unpriced-id
  artefact. Python parity: `cendor-tokenguard` 1.6.2. Five regression tests, three verified failing first.

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
  resolve _different_ copies of core, that is two buses and cooperation stops silently — a guardrail
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

## 0.8.2

### Patch Changes

- Updated dependencies [95c4f39]
  - @cendor/core@0.16.0

## 0.8.1

### Patch Changes

- Updated dependencies [ca57a91]
  - @cendor/core@0.15.0

## 0.8.0

### Minor Changes

- 6c87f98: **Telemetry now flows with zero telemetry code — and `CENDOR_TELEMETRY=off` turns it all off.**

  ⚠️ **This is a default-behaviour change.** If your app has `@opentelemetry/api` installed **and**
  configures a global tracer provider (`NodeSDK.start()`, `useAzureMonitor()`, a plain
  `setGlobalTracerProvider`, an OTLP endpoint pointed at Cendor Monitor…), then after upgrading you will
  start seeing Cendor data in **your** backend without adding a line of code:

  | What appears                                                                                                                | Where it comes from                                                                              | Scope / names                      |
  | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------- |
  | `chat …` / `execute_tool …` spans per governed call                                                                         | `@cendor/core` — the emitter attaches itself at your first `instrument()` (or `otel.ingest()`)   | `cendor.core`, standard `gen_ai.*` |
  | `gen_ai.client.token.usage` / `.cost.usd` / `.reasoning.token.usage` counters, dimensioned by `model` + your `track()` tags | `@cendor/tokenguard` — an **internal additive tap** beside your `useSink` slot                   | meter `cendor.tokenguard`          |
  | `audit.*` spans per chained audit entry                                                                                     | `@cendor/acttrace` — `new AuditLog(...)` auto-attaches an `OTelMirror` when you pass no `mirror` | `cendor.acttrace`                  |

  Nothing else changes: Cendor still has **no endpoint, no exporter and no collector of its own** — it
  emits into the provider _you_ configured. With `@opentelemetry/api` absent, or with no provider
  configured, behaviour is byte-identical to before (not one extra bus subscriber). Prompt/response
  **content stays opt-in** (`otel.captureContent()`). No new identity: the app name is still the OTel
  resource's `service.name`.

  **Turning it off / diagnosing it**

  - `CENDOR_TELEMETRY=off` — process-wide, no code change. Honoured per event, so it applies even if you
    export it late. `OTEL_SDK_DISABLED=true` (the standard switch) composes for free.
  - `CENDOR_DEBUG_TELEMETRY=1` — one stderr line stating the mode, whether a provider was detected, and
    what got wired. Silent otherwise: Cendor never nags an offline app.

  **New in `@cendor/core`'s `otel`**: `telemetryMode()`, `providerConfigured()`, `liveSpansActive()`,
  `autoTelemetryState()` (diagnostics). `useSpanEmitter()` still works and **always wins** — a manual
  attachment detaches the automatic one, so an event is never rendered twice.

  **New in `@cendor/acttrace`**: `new AuditLog(system, { mirror: false })` — "never mirror this log".
  An explicit mirror is used verbatim, and the mirror stays an _operational copy_: the hash-chained file
  (or a signed `export()`) remains the only artifact `verify()` checks.

  **`@cendor/tokenguard`**: the spend tap never touches your `useSink` slot (that slot holds exactly the
  sink you set), and it stands down when your own sink already **is** an `OTelSink` (or a `QueueSink`
  wrapping one) — so an app following the older docs does not double-count spend after upgrading.

### Patch Changes

- Updated dependencies [6c87f98]
  - @cendor/core@0.14.0

## 0.7.0

### Minor Changes

- 06f79a6: **Telemetry truth fixes — attach order and concurrency no longer break the OTel path.**

  Two silent defects, both found by a zero-telemetry-code study against a live monitor, both fixed
  before the auto-wiring work that depends on them. Neither changes an API.

  **`@cendor/tokenguard` — `OTelSink` acquires its meter lazily.** The JS metrics API has no proxy
  provider: before your app calls `metrics.setGlobalMeterProvider` (i.e. before `NodeSDK.start()`),
  `metrics.getMeterProvider()` is a `NoopMeterProvider` and a counter taken from it stays a no-op
  **forever**. Because the sink acquired its counters in the constructor, `useSink(new OTelSink())`
  placed above your OTel setup recorded **zero** datapoints, permanently and silently — an undocumented
  ordering trap (Python was always safe: its providers proxy). The meter is now acquired on `write()`
  and cached only once a real provider answers, so attach order is irrelevant. If your spend counters
  were mysteriously empty, this is why.

  **`@cendor/core` — the live-spans latch is context-local.** `enterLiveSpans`/`exitLiveSpans` (the
  latch that makes the G20 span emitter stand down inside an SDK run) used a module-global counter, so
  **one** open scope suppressed the emitter for **every** concurrent async context in the process: an
  app mixing an SDK run with concurrent libs-only calls silently lost the flat spans for the latter, and
  an unclosed `liveSpans()` handle stuck the latch forever, killing the emitter process-wide. It is now
  `AsyncLocalStorage`-backed (falling back to the old counter off-Node), matching Python's `ContextVar`.
  Signatures are unchanged.

  Also: `bus._subscriberCount()` (a test helper, mirroring Python's `bus._subscriber_count()`).

### Patch Changes

- Updated dependencies [06f79a6]
  - @cendor/core@0.13.0

## 0.6.2

### Patch Changes

- 3487a13: `QueueSink` gains drop observability: an optional `onDropError(error, entry)` constructor callback and a `droppedRows()` counter. A row the inner sink's `write` throws on is now counted (and optionally surfaced) instead of being silently swallowed; the drain worker still survives both a bad row and a broken callback.
- Updated dependencies [3487a13]
  - @cendor/core@0.12.2

## 0.6.1

### Patch Changes

- Updated dependencies [84c2a2b]
  - @cendor/core@0.12.0

## 0.6.0

### Minor Changes

- 3f5b000: Add `onExceed: 'break'` — a **mid-stream budget breaker**. It rides `@cendor/core`'s new
  stream-observer seam to cut a streamed call the instant its running output estimate (visible text +
  visible thinking) crosses the remaining `tokens`/`usd` budget: you keep the partial output already
  yielded, the provider bills to the cut (~one chunk + one RTT — it stops the meter, it does not
  un-bill the provider), and the settled usage is an estimate flagged `usage_estimated`. USD headroom
  is converted to an integer token allowance once per stream; `reasoningReserve` cuts early on
  hidden-thinking models. It also acts as a post-flight cumulative gate (like `raise`) for non-streamed
  calls, and emits a `BudgetEvent` with `action: 'broken'`. Needs `@cendor/core` ≥ 0.11.

  `onExceed: 'clamp'` now injects the output ceiling for **more providers**: nested Bedrock
  `inferenceConfig.maxTokens` and Ollama `options.num_predict` (copy-on-write merged), and a plain-object
  Gemini `config.max_output_tokens`. A typed Gemini `GenerateContentConfig` can't be safely merged and
  falls back to a hard block (as before).

### Patch Changes

- Updated dependencies [3f5b000]
  - @cendor/core@0.11.0

## 0.5.0

### Minor Changes

- 9e1e564: Capture the active budget frames (by reference) and attribution tags **at call initiation** via the
  `@cendor/core` ambient seam, instead of re-reading them at bus-delivery time. A streamed call whose
  stream is drained **after** the `budget()` / `track()` scope exits now still accrues spend, enforces
  the budget, and attributes by tag — previously that spend was silently lost, which also let a
  cumulative cap under `onExceed: 'block'` be overrun (every call in a loop of streamed calls was
  judged against `spent = 0`). `BudgetEvent` gains a `traceId` field (taken from the call the action
  guarded) so a monitor can join a budget action back to its run. Requires `@cendor/core` >= 0.10.0.

### Patch Changes

- Updated dependencies [9e1e564]
  - @cendor/core@0.10.0

## 0.4.3

### Patch Changes

- Updated dependencies [83c0ca7]
  - @cendor/core@0.9.0

## 0.4.2

### Patch Changes

- Updated dependencies [60f2eaf]
  - @cendor/core@0.8.0

## 0.4.1

### Patch Changes

- Updated dependencies [ec4be36]
  - @cendor/core@0.7.0

## 0.4.0

### Minor Changes

- 16e627b: Budget identity + a native governance counter. `budget({ name, description })` gives a budget a human identity that rides every `BudgetEvent` it fires (mirrored by `@cendor/acttrace >= 0.8` as `cendor.audit.budget` / `cendor.audit.description`), so an audit stream / monitor shows _which_ budget acted. Every pre-flight budget action also increments a `cendor.tokenguard.budget.events` counter (meter `cendor.tokenguard`; no-op without OpenTelemetry) — `cendor_tokenguard_budget_events_total` in Prometheus — so budget-block rates are chartable. Both additive and backward-compatible; keep `name` a bounded identifier (it is also a counter label).

## 0.3.0

### Minor Changes

- ea7cfa9: OpenTelemetry observability export.

  - **acttrace**: `new AuditLog(system, { mirror })` + `OTelMirror` stream the audit chain to any OpenTelemetry backend as an operational copy — the hash-chained file stays the sole `verify()` evidence. New `budget_event` entry type; entries carry `otel_trace_id`/`otel_span_id` when a span is active. All no-ops without `@opentelemetry/api`; the default chain is byte-identical.
  - **tokenguard**: `BudgetEvent` (blocked/downgraded/clamped) is emitted on the bus so acttrace chains it and an OTel mirror can alert on it; `OTelSink` now dimensions spend counters by the active `track(...)` tags (`new OTelSink({ tags: false })` for model-only, to bound metric cardinality).

  See https://cendor.ai/docs/observability

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

- d20450e: Deep-QA fix: under `onExceed: 'clamp'`, the provider output ceiling (`max_completion_tokens` / `max_tokens` = the tokens left in the budget) is now **always** injected on a call under a token budget — not only when the 256-token reserve heuristic would breach. A single surprise-long call can no longer overshoot the `tokens=` cap while headroom exists (M1).
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
