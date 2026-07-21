---
"@cendor/acttrace": patch
---

fix(otel): emit `llm_call` audit `latency_ms` as a number, not `"[object Object]"`

The audit payload wraps floats in `PyFloat` (for int/float JSON-parity on the JSONL/hash side).
`OTelMirror` stringified that wrapper, so the mirrored `audit.llm_call` span carried
`cendor.audit.latency_ms = "[object Object]"` (the step span's own `latency_ms` was always correct).
`setScalar`/`setInt` and the flat attribute loop now unwrap `PyFloat` to its numeric value before
setting the span attribute. Added the missing `cendor.audit.latency_ms` assertion to the mirror test.
