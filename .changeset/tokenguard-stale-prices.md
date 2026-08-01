---
'@cendor/tokenguard': minor
---

`StalePriceTableWarning` — warned **once per process** when a USD budget estimates from a price table
older than 45 days, plus `configure({ onStalePrices, stalePricesAfterDays })` and an
`onStalePricesWarning(listener)` channel (the same shape as `onUnpricedWarning`; a listener may
re-throw to escalate).

A USD cap is only as right as the rates behind it, and the direction matters: after a price *cut* a
stale table over-estimates and the cap binds early, which is conservative; after a price *rise* it
under-estimates and **the cap binds late, so you overspend**. That second case is why this exists.

Nothing is blocked and nothing is re-estimated — it is a signal, not a behaviour change. An
**undatable** table is never called stale: `litellm`, `openrouter` and `vercel` publish no as-of date
at all, and inventing an age would defeat the signal. The fix is `await prices.refresh()`, not a
bigger threshold.
