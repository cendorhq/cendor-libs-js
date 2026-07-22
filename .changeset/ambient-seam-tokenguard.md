---
"@cendor/tokenguard": minor
---

Capture the active budget frames (by reference) and attribution tags **at call initiation** via the
`@cendor/core` ambient seam, instead of re-reading them at bus-delivery time. A streamed call whose
stream is drained **after** the `budget()` / `track()` scope exits now still accrues spend, enforces
the budget, and attributes by tag — previously that spend was silently lost, which also let a
cumulative cap under `onExceed: 'block'` be overrun (every call in a loop of streamed calls was
judged against `spent = 0`). `BudgetEvent` gains a `traceId` field (taken from the call the action
guarded) so a monitor can join a budget action back to its run. Requires `@cendor/core` >= 0.10.0.
