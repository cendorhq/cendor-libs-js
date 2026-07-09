---
"@cendor/acttrace": patch
---

`guardrail_decision` chain entries now capture the decision's `metadata`, so a guardrail's provenance is recorded as tamper-evident evidence — notably `@cendor/guardrails`' `loadPolicy()` stamps `policy_hash` / `policy_version`, letting an audit prove which policy was active. Still duck-typed (no sibling import); `metadata` defaults to `{}`, so a chain with no metadata is byte-identical to before. A patch so `@cendor/sdk`'s existing `^0.5.0` caret picks it up without an SDK dep bump.
