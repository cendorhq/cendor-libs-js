---
"@cendor/acttrace": minor
---

Auto-captured `llm_call` / `tool_call` audit entries now take their `run_id` from the event's own
captured `traceId` and their `decision_id` from context captured at call initiation (via the
`@cendor/core` ambient seam), instead of re-reading the ambient run/decision scope at delivery time.
A streamed call finalized outside the originating run/decision scope is therefore still joined to the
right run and chained under the right decision. `budget_event` entries copy the tokenguard
`BudgetEvent.traceId` into `run_id`, so a monitor's dual-key join links a budget action to its run.
Audit-chain payloads are unchanged for in-scope calls (byte-identical); metadata never enters the
chain. Requires `@cendor/core` >= 0.10.0.
