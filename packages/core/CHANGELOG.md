# @cendor/core

## 3.6.0

### Minor Changes

- 44b2bfb: Live pricing: three new `refresh()` sources, a rewritten Azure source, and the visibility layer that
  makes any rate explain itself. Every number below was measured live on 2026-08-01, in both languages,
  with identical results.

  **New sources.** `aws` — the Bedrock **public price files**, Amazon's own billing catalog, keyless,
  dated from `publicationDate`, one region (`region`, default `us-east-1`). It unions **both** offer
  codes, and that is not defensive coding: `AmazonBedrock` alone carries only Claude
  2.0/2.1/3-Haiku/3-Sonnet/Instant — `Claude Sonnet 4` and `4.5` exist **only** in
  `AmazonBedrockService`, so a single-offer client silently misses every current Claude rate. Rate keys
  come from `usagetype`, not `inferenceType`, because Sonnet 4 carries `"Input tokens"` on both the
  standard meter ($3/MTok) and the half-price batch one. `modelsdev` — models.dev (MIT), the widest
  keyless catalog found, per-1M converted exactly, per-row `last_updated` carried through; restricted to
  a first-party provider allowlist because the same id appears under many providers at different prices
  (`gpt-5.1` under 11, $1.07–$1.25/MTok) and the biggest are all resellers. `vercel` — the AI Gateway,
  **resale** prices like OpenRouter's, base rates only, undatable.

  **Azure rewritten.** `serviceName eq 'Foundry Models'`, a **mandatory** region, and pagination. The
  pre-rename `productName eq 'Azure OpenAI'` still returned rows — which is exactly why the coverage
  loss was invisible — but saw 462 of eastus2's 1,526 meters and **no GPT-5, DeepSeek, Grok, Mistral,
  Llama, Phi, Kimi, Qwen or Cohere at all**. End to end: **104 mapped models where the old filter mapped
  23**. Also `opt` is now read as **output** (141 rows spell it that way, so every GPT-5.x family had an
  input rate and no output rate), and batch / fine-tune / provisioned / long-context / media meters are
  excluded rather than winning a cheapest-rate comparison. The region is not an optimisation: unregioned
  the query is >25,000 rows and still paging after 28.5 s.

  **Visibility.** `prices.explain(model)` returns the resolved id, how it resolved, the rates, the
  table's **and the row's** provenance, the age, and honest notes (a registration in effect, a gateway
  resale source, an undatable table, an unpriced model). `prices.save(path)` / `prices.load(path)` are
  explicit, opt-in persistence across processes carrying provenance through — never an implicit cache.
  `refresh(url, { required: true })` throws the new `PriceRefreshError` instead of resolving `false`;
  `refresh()` itself stays contractually never-throw.

  **The default table moved.** `SNAPSHOT_URL` points at the cendor-prices feed — dated, per-row
  provenance, reconciled daily behind validation gates. The bundled snapshot is **generated** from it
  rather than hand-typed: 44 rows becomes 861. The hand-feeding drift goes with it (`gpt-5.6-luna` was
  5× off every other source).

  **A zero input rate is no longer published.** `llama3` (0/0, inherited from litellm) leaves the
  snapshot: it made exactly one local model report a fabricated `$0.00` while every other reported
  `null`, and `estimate()` returning `$0.00` as a _fact_ means a USD cap silently never binds. Say it
  yourself if you mean it: `prices.register('llama3', { input: 0, output: 0 })`.

  Rates are also coerced to `Decimal` at the table swap, so a pass-through `refresh(url)` against a
  table that quotes its rates no longer makes `estimate()` throw.

## 3.5.0

### Minor Changes

- 0a08e89: `bus.hasSubscribers()` — `true` when at least one subscriber is registered.

  It exists so an emitter can skip _building_ an expensive event nobody would receive:
  `@cendor/squeeze` ≥ 3.1.0 gates the two `tokens.count` passes that fill its `CompressionEvent` on
  it (measured at ~93% of a large `compress()` with nothing listening). It answers "is anyone on the
  bus", not "is anyone listening for this event type", and it is advisory: a subscriber registered
  concurrently between the check and the `emit` misses that one event — benign, since the event
  predates its subscription. The private `_subscriberCount()` test helper is unchanged.

## 3.4.0

### Minor Changes

