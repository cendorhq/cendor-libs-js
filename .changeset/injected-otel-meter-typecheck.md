---
'@cendor/tokenguard': patch
'@cendor/guardrails': patch
---

Accept a real OpenTelemetry `Meter` where meter injection is documented.

`OTelSink({ meter })` and `useMeter(meter)` declared their counter's `add` as a **property** holding
a function. A property's parameters are checked contravariantly under `strictFunctionTypes`, so
`Record<string, unknown>` would not accept OTel's `Attributes` — and passing a genuine `Meter` was a
compile error in TypeScript, on a feature that exists for no other purpose. Runtime was always
correct; only the type was wrong.

`add` is now declared as a **method**, whose parameters are checked bivariantly. No runtime change,
no behaviour change, and every existing call still compiles.

This is the injection path named by the "Assert spans/metrics without a global provider" trap row —
the way to read the counters without installing a process-global provider. Found by typechecking the
TypeScript cookbook against the published packages, and pinned by
`type-tests/injected-otel-meter.ts` so it cannot silently re-open.
