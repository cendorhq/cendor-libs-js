---
'@cendor/core': minor
---

A NEGATIVE price rate is refused, not multiplied — and the refusal now names the value it found.

`prices/1` never said a rate must be non-negative, and the library happily multiplied one. Measured
on the published 3.7.0: `prices.register('neg', { input: -1, output: -1 })` then
`estimate('neg', 1_000_000, { outputTokens: 1_000_000 })` returned **-2000000**. That is worse than
the fabricated `$0.00` this line of work exists to remove, not merely equal to it: a zero rate makes
a USD `budget(...)` cap **fail to bind**, while a negative one **un-binds** it — the spend counter
goes *down*, so a negative-rate model pays for other calls and every call moves the cap further from
firing.

Two refusals, at the two reachable entrances:

- NEW `prices.InvalidRateError` from `register` / `registerModelPrice` / `registerDeployment` when any
  rate is negative, at the call that stated it — matching `registerDeployment({ like })`, which
  already fails at registration rather than on the first call, and leaving nothing in the table for a
  later `estimate()` to multiply.
- `MissingRateError` from `estimate()` for a **table** row stating a negative on *any* of `input` /
  `output` / `cached` / `cache_write`. No spec fallback rescues a rate that would subtract money, so
  unlike the zero rule there is no registered-value carve-out to make — `register()` refuses one
  outright, so a negative can only have arrived from a table.

A registered **zero** is still honoured, and that is not an inconsistency:
`prices.register('llama3', { input: 0, output: 0 })` still prices a local model free, because a zero
is a price some models really have and a user registration outranks any table. No model ever cost a
negative amount to call.

The message names the rate it saw. It said *"the price table states a **zero** INPUT rate"* for a
`-1`, so a reader would grep their own table for a `0`, never find one, and conclude the error was
wrong about their data. It now says *"states a negative INPUT rate of -1"*.

Reachable only through the two paths that are deliberately **not** mappers — `register*()` and a
pass-through `refresh(url)` / `load()` table. Every mapped `refresh({ source })` already drops
`input <= 0`, and the feed builder's own G2 already fails a negative rate; that asymmetry — the
producer refusing to publish what the consumer would happily multiply — is what made this a real gap
rather than a curiosity. **OpenRouter is where a negative comes from:** it serves `-1` as its "the
price depends on which model gets routed" sentinel on `openrouter/auto`, `auto-beta`, `bodybuilder`,
`fusion` and `pareto-code` — the *model-router* case that is never priceable.

Spec: `cendor-libs/docs/specs/price-dataset.md`, a second *Changed 2026-08-02* note. The version
string stays `prices/1`: same keys, same types, same optionality, and a reader that refuses where it
used to multiply is strictly more conservative. Python parity: `cendor-core` 1.21.0.

Also in this release — **the bundled snapshot no longer carries a cache rate taken from a different
PRICE TIER.** Regenerated from the 2026-08-02 feed after a `cendor-prices` reconciler fix: same 849
rows, eight rate keys move, six of which were shipping wrong numbers. `reconcile()` filled a rate key
the winning source is silent about without checking the donor prices the model at the same tier, so
on a model served at two tiers it bolted the cheap tier's rate onto the dear tier's row —
`deepseek-v4-pro` is $1.74/1M input (azure, first-party) and its published cache read came from a
$0.435-tier row, a 480x discount no vendor offers. Now `deepseek-v4-pro.cached` **gains** the dear
tier's own $0.145/1M (the correct donor was loaded all along and not chosen), `glm-5.cached` corrects
$0.138 → $0.20 per 1M, and six keys are **withheld** rather than published wrong —
`deepseek-v3.cached` + `.cache_write`, `deepseek-v4-pro.cache_write`, `glm-4.7.cache_write`,
`qwen3-coder-next.cached`, `qwen3-235b-a22b-thinking-2507.cached`. Three of those were
`cache_write: 0`, a **fabricated free cache write**. A withheld key falls back to the rate `prices/1`
states (cache reads at the input rate, cache writes at 1.25x input), so those rows now
**over**-estimate a cached call instead of under-estimating it. If you price cache reads or writes on
any of those seven models your figures moved; every other model, and every input/output rate, is
untouched.