- 61d1565: `prices.registerModelPrice(model, { input, output })` — the per-1M convenience, now on the libraries
  door.

  The helper existed only in `@cendor/sdk`, while Python has had `prices.register_model_price` in
  `cendor-core` since 1.15.0. That was the last pricing asymmetry between the two cores after
  `registerDeployment` landed on both, and it was a documented trap in the making: the libraries-door
  providers page tells you to price a Microsoft Foundry deployment, so a TypeScript app following it
  imported `registerModelPrice` from `@cendor/core` and got nothing. It now resolves.

  Takes the **USD per 1M tokens** numbers a published rate card quotes (`per: '1K' | 'token'` to
  change), stores exact per-token `Decimal`, returns the stored rates, and survives `refresh()` like
  every registration. `per` is narrowed to a union, so the wrong unit string is a compile error whose
  message names the right ones — and the runtime check still covers untyped JS callers.

  Use it when you hold the rate card: a fine-tune, a negotiated rate, or a Foundry deployment serving a
  model the snapshot has no row for (DeepSeek, Mistral, Phi — the snapshot has no rows for those, so
  `registerDeployment(..., { like })` correctly raises rather than guessing). When the deployment serves
  a model that _is_ in the table, `registerDeployment` stays the shorter path.

  `@cendor/sdk`'s `registerModelPrice` is unchanged and still works.

## 3.3.0

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

## 3.2.0

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

- 9380b7d: feat(core): `prices.registerDeployment(name, { like })` — price an Azure/Foundry deployment name

  On Azure and Azure AI Foundry the id a call reports is the **deployment name you chose**, not a model
  id. It is therefore in no price table: `cost` is `null`, `@cendor/tokenguard` records `$0`, and a USD
  budget silently never binds — the blind spot the external black-box suite recorded verbatim as "would
  improve DX". You already know which model the deployment serves; this says so once, instead of making
  you find and re-type a rate card.

  ```ts
  import { prices } from "@cendor/core";
  prices.registerDeployment("prod-gpt4o-eastus", { like: "gpt-4o" });
  prices.estimate("prod-gpt4o-eastus", 1000, { outputTokens: 500 }); // priced like gpt-4o
  ```

  Deliberately **explicit**. This is not the `-preview` / `-latest` alias _guessing_ that was considered
  and rejected — a confidently wrong price is worse than an honest `null` — and nothing is inferred from
  the deployment's name.

  **Copy-at-registration, not a live alias.** `like`'s rates are read now and stored as the deployment's
  own registration, so a later `refresh()` that reprices the base does **not** reprice the deployment
  (call it again to pick that up), and — like every registration — it survives `refresh()` and overrides
  a snapshot row with the same id. The alternative would make a deployment's cost depend on whether its
  base still exists in whatever table was last fetched, and would have to invent an answer when it
  doesn't.

  `like` goes through the same lookup reduction a real call does, so a dated or Bedrock-decorated base id
  works. An unknown `like` **throws `UnknownModelError`** rather than leaving the deployment quietly
  unpriced, which would reproduce the exact silence the function exists to remove. Every rate key is
  copied rather than an enumerated few, so a future rate category cannot be silently dropped.

  Also re-exported as `registerDeployment` from `@cendor/sdk`. Python parity:
  `prices.register_deployment(deployment, like="gpt-4o")` in `cendor-core` 1.16.0.

## 3.1.0

### Minor Changes

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

## 3.0.1

### Patch Changes

- 16de0ab: A redacted Gemini call is now sendable: `Reroute({ messages })` maps back to Gemini's `contents` shape.

  `instrument()` normalizes a **non-array** `contents` — the very common
  `generateContent({ contents: 'summarize…' })` — into one canonical `{role, content}` message, so every
  interceptor sees every provider the same way. `applyReroute` then wrote that message object straight
  back onto `contents`, and `@google/genai` rejects it: `contents` takes a string, a `Content`
  (`{role, parts}`) or a `Part`, never `{role, content}`. So `@cendor/acttrace`'s `guard()`
  redact-before-send scrubbed the payload correctly and then made the call impossible to send — the
  redaction fired, the audit entry chained, and the request raised.

  The back-map mirrors the one `openai_embeddings` already had: **the original request's shape is what
  goes back.** A string input that produced a single text message returns as a string; a `Content`/`Part`
  passes through untouched (an array input is already Gemini-native and the scrub preserved its shape);
  a canonical message becomes `{role, parts: [{ text }]}`, with `assistant`/`model` mapped to Gemini's
  `model` role.

  Only the reroute path changes — a call with no interceptor rewrite, and every other provider, is
  byte-identical to before. Found by the external black-box suite driving a live Gemini key
  (`@cendor/acttrace` finding, severity medium). Reproduced offline: the redacting guard used to hand
  `@google/genai` `[{"role":"user","content":"…"}]`, and now hands it the string it was given.

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

## 0.16.2

### Patch Changes

