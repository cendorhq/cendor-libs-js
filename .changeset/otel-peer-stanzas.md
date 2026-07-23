---
"@cendor/acttrace": patch
"@cendor/guardrails": patch
---

Declare `@opentelemetry/api` as an **optional** peer dependency (matching `@cendor/tokenguard`), so
the OpenTelemetry mirror / native counters resolve a compatible version when OTel is installed and
stay a clean no-op when it isn't. No runtime behavior change.
