/**
 * Mirror the audit chain to OpenTelemetry (optional). The TS port of `cendor.acttrace.otel`. No-op
 * when `@opentelemetry/api` (an optional peer dep) is absent.
 *
 * The mirror is an **operational copy** for monitoring / alerting / SIEM — it lets governance events
 * (decisions, guardrail actions, policy flags, human oversight, budget breaches) show up in Azure
 * Monitor / Datadog / CloudWatch / Grafana alongside your traces. It is **not** the evidence: the
 * hash-chained file written by `new AuditLog(system, { path })` remains the only verifiable artifact —
 * `verify()` re-walks that file, never the mirror.
 *
 * Each entry is emitted as a span named `audit.<type>` carrying `cendor.audit.*` attributes
 * (structured labels only — never raw content; the chain has already redacted the payload). Spans are
 * used rather than the still-experimental OpenTelemetry Logs signal so the mirror works unchanged on
 * every current release and matches the rest of the stack (`@cendor/core` spans, the SDK span tree).
 */
import { createRequire } from 'node:module';

/** Minimal shape of the OTel bits we touch (typed defensively — OpenTelemetry is optional). */
interface OTelSpan {
  setAttribute(key: string, value: unknown): void;
  end(): void;
}
interface OTelTracer {
  startSpan(name: string): OTelSpan;
}
interface SpanContext {
  traceId: string;
  spanId: string;
}
/** The subset of `@opentelemetry/api` used across acttrace (mirror spans + correlation ids). */
export interface OTelApi {
  trace: {
    getTracer(name: string): OTelTracer;
    getActiveSpan?: () => { spanContext(): SpanContext } | undefined;
  };
  isSpanContextValid?: (ctx: SpanContext) => boolean;
}

/** Load `@opentelemetry/api` synchronously, or `null` if the optional peer isn't installed. */
export function loadOtelApi(): OTelApi | null {
  try {
    const req = createRequire(import.meta.url);
    return req('@opentelemetry/api') as OTelApi;
  } catch {
    return null; // OpenTelemetry not installed — stay in no-op mode
  }
}

/** Minimal entry shape the mirror reads (an {@link AuditEntry}). */
interface MirrorableEntry {
  type?: string;
  seq?: number | bigint;
  hash?: string;
  payload?: unknown;
}

/** Structured, non-sensitive payload keys worth surfacing as queryable/alertable span attributes. */
const ATTR_KEYS = [
  'decision_id',
  'action',
  'severity',
  'reason',
  'guardrail',
  'stage',
  'provider',
  'model',
  'reviewer',
  'name',
  'actor',
  'data',
  'cost',
  'otel_trace_id',
] as const;

/**
 * An `AuditLog(..., { mirror })` destination that mirrors each chained entry to OpenTelemetry.
 *
 * @example
 * ```ts
 * import { AuditLog, OTelMirror } from '@cendor/acttrace';
 * // configure your OTel pipeline once (e.g. useAzureMonitor()), then:
 * const audit = new AuditLog('support', { path: 'audit.jsonl', mirror: new OTelMirror() });
 * ```
 *
 * A **no-op** when `@opentelemetry/api` isn't installed, so it is always safe to attach.
 */
export class OTelMirror {
  private readonly tracer: OTelTracer | null;
  private system = '';

  constructor(tracer?: OTelTracer | null) {
    if (tracer !== undefined && tracer !== null) {
      this.tracer = tracer;
    } else {
      const api = loadOtelApi();
      this.tracer = api === null ? null : api.trace.getTracer('cendor.acttrace');
    }
  }

  write(entry: MirrorableEntry): void {
    if (this.tracer === null) return;
    const payload =
      entry.payload !== null && typeof entry.payload === 'object'
        ? (entry.payload as Record<string, unknown>)
        : {};
    // audit_open is always the first entry of a fresh log and carries the system name; remember it so
    // every subsequent audit span is filterable by system (e.g. system="support").
    if (entry.type === 'audit_open' && typeof payload.system === 'string' && payload.system) {
      this.system = payload.system;
    }
    const span = this.tracer.startSpan(`audit.${entry.type ?? 'entry'}`);
    try {
      span.setAttribute('cendor.audit.type', String(entry.type ?? ''));
      if (entry.seq !== undefined && entry.seq !== null) {
        span.setAttribute('cendor.audit.seq', Number(entry.seq));
      }
      if (entry.hash) span.setAttribute('cendor.audit.hash', String(entry.hash));
      const system = this.system || (typeof payload.system === 'string' ? payload.system : '');
      if (system) span.setAttribute('cendor.audit.system', system);
      for (const key of ATTR_KEYS) {
        const value = payload[key];
        if (value === null || value === undefined || value === '') continue;
        const attr = `cendor.audit.${key}`;
        if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
          span.setAttribute(attr, value);
        } else if (typeof value === 'bigint') {
          span.setAttribute(attr, Number(value));
        } else if (Array.isArray(value)) {
          if (value.length === 0) continue;
          span.setAttribute(
            attr,
            value.every((v) => typeof v === 'string') ? (value as string[]) : value.map(String),
          );
        } else {
          span.setAttribute(attr, String(value));
        }
      }
    } finally {
      span.end(); // a point-in-time governance event; duration is not meaningful
    }
  }
}