- 2aa00b2: The provider SDK's own helper methods work under `instrument()` again.

  `openai-node` builds `responses.parse`, `chat.completions.parse` and `runTools` on
  `APIPromise._thenUnwrap`, which derives a **new** promise sharing the fetch `Response` and calls the
  _original's_ `parseResponse` a second time. A fetch body can only be read once, and cendor's capture
  chain parses too — so an instrumented `responses.parse()` threw
  `TypeError: Body is unusable: Body has already been read` and emitted no event. (Below 0.16.1 it
  failed earlier still, with `_thenUnwrap is not a function`, because the accessors were stripped.)
  Measured against the real openai 6.49.0 SDK on the published shelf.

  - That parse step is now memoized on the SDK's own promise, so every consumer — ours and any derived
    promise — shares a single read. Duck-typed, no SDK import, inert on a promise without it.
  - `responses.parse` is **no longer an `instrument()` target**. It was added in 0.16.1 for parity with
    Python, but in this SDK it is a helper _built on_ `create`, so a second target counts one request
    twice; the wrapped `create` already captures it exactly once. Python is the language where `parse`
    POSTs its own request and therefore does need its own target — parity of behaviour, not of
    mechanism. The same reasoning is why `chat.completions.parse` is not a target here either, though
    it is one in `cendor-core` 1.14.2.

  The test that missed this used a fake whose `parse` returned its own promise instead of delegating to
  `create`; the new fixture models the real architecture — one-shot body, memoizing `parse()`,
  re-parsing `_thenUnwrap` — so the defect is expressible offline.

  A third helper, found by surveying the rest of the family rather than stopping at `parse`:
  **`anthropic.messages.stream()` threw under `instrument()`.** It is built on
  `messages.create({...,stream:true}).withResponse()` (`lib/MessageStream.mjs`), and a streamed call
  returned cendor's plain chain, which has no `withResponse` — so an instrumented Anthropic client
  broke the SDK's own streaming helper with
  `AnthropicError: messages.create(...).withResponse is not a function`. Measured on the published
  0.16.1 against the real `@anthropic-ai/sdk` 0.112.5. A streamed call now keeps the accessors too, and
  `withResponse()` hands back the SDK's `response` with **cendor's counting stream** as `data` —
  forwarding the SDK's raw stream would have unbroken the helper while silently counting nothing.
  `openai`'s `chat.completions.stream` was measured in the same sweep and already worked (it delegates
  to `create`).

## 0.16.1

### Patch Changes

- 311e22b: **`instrument()` no longer costs you the provider SDK's response surface.**

  openai-node and anthropic-node return an `APIPromise` — a Promise subclass whose `asResponse()` and
  `withResponse()` are the documented way to read response headers (`x-request-id` for a support
  ticket, rate-limit remaining, `retry-after`). The wrapper was an `async` arrow, and an async
  function's return is always a _native_ Promise, so both methods came back `undefined`. Since
  `instrument<T>(client: T): T` preserves the client type, TypeScript kept insisting they existed: the
  call type-checked and threw at runtime.

  An instrumented client now hands back something that keeps those accessors. `then`/`catch`/`finally`
  stay on cendor's own chain — deliberately, so a **post-flight** block (guardrails' output stage
  raises _after_ the call) still rejects the caller's promise — while every other method is forwarded to
  the SDK's own object. Reading the body twice is safe: the SDKs memoize their parse.

  Plain-promise SDKs (Gemini, Ollama, Hugging Face) are untouched — no proxy, no cost. Pre-flight
  refusals (a tokenguard budget block, an acttrace guard) still **reject** rather than throwing
  synchronously, and `pre()`/interceptors still run in the caller's synchronous frame, so ambient run
  attribution is unchanged.

  **Honest limit:** a **streamed** call still resolves to cendor's wrapped stream (it has to, to count
  chunks), and a **replayed** call has no HTTP response at all — so `asResponse`/`withResponse` are
  available on non-streamed live calls.

  **Also fixed: `responses.parse` is captured.** The Responses structured-output entrypoint issues its
  own request rather than delegating to `create`, so a structured-output call emitted **no event at
  all** — no budget, no audit entry, no test. It is now an instrumented target with the same
  request/response shape as `create` (exactly one `LLMCall` per call), `typeof`-gated so an older SDK
  without it is simply not wrapped. Parity with `cendor-core` 1.14.1.

## 0.16.0

### Minor Changes

