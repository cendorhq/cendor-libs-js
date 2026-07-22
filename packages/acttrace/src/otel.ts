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
import { PyFloat } from './pyjson.js';

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
  'otel_span_id', // G12: the correlation span id (pivot target), was stamped but never exposed
  'run_id', // G-LINK-2: core's ambient run id — the monitor's fallback join when no OTel span active
] as const;

/** Free-text attributes (`description`/`note`) are truncated to this many chars on the span. */
const TEXT_MAX = 200;

/** Unwrap a cross-language float wrapper to its plain number so it never serializes as
 * "[object Object]" on a span (payload floats such as `latency_ms` are `PyFloat`-wrapped for the
 * JSONL/hash side). */
function unwrap(value: unknown): unknown {
  return value instanceof PyFloat ? value.value : value;
}

/** Set one scalar span attribute, skipping empties; stringify non-primitives. */
function setScalar(span: OTelSpan, attr: string, raw: unknown): void {
  const value = unwrap(raw);
  if (value === null || value === undefined || value === '') return;
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    span.setAttribute(attr, value);
  } else if (typeof value === 'bigint') {
    span.setAttribute(attr, Number(value));
  } else {
    span.setAttribute(attr, String(value));
  }
}

/** Set an int span attribute when `value` is a real number (skip null / non-numeric). */
function setInt(span: OTelSpan, attr: string, raw: unknown): void {
  const value = unwrap(raw);
  if (typeof value === 'number' && Number.isFinite(value))
    span.setAttribute(attr, Math.trunc(value));
  else if (typeof value === 'bigint') span.setAttribute(attr, Number(value));
}

/** Set a truncated free-text attribute (`description`/`note`); skip empties. */
function setText(span: OTelSpan, attr: string, value: unknown): void {
  if (value === null || value === undefined || value === '') return;
  let text = String(value);
  if (text.length > TEXT_MAX) text = `${text.slice(0, TEXT_MAX - 1)}…`;
  span.setAttribute(attr, text);
}

/** Flatten `track()` attribution tags as `cendor.audit.tag.<key>` (bounded values only). */
function flattenTags(span: OTelSpan, tags: unknown): void {
  if (tags === null || typeof tags !== 'object') return;
  for (const [key, value] of Object.entries(tags as Record<string, unknown>)) {
    if (value === null || value === undefined || value === '') continue;
    const attr = `cendor.audit.tag.${key}`;
    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
      span.setAttribute(attr, value);
    } else {
      span.setAttribute(attr, String(value));
    }
  }
}

/** Count context-assembly block decisions by action and set the non-zero counts (G16). */
function blockCounts(span: OTelSpan, decisions: unknown): void {
  if (!Array.isArray(decisions)) return;
  const counts: Record<string, number> = {};
  for (const d of decisions) {
    const action =
      d !== null && typeof d === 'object' ? (d as Record<string, unknown>).action : null;
    if (typeof action === 'string' && action) counts[action] = (counts[action] ?? 0) + 1;
  }
  for (const action of ['kept', 'truncated', 'summarized', 'compressed', 'dropped']) {
    const n = counts[action] ?? 0;
    if (n) span.setAttribute(`cendor.audit.${action}`, n);
  }
}

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
      const etype = String(entry.type ?? '');
      for (const key of ATTR_KEYS) {
        // A budget's `name` is exposed as `cendor.audit.budget` (below), not the generic
        // `cendor.audit.name`, so a monitor queries one clear attribute for the budget name.
        if (key === 'name' && etype === 'budget_event') continue;
        const value = unwrap(payload[key]);
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
      // --- Typed / nested handling (G11/G12/G16): fields the flat loop can't reach (nested usage/
      // metadata objects, renamed keys, per-action counts). Values still derive only from the
      // already-scrubbed payload — never raw content.
      if (etype === 'budget_event') {
        // G11: budget identity + numeric projected-vs-cap
        setScalar(span, 'cendor.audit.budget', payload.name);
        setText(span, 'cendor.audit.description', payload.description);
        setScalar(span, 'cendor.audit.scope', payload.scope);
        setScalar(span, 'cendor.audit.to_model', payload.to_model);
        setScalar(span, 'cendor.audit.projected_usd', payload.projected_usd);
        setScalar(span, 'cendor.audit.cap_usd', payload.cap_usd);
        setInt(span, 'cendor.audit.projected_tokens', payload.projected_tokens);
        setInt(span, 'cendor.audit.cap_tokens', payload.cap_tokens);
        flattenTags(span, payload.tags);
      } else if (etype === 'llm_call') {
        // G12: token usage / latency / cassette replay flag
        const usage = payload.usage;
        if (usage !== null && typeof usage === 'object') {
          const u = usage as Record<string, unknown>;
          setInt(span, 'cendor.audit.input_tokens', u.input_tokens);
          setInt(span, 'cendor.audit.output_tokens', u.output_tokens);
          setInt(span, 'cendor.audit.reasoning_tokens', u.reasoning_tokens);
        }
        setScalar(span, 'cendor.audit.latency_ms', payload.latency_ms);
        span.setAttribute('cendor.audit.replayed', Boolean(payload.replayed ?? false));
      } else if (etype === 'guardrail_decision') {
        // G12: agent/tool + policy provenance from metadata
        setScalar(span, 'cendor.audit.agent', payload.agent);
        setScalar(span, 'cendor.audit.tool', payload.tool);
        const meta = payload.metadata;
        if (meta !== null && typeof meta === 'object') {
          const m = meta as Record<string, unknown>;
          // nested severity now reaches the span (the top-level key only ever matched a policy_flag).
          setScalar(span, 'cendor.audit.severity', m.severity);
          setScalar(span, 'cendor.audit.policy_version', m.policy_version);
          setScalar(span, 'cendor.audit.policy_hash', m.policy_hash);
        }
      } else if (etype === 'human_oversight') {
        setText(span, 'cendor.audit.note', payload.note); // G12
      } else if (etype === 'audit_open') {
        setScalar(span, 'cendor.audit.risk_tier', payload.risk_tier); // G12
      } else if (etype === 'context_assembly') {
        // G16: budget math + per-action block counts (distinct from a budget *name*)
        setInt(span, 'cendor.audit.budget_tokens', payload.budget);
        setInt(span, 'cendor.audit.used_tokens', payload.used);
        blockCounts(span, payload.decisions);
      } else if (etype === 'compression') {
        // G21: squeeze technique + token savings (metadata only)
        setScalar(span, 'cendor.audit.technique', payload.technique);
        setInt(span, 'cendor.audit.tokens_before', payload.tokens_before);
        setInt(span, 'cendor.audit.tokens_after', payload.tokens_after);
        setScalar(span, 'cendor.audit.ratio', payload.ratio);
        setScalar(span, 'cendor.audit.store_kind', payload.store_kind);
        setScalar(span, 'cendor.audit.handle_id', payload.handle_id);
        setScalar(span, 'cendor.audit.kind', payload.kind);
      }
    } finally {
      span.end(); // a point-in-time governance event; duration is not meaningful
    }
  }
}
