---
"@cendor/acttrace": minor
"@cendor/tokenguard": minor
---

OpenTelemetry observability export.

- **acttrace**: `new AuditLog(system, { mirror })` + `OTelMirror` stream the audit chain to any OpenTelemetry backend as an operational copy — the hash-chained file stays the sole `verify()` evidence. New `budget_event` entry type; entries carry `otel_trace_id`/`otel_span_id` when a span is active. All no-ops without `@opentelemetry/api`; the default chain is byte-identical.
- **tokenguard**: `BudgetEvent` (blocked/downgraded/clamped) is emitted on the bus so acttrace chains it and an OTel mirror can alert on it; `OTelSink` now dimensions spend counters by the active `track(...)` tags (`new OTelSink({ tags: false })` for model-only, to bound metric cardinality).

See https://cendor.ai/docs/observability
