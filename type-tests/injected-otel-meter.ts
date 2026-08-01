// Type-level regression test: a REAL OpenTelemetry `Meter` must be accepted by every place that
// advertises meter injection.
//
// Why this exists. Meter injection is the documented way to assert metrics WITHOUT installing a
// process-global provider — trap row "Assert spans/metrics without a global provider" on
// /docs/for-ai-assistants names `otel.span(tracer=)`, `OTelSink(meter=)` and `guardrails.use_meter`.
// It was added because the external suite had no way to read the counters otherwise.
//
// It did not typecheck. Measured 2026-08-01 while converting cendor-cookbook-js to TypeScript
// source: the counter type declared `add` as a PROPERTY with a function type —
//
//   type Counter = { add: (value: number, attrs: Record<string, unknown>) => void };
//
// — and a property's parameters are checked CONTRAVARIANTLY under `strictFunctionTypes`, whereas a
// METHOD's are checked bivariantly. OTel's real counter is
// `add(value: number, attributes?: Attributes, context?: Context): void`, and `Record<string,
// unknown>` is not assignable to `Attributes` (`unknown` is not an `AttributeValue`). So the one
// call the docs recommend was a compile error, on a feature that exists only for that call. It
// worked perfectly at runtime, which is why nothing else caught it.
//
// The fix was declaring `add` as a method. This file pins it: if a refactor turns either signature
// back into a property, these assignments stop compiling and CI fails.
//
// Checked by `pnpm check:types`. Imports the built dist — the shape a consumer actually gets — so
// run `pnpm build` first.
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';

import { useMeter } from '../packages/guardrails/dist/index.js';
import { OTelSink } from '../packages/tokenguard/dist/sinks.js';

/** A meter from a provider the caller owns — the whole point of injection. */
function ownMeter() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const provider = new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter })],
  });
  return provider.getMeter('type-test');
}

/** `OTelSink` must accept a real Meter with no cast. */
export function otelSinkAcceptsARealMeter() {
  return new OTelSink({ meter: ownMeter() });
}

/** `useMeter` must accept a real Meter with no cast. */
export function useMeterAcceptsARealMeter() {
  useMeter(ownMeter());
  useMeter(null); // and still accept null, meaning "go back to the global provider"
}

/** A meter off the GLOBAL provider is the same type, and must work too. */
export function acceptsTheGlobalMeter() {
  const meter = metrics.getMeter('type-test');
  useMeter(meter);
  return new OTelSink({ meter });
}
