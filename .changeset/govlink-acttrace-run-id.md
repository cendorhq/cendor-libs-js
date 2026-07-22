---
"@cendor/acttrace": minor
---

Audit entries now carry `@cendor/core`'s ambient run id (`currentTraceId()`, set by the SDK's
`trace(runId)` scope) as a `run_id` payload field, exposed by `OTelMirror` as `cendor.audit.run_id`.
This lets an observability tool join a governance event to its run even when no OpenTelemetry span
was active at append time (e.g. a post-hoc `spanTree` run, or an app with no context manager) — the
fallback correlation alongside the existing `otel_trace_id`. No-op outside a run scope
(`currentTraceId()` is `''`), so the default chain stays byte-identical and matches the Python
implementation. No API change.
