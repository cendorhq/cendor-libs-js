---
"@cendor/core": minor
---

`otel.span()` now makes its span the **active context span** for the duration of the callback (via
`startActiveSpan`, parity with Python's `start_as_current_span`). Downstream reads of the active
span — notably `@cendor/acttrace`'s audit-entry correlation — now see it and stamp its trace id, and
child spans created inside the callback nest under it. Unchanged when `@opentelemetry/api` is absent
(still a no-op that runs the callback with `null`) or when no OTel context manager is registered
(the callback runs; the span is simply not propagated). No API change.
