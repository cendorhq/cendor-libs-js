---
"@cendor/core": minor
---

Emission truth (Monitor v5, G-V4-3): the libs-only `otel.useSpanEmitter()` now stamps
`cendor.usage_estimated="true"` on an emitted `chat` span when a streamed call reported no usage and
the token count was recovered by an offline estimate (`metadata.usage_estimated`). Truth = the
product — a monitor renders those tokens as *est.* rather than the provider's billed figure. Additive;
stamped only when set (a real provider-reported count leaves the span unflagged).
