---
'@cendor/tokenguard': minor
---

Budget identity + a native governance counter. `budget({ name, description })` gives a budget a human identity that rides every `BudgetEvent` it fires (mirrored by `@cendor/acttrace >= 0.8` as `cendor.audit.budget` / `cendor.audit.description`), so an audit stream / monitor shows *which* budget acted. Every pre-flight budget action also increments a `cendor.tokenguard.budget.events` counter (meter `cendor.tokenguard`; no-op without OpenTelemetry) — `cendor_tokenguard_budget_events_total` in Prometheus — so budget-block rates are chartable. Both additive and backward-compatible; keep `name` a bounded identifier (it is also a counter label).
