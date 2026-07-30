---
'@cendor/tokenguard': patch
---

A post-flight `BudgetExceeded` now names the cap you actually set.

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
dimensions are reported when a two-dimension budget breaches both (joined with ` and `), and
`onExceed: 'block'` gets its own sentence. `block` **is** pre-flight, so reaching the post-flight check
means the estimate fitted and the settled usage did not — it now says exactly that and points at
`outputReserve` / `reasoningReserve` / `onExceed: 'clamp'` instead of at itself.

Found while writing the `cendor-cookbook` `providers/bedrock` recipe, whose fake returns a small prompt
and a large completion — the precise shape that slips past a pre-flight token estimate. Reproduced on a
**priced** model (`gpt-4o`) as well as an unpriced marketplace id, so it was never an unpriced-id
artefact. Python parity: `cendor-tokenguard` 1.6.2. Five regression tests, three verified failing first.
