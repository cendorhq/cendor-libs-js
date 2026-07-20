---
'@cendor/guardrails': minor
---

A native governance counter. Every emitted `GuardrailDecision` also increments a `cendor.guardrails.decisions` counter on the meter `cendor.guardrails` (a no-op when `@opentelemetry/api` isn't installed), dimensioned by the bounded label sets `guardrail` / `stage` / `action`. Renders as `cendor_guardrails_decisions_total` in Prometheus, so guardrail block/flag rates are chartable per guardrail and stage. Backward-compatible — no change to `GuardrailDecision` or the bus shape.
