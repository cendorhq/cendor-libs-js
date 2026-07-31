---
'@cendor/core': minor
'@cendor/tokenguard': minor
'@cendor/guardrails': minor
---

feat: inject the OpenTelemetry tracer/meter instead of reaching for the global provider

Three published APIs resolved their pipeline from the OpenTelemetry **global** provider with no
parameter, so the only way to observe any of them was to install a process-global provider. The
external black-box suite filed all three as product improvements — its keyless tree had to install
in-memory global providers for exactly these APIs and no others, purely to assert anything about them.

```ts
import { otel } from '@cendor/core';
import { OTelSink } from '@cendor/tokenguard/sinks';
import { useMeter } from '@cendor/guardrails';

otel.span('gpt-4o', { tracer: myTracer }, (span) => { void span; });
useSink(new OTelSink({ meter: myMeter }));
useMeter(myMeter);   // useMeter(null) restores the global default
```

The global provider stays the default in all three, unchanged, and each has a negative control
asserting it: omit the tracer/meter and the span or counter goes exactly where it went before. Names,
attributes, and the without-`@opentelemetry/api` no-op are identical on both paths. In
`OTelSink` an injected meter also skips the lazy re-acquisition — that dance exists because a global
meter provider can be installed *after* construction, which cannot happen to a meter you already hold.

Use it for the three cases the global provider is wrong for: a **test** asserting spans/metrics without
polluting the process, a **multi-tenant host** with a provider per tenant, and a **second pipeline**
beside the app's own.

**Also fixed, in `@cendor/guardrails`: the decisions counter can no longer fail a guardrail.** The
comment above it has always said "best-effort observability", and the code did not implement that — an
exception from the counter's `add` propagated out of the gate and took the **governance decision** with
it. Found while writing the negative control for `useMeter` in the Python twin. A real OpenTelemetry
counter does not throw, so only a custom or injected meter was ever exposed, but the failure mode is
exactly backwards for this library: the increment is now guarded and the decision is taken, emitted,
and chained regardless.

Python parity: `otel.span(model, tracer=…)` in `cendor-core` 1.16.0, `OTelSink(meter=…)` in
`cendor-tokenguard` 1.7.0, `guardrails.use_meter(meter)` in `cendor-guardrails` 1.7.0.
