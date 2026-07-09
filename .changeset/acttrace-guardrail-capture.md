---
"@cendor/acttrace": minor
---

Auto-capture guardrail decisions. When `@cendor/guardrails` is in use, every trip or flag it emits on the `@cendor/core` bus is now chained as a tamper-evident `guardrail_decision` entry (recording the guardrail name, stage, action, and reason — never the raw payload). Captured by **duck typing** (`guardrail`/`stage`/`action` present), so acttrace still imports no sibling tool — the same pattern already used for contextkit's assembly report. No API change; a log with no guardrails in play is byte-identical to before.