- 95c4f39: **`trace()` groups your calls into one trace, and a governance row can finally name the agent it stopped.**

  ### `trace()` is a real span — the behaviour change to read before upgrading

  `trace('id', fn)` used to stamp an ambient id onto every `LLMCall`/`ToolCall` and nothing more, so every
  call inside still arrived as its **own root span**: one logical unit of work became N unrelated traces in
  any backend that groups by trace. Measured against Cendor Monitor on 2026-07-26, a scope around a chat
  call _and_ a tool call produced **two** traces sharing one id — one run, two rows, no parent, its
  governance fanned out to both, and per-run governance counts doubled.

  The scope now brackets its calls with a `cendor.trace <id>` span (instrumentation scope `cendor.core`,
  carrying `cendor.run.id` and `cendor.scope: 'trace'`), so **one scope is one trace**, and each child call
  carries a 1-based `cendor.step`. The ambient id is stamped exactly as before, so correlation by
  `cendor.trace_id` is unaffected. The scope binds through `context.with` — i.e. `AsyncLocalStorage.run()`,
  never `enterWith`, verified in docker on node 20.20 / 22.23 / 24.18.

  Nothing is emitted when there is nobody to emit to (no `@opentelemetry/api`, no configured provider, or
  `CENDOR_TELEMETRY=off`), and **no span is opened inside a `@cendor/sdk` run** — that run already owns its
  trace, so the calls attach to it rather than to a competing root. Nesting is a no-op for the inner scope.

  **If your backend groups by trace id today and you want the old shape**, one switch restores it:
  `CENDOR_TRACE_SPAN=off`, or `trace(id, fn, { span: false })` for a single scope.

  ### `trace()` is now concurrency-correct on Node without any setup

  Correlation fell back to a save/restore module variable unless a host injected a store via
  `installTraceContext`, so two **overlapping** scopes shared one variable: the second scope's id leaked
  into the first's remaining work, and the last to finish left its id behind for everything after. Core now
  installs a real `AsyncLocalStorage` for the trace id by default on Node. `installTraceContext` still
  accepts your own implementation.

  ### Agent identity

  - `gen_ai.agent.id` is emitted on a call span whenever something stamped one — **never** hashed and never
    a placeholder. A name is a label (two apps can share one, and a rename loses that agent's history); an
    id is identity.
  - **New `@cendor/core/agent-ids`**: `bedrockAgentScope({ agentId, agentAliasId, sessionId }, fn)`,
    `openaiAssistantScope({ assistantId, threadId }, fn)` and the generic `agentScope(identity, fn)`,
    mapping the ids those products already own onto `gen_ai.agent.id` / `gen_ai.conversation.id`.
  - `@cendor/core/foundry` also maps its `agentId` onto `gen_ai.agent.id` now (it keeps stamping `agent`, so
    a dashboard grouping on the name dimension does not lose its rows).
  - All three stay **attribution-only**: mapping identity does not make a server-side runtime's tokens or
    cost appear.

  ### `ambientAttrs()` — so a governance record can name its actor

  `applyAmbient` covers everything that _is_ an event. A governance record is not: an audit entry or an
  enforcement decision is built by `@cendor/acttrace` / `@cendor/tokenguard` / `@cendor/guardrails`, which
  must not import the SDK, and so had no way to learn which agent was acting. Measured: **13 of 386**
  governance rows named their agent. `ambientAttrs()` is a **read** of the same registry — core still
  carries no identity of its own — and both core's `governance.*` spans and `@cendor/acttrace`'s
  `OTelMirror` now use it, so a **budget block** (an event with no agent field at all) stops being an
  anonymous row. `OTelMirror` stamps `cendor.audit.agent` / `cendor.audit.agent_id` on **every** entry, not
  just a guardrail decision; the entry's own payload always wins. Nothing about the hash-chained evidence
  file changes — this is the operational copy.

## 0.15.1

### Patch Changes

- 5a01adc: **Fix: the live-spans latch is correct on Node 20 / 22 again — 0.13.0–0.15.0 could leave the span
  emitter suppressed for the rest of the process on those versions.**

  0.13.0 moved the latch to `AsyncLocalStorage.enterWith`, which behaves as that design needed **only on
  Node ≥ 24** (AsyncContextFrame). Measured in docker on 2026-07-25 against node 20.20 and 22.23 (legacy
  AsyncLocalStorage): an `enterWith` **leaks into concurrent flows** and is **not restored by the matching
  exit** — so after any `liveSpans()` scope closed, `liveSpansActive()` stayed true and every later
  libs-only call silently lost its flat span. If you are on Node 20 or 22 with 0.13.0–0.15.0, upgrade.

  The latch now has two mechanisms, each doing what its API shape can actually guarantee:

  - `enterLiveSpans()` / `exitLiveSpans()` — the callback-less pair a hand-closed `liveSpans()` handle
    uses — move a **module counter**: the emitter stands down process-wide while a manual scope is open,
    and the depth is released on close. This is the pre-0.13.0 behaviour, restored, and it is honest about
    what a hand-closed handle can bind to.
  - `otel._withLiveSpansDepth(fn)` (internal) — the **scoped** form the SDK's automatic run scope uses.
    It raises the depth inside `AsyncLocalStorage.run()`, which is correctly scoped on **every** supported
    Node: two concurrent automatic runs never suppress each other's flat spans, and no depth survives a
    run (including one that throws).

  `liveSpansActive()` reports either. Verified on node 20.20 / 22.23 / 24.18 — identical behaviour on all
  three. The parity matrix's claim that the TS latch is "context-local" is corrected accordingly: it is
  context-local for the automatic scope on every version, and process-wide for a manual handle.

## 0.15.0

### Minor Changes

- ca57a91: **Governance is now visible as ordinary telemetry — with no audit object and no `audit.*` vocabulary.**

  Until now the only way a budget block or a guardrail verdict reached your backend was the _audit
  mirror_, so seeing enforcement meant adopting the evidence library. Under the telemetry switch, the
  libraries that **make** those decisions now emit them as plain monitoring spans:

  | Span                            | Scope                                        | Attributes                                                                                                                 |
  | ------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
  | `governance.budget_event`       | `cendor.core` (or `cendor.sdk` inside a run) | `cendor.gov.type/action/budget/scope/model/to_model/projected_usd/cap_usd/projected_tokens/cap_tokens` + `cendor.trace_id` |
  | `governance.guardrail_decision` | same                                         | `cendor.gov.type/guardrail/stage/action/agent/tool` + `cendor.trace_id`                                                    |

  - **The mirror always wins.** `@cendor/acttrace` tells core when an `AuditLog` attaches a mirror that
    emits spans (refcounted, released on `detach()`), and the `governance.*` renderings stand down while
    one is live — so an event never renders twice, and the chained `audit.*` spans stay the richer view.
    A _custom_ mirror that writes elsewhere (a SIEM sink) deliberately does **not** suppress them.
  - **Rule 6 holds by construction:** no `audit.*` span name, no `cendor.audit.*` attribute, nothing
    evidence-shaped. "Audit" keeps meaning the hash-chained file that `verify()` checks.
  - **No `reason` string is emitted.** A guardrail's reason is written by the rule — and by a judge
    _model_ for `rules.llmJudge`, which can paraphrase the payload; the URL rules embed the matched host.
    The audit chain (an artifact you declared) keeps carrying it; these default-on spans do not. A test
    pins that no payload marker can reach any `cendor.gov.*` attribute.
  - `CENDOR_TELEMETRY=off` disables these like everything else; new in core's `otel`:
    `governanceMirrored()` / `governanceMirrorActive()`.

## 0.14.1

### Patch Changes

- 318ec8b: Add `otel._isolateLiveSpans(fn)` — an internal seam the SDK's automatic run scope needs.

  `enterLiveSpans()` mutates the _current_ async context's depth, and an async function's body starts in
  its **caller's** context, so a scope opened inside `run()` bound the caller while the matching close
  (after an `await`) bound only the resumed continuation. The caller was left latched: its later
  libs-only calls silently lost their spans, and two concurrent runs shared one latch (the second seeing
  "a scope is already open" and emitting no root). This runs a callback with the depth isolated, so the
  automatic scope is airtight. The public `enterLiveSpans`/`exitLiveSpans` API is unchanged.

## 0.14.0

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

## 0.13.0

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

## 0.12.2

### Patch Changes

- 3487a13: `instrument()` now detects a boto-shaped `converse_stream` as an always-stream Bedrock target, routed through the existing Bedrock stream/usage branches — closing the last undocumented `instrument()` detection asymmetry with the Python library. The public provider stays `bedrock`; the response object's `stream` member is wrapped and handed back unchanged, so `for await (const e of response.stream)` still works.

## 0.12.1

### Patch Changes

- db14433: Fix: `@cendor/core/openai-agents` now stamps the agent name on **live** calls. The OpenAI Agents SDK runs each model call in an async context isolated from the lifecycle listeners, so the `AsyncLocalStorage` set in a listener never reached the call — the name was silently dropped live (the offline fixture passed because it drove listeners + call in one context; `instrument()` always captured the call with real usage, so "the calls ride the standard client" held — only the name was missing). Now tracks the active agent in a process-wide holder read live at event construction. **Honest limit:** correct for sequential runs + handoffs (the common case); concurrent `runner.run()` in the same process may cross-attribute during overlap (per-run scoping is impossible — the SDK isolates the call's context from the listeners; run concurrent multi-agent workloads in separate processes). `@cendor/core/foundry` is unaffected (its `foundryAgentScope` is a synchronous callback wrap).

## 0.12.0

### Minor Changes

- 84c2a2b: Framework agent-name adapters — two optional integrations that source a third-party framework's agent identity onto the bus, mirroring the shipped `@cendor/core/langchain` handler. Core carries no identity of its own; the framework owns the name, these adapters carry it. Additive — importing an adapter registers no ambient provider (the zero-provider fast path holds until you attach).

  - **`@cendor/core/openai-agents`** (`observeOpenAIAgents(runnerOrAgent)`) — attach to the OpenAI Agents SDK's `Runner`/`Agent`; stamps the framework's agent name per turn (set at `agent_start`/`agent_handoff`, cleared at `agent_end`) via `AsyncLocalStorage.enterWith`. The agent's model calls ride the standard OpenAI client, so `instrument()` still captures tokens/cost/streaming — this supplies only the name (GLR-11c). Returns a disposer; optional peer `@openai/agents`.
  - **`@cendor/core/foundry`** (`observeFoundryAgents(client)` + `foundryAgentScope(agentId, threadId, fn)`) — a correlation adapter for Azure AI Foundry Agents. Wraps `client.runs.{create,createAndPoll,createThreadAndRun}` to stamp `agent` + `conversation_id` for the run's duration. **Attribution only** — the model runs server-side, so no per-step token/cost (documented honest limit). Duck-typed on `.runs` (no `@azure/ai-agents` import needed to import the adapter); optional peer `@azure/ai-agents`.

## 0.11.0

### Minor Changes

- 3f5b000: Add a per-chunk **stream-observer seam** (`addStreamObserver`/`removeStreamObserver`): register
  `fn(call, deltaText, deltaThinking)` on every instrumented stream; **throwing aborts the stream**
  (closes the underlying provider stream, finalizes the `LLMCall` once with the partial estimated
  usage, re-throws) — interceptor discipline, with a zero-observer fast path (one length check per
  chunk). This is the generic seam `@cendor/tokenguard`'s mid-stream budget breaker
  (`budget({ onExceed: 'break' })`) rides; core learns no budget vocabulary.

  Streamed usage estimation now also counts **visible** thinking (Anthropic `thinking_delta`, Ollama
  `message.thinking`, OpenAI-compat `reasoning_content`, Bedrock `reasoningContent`) into output +
  reasoning — narrowing the documented limit from "can't see thinking" to "can't see _hidden_
  thinking". `closeUnderlying` now also aborts the SDK stream's fetch controller when present.

## 0.10.0

### Minor Changes

- 9e1e564: Add the ambient metadata seam — the one core-owned pre-emit capture point. `addAmbientProvider(fn)` /
  `removeAmbientProvider(fn)` register a `(event) => metadata | undefined` provider that runs at every
  event's construction (the caller's synchronous frame, before interceptors), merging its metadata onto
  `event.metadata` with never-throw / never-overwrite / registration-order semantics and a zero-provider
  single-length-check fast path. This is how a library (or app) attaches run context — agent,
  conversation id, budget frames, cassette session — at the moment it is unconditionally correct,
  instead of re-reading async-local storage at bus-delivery time (which breaks for streams finalized
  outside the originating scope, context-losing layers, subscriber order, and concurrent runs).

  Also: `otel.ingest()` now stamps the ambient `traceId` at construction so an ingested call joins its
  run; the libs-only span emitter maps `metadata.agent` → `gen_ai.agent.name`; and the LangChain
  callback handler stamps the agent/chain/LangGraph-node name into `metadata.agent` (explicit
  `metadata.agent` wins). No shape change to `events/1` — everything rides the sanctioned `metadata`
  extension point.

## 0.9.0

### Minor Changes

- 83c0ca7: `otel.span()` now makes its span the **active context span** for the duration of the callback (via
  `startActiveSpan`, parity with Python's `start_as_current_span`). Downstream reads of the active
  span — notably `@cendor/acttrace`'s audit-entry correlation — now see it and stamp its trace id, and
  child spans created inside the callback nest under it. Unchanged when `@opentelemetry/api` is absent
  (still a no-op that runs the callback with `null`) or when no OTel context manager is registered
  (the callback runs; the span is simply not propagated). No API change.

## 0.8.0

### Minor Changes

- 60f2eaf: Emission truth (Monitor v5, G-V4-3): the libs-only `otel.useSpanEmitter()` now stamps
  `cendor.usage_estimated="true"` on an emitted `chat` span when a streamed call reported no usage and
  the token count was recovered by an offline estimate (`metadata.usage_estimated`). Truth = the
  product — a monitor renders those tokens as _est._ rather than the provider's billed figure. Additive;
  stamped only when set (a real provider-reported count leaves the span unflagged).

## 0.7.0

### Minor Changes

- ec4be36: Opt-in content capture, a libs-only span emitter, and TTFT (Monitor v3 emission wave).

  - **Opt-in content capture (OFF by default)** — `otel.captureContent({ mask, maxBytes })` and the standard `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` env var export prompts/responses/thinking/tool values onto the semconv content span attributes (`gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.system_instructions`). A `mask` scrubs before export (fail-closed if it throws); `maxBytes` caps each attribute with a truncation marker. Content never enters the acttrace evidence chain (rule 6). Helpers `otel.contentAttrs(...)` / `otel.toolContentAttrs(...)`.
  - **`otel.responseMessages(call)`** — best-effort per-provider parse of assistant output into text + thinking parts (the content provider `parse()` drops).
  - **`otel.useSpanEmitter()`** — an opt-in bus→span subscriber emitting a `chat`/`execute_tool` semconv span per event, so a libs-only app lights up a trace-based monitor. Defers to an active SDK `liveSpans` (no double spans) via `otel.enterLiveSpans()`/`exitLiveSpans()`.
  - **TTFT** — streamed calls stamp `metadata.ttft_ms`, surfaced as `cendor.ttft_ms` on emitted chat spans.

## 0.6.1

### Patch Changes

- 60bd02d: Fix: `instrument()` no longer throws on clients whose task methods are non-writable, non-configurable own properties — notably `@huggingface/inference` v3+, whose `InferenceClient` defines every method with `Object.defineProperty(this, name, { value })`. Such a method can't be replaced in place (assignment raises `TypeError: Cannot assign to read only property 'chatCompletion'`), which crashed the whole Hugging Face path in JS. `instrument()` now falls back to a lightweight Proxy that serves the wrapped method (identity and in-place patching are unchanged for every other client), so HF capture works and the "unknown clients are returned untouched" contract holds even when patching fails.

## 0.6.0

### Minor Changes

- b774bd0: Embeddings capture, Usage arithmetic, and a survive-refresh price registry — the core half of the SDK↔lib inheritance fixes.

  - **`instrument()` now captures `embeddings.create`** on openai-shaped clients (OpenAI + Azure-via-openai): the pre-flight interceptor pass runs (budget block/clamp and guard redact-before-send now apply to embedding calls — a `Reroute({ messages })` maps back to the raw `input` shape), and the emitted `LLMCall` carries `metadata.embedding = true`, usage from `response.usage`, and cost from the price table. Embeddings leave the documented capture-gaps list.
  - **`sumUsage(usages)`** — field-complete `Usage` aggregation next to `sumMoney`: iterates the instances' own numeric fields, so a future `Usage` field can never silently vanish from an aggregate.
  - **`prices.register` registrations now survive `prices.refresh()`** — re-applied after every table swap instead of being dropped.
  - The bundled price snapshot gains the OpenAI embedding rows (`text-embedding-3-small` $0.02/1M · `text-embedding-3-large` $0.13/1M · `text-embedding-ada-002` $0.10/1M — verified on the official model pages), so USD budgets bind on embedding calls out of the box.

## 0.5.2

### Patch Changes

- a08a73d: Model-currency patch. The bundled price snapshot is regenerated for the current model generation
  (every rate verified against the official provider pricing pages, `_updated` 2026-07-11): adds the
  OpenAI gpt-5.x line, Anthropic claude-fable-5 / claude-mythos-5 / claude-sonnet-5 (standard
  post-2026-09-01 rate; intro rate noted in `_note`) / opus-4-7/-4-6/-4-5, Gemini 3.x, and xAI
  grok-4.3 / grok-4.5; corrects claude-haiku-4-5 to the official $1/$5 (+ $0.10 cache read / $1.25
  5m write) and the Gemini 2.5 cache-read rates; removes the dead gemini-2.0-flash / gemini-1.5-pro
  rows. Wire-level model ids now normalize at price lookup, so Bedrock modelIds
  (`anthropic.…-v1:0`, `us.`-region profiles) and dated Anthropic / OpenAI snapshot ids price like
  their base model instead of yielding a null cost — unknown models still throw.

## 0.5.1

### Patch Changes

- 3ae2af6: AI-assistant onboarding: inline Type Teach now ships in every package — `@example` + correct-shape JSDoc on public symbols, the `budget(cfg, fn): never` decoy overload (the wrong shape is a compile error), Literal-narrowed string params, and `@deprecated` casing aliases — plus the bundled `INTEGRATION.md`. No runtime behavior change for correct code; the wrong call-shape just fails to typecheck with a message stating the right one. Full trap sheet: https://cendor.ai/docs/for-ai-assistants

## 0.5.0

### Minor Changes

- d20450e: Deep-QA fixes: token accuracy for the open/hosted-model class + Gemini capture.

  - Non-OpenAI / unrecognized models — llama, mistral, deepseek, qwen, new o-series ids (`o5-mini`), and OpenAI fine-tunes (`ft:gpt-4o:*`) — now count via the `o200k` BPE proxy (`bpe-estimate`), exactly like Claude/Gemini, instead of the character heuristic. **This changes token counts** for the whole open/hosted-model class (hence a minor). The o-series match is generalized (`^o\d`) and an `ft:` fine-tune strips to its base model, counting `exact` (H2).
  - Gemini usage/cost capture in `instrument()` now reads the real `@google/genai` **camelCase** `usageMetadata` keys (`promptTokenCount`/`candidatesTokenCount`/`thoughtsTokenCount`), with a snake_case fallback, on both the non-streaming and streaming paths — previously `usage`/`cost` came back `null` (H3).

## 0.4.1

### Patch Changes

- 3b517c3: acttrace: `AuditLog(path)` no longer truncates an existing log on construction. It now opens the file in append mode and resumes the hash chain from the last on-disk entry instead of restarting from genesis and overwriting prior entries — a silent data-loss bug that broke long-term retention. A reopen is a pure resume (no new `audit_open` marker, existing entries preserved, `verify()` spans the full chain); a fresh log is unchanged; a corrupt/unparseable tail throws instead of silently restarting. `export()` still truncates as before.

  core: eagerly warm the default `o200k_base` token encoder at module import so the first guarded pre-flight (or first `tokens.count`) in a process no longer pays the one-time js-tiktoken encoder build. Pure optimization — the warm-up is once-guarded and never throws.

## 0.4.0

### Minor Changes

- 05fdc78: Add a LangChain.js / LangGraph callback handler at the `@cendor/core/langchain` subpath.

  `CendorCallbackHandler` mirrors the Python handler: attach it via `callbacks: [...]` and it records
  usage (including reasoning + cache breakdowns from LangChain's `usage_metadata`), prices each call
  offline, emits normalized `LLMCall` / `ToolCall` events on the bus, and correlates multi-node /
  multi-agent runs by walking the callback run tree to a shared root-run `traceId`. It is
  **recording-only** — post-call, so it never enforces (use the provider SDK with `instrument()` for
  pre-flight budget/redaction).

  `@langchain/core` is an **optional** peer dependency, lazy-loaded; importing the subpath without it
  throws a clear install error.

## 0.3.3

### Patch Changes

- aa12f36: Packaging and docs: ship LICENSE + NOTICE inside each published tarball, add `homepage` and
  `bugs` metadata, and add npm-version + Apache-2.0 badges plus a README banner. No API or runtime
  changes.

## 0.3.2

### Patch Changes

- 0045081: Plain-language README openers (the tagline npm renders at the top of each package page) — matches the rewritten one-line descriptions. Docs only.

## 0.3.1

### Patch Changes

- 0536aae: Plain-language npm package descriptions (metadata only — no code change).

## 0.3.0

### Minor Changes

- 9b7817a: instrument(): detect four more providers — HuggingFace (`chatCompletion`, checked first), Ollama
  (callable `chat`), google-genai (`models.generateContent`, sync + async, plus the legacy
  `generateContent` with a model default), and Bedrock (`converse`). Per-provider usage + streaming
  extraction added. (Bedrock note: aws-sdk v3 uses `client.send(new ConverseCommand(...))` which can't
  be duck-typed, so auto-detection matches only a boto-shaped `converse()` method — see the code
  comment; first-class aws-sdk-v3 support rides the SDK provider.)

  New `otel` module: `span(model, opts, fn)` opens an OpenTelemetry GenAI span (a no-op that still runs
  `fn(null)` when `@opentelemetry/api` — a new optional peer dep — is absent) and `ingest(attrs)` emits
  a priced `LLMCall` on the bus from `gen_ai.*` attributes (no OTel dependency).

### Patch Changes

- 09d44d2: instrument(): the streaming proxy now forwards the full SDK stream surface. The wrapped value is a
  `Proxy` that keeps usage-capturing iteration while forwarding every other member (`.tee()`,
  `.controller`, `.response`, `.finalMessage()`, `.close()`, `Symbol.asyncDispose`, …) to the
  underlying provider stream, and finalizes the `LLMCall` exactly once — on iterate-to-exhaustion or
  early close/dispose.

## 0.2.0

### Minor Changes

- 911383f: Initial release of `@cendor/core` — the TypeScript port of `cendor.core`. Cross-language vocabulary
  (`Money`, `Usage`, `LLMCall`, `ToolCall`), event bus, decimal-safe prices (`prices/1`), token
  counting via `js-tiktoken`, and `instrument()` for the OpenAI (Chat Completions + Responses) and
  Anthropic JS SDKs, including streaming, interceptors (record/replay), and `Reroute`. Verified against
  golden conformance vectors generated from the Python reference implementation.
