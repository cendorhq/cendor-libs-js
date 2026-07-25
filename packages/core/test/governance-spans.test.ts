/**
 * Option C (DR-2c): governance ENFORCEMENT as ordinary telemetry — no audit vocabulary. TS mirror of
 * cendor-libs' tests/test_governance_spans.py.
 *
 * A telemetry user wants to see what their stack decided: a budget that blocked a call, a guardrail
 * that tripped. Those ride plain `governance.*` spans with `cendor.gov.*` attributes from the same
 * core emitter that renders call spans — no `AuditLog`, no evidence-shaped object, no `audit.*` name.
 *
 * Rails pinned here: the mirror wins while one is on the wire, and no payload-derived text reaches a
 * `cendor.gov.*` attribute (rule 6).
 */
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus, instrument, otel } from '../src/index.js';
import { _resetAutoTelemetry, _resetGovernanceMirrors } from '../src/otel.js';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

// The two enforcement events, duck-typed exactly as tokenguard/guardrails emit them (core imports
// neither — rule 2 — so a local stand-in is the honest fixture).
const budgetEvent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  action: 'blocked',
  reason: 'projected $0.0026 > cap $0.000000001',
  name: 'per-run cap',
  description: null,
  model: 'gpt-4o',
  toModel: null,
  scope: 'session',
  projectedUsd: '0.0026',
  capUsd: '1e-9',
  projectedTokens: null,
  capTokens: null,
  tags: {},
  traceId: 'run-42',
  ...over,
});
const guardrailDecision = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  guardrail: 'keyword_deny',
  stage: 'input',
  action: 'block',
  reason: '',
  agent: 'support',
  tool: '',
  traceId: 'run-42',
  metadata: {},
  ...over,
});

function fakeClient(): { chat: { completions: { create: () => unknown } } } {
  return {
    chat: {
      completions: { create: () => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }) },
    },
  };
}
const gov = (): ReturnType<InMemorySpanExporter['getFinishedSpans']> =>
  exporter.getFinishedSpans().filter((s) => s.name.startsWith('governance.'));

beforeEach(() => {
  Reflect.deleteProperty(process.env, 'CENDOR_TELEMETRY');
  bus._reset();
  _resetAutoTelemetry();
  _resetGovernanceMirrors();
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});
afterEach(async () => {
  bus._reset();
  _resetAutoTelemetry();
  _resetGovernanceMirrors();
  await provider.shutdown();
  trace.disable();
});

describe('Option C governance spans', () => {
  it('a budget block renders a governance span', () => {
    instrument(fakeClient()); // arm the emitter — a zero-telemetry-code libs app
    bus.emit(budgetEvent());
    expect(gov().map((s) => s.name)).toEqual(['governance.budget_event']);
    const a = gov()[0]!.attributes;
    expect(a['cendor.gov.type']).toBe('budget_event');
    expect(a['cendor.gov.action']).toBe('blocked');
    expect(a['cendor.gov.budget']).toBe('per-run cap');
    expect(a['cendor.gov.projected_usd']).toBe('0.0026');
    expect(a['cendor.gov.cap_usd']).toBe('1e-9');
    expect(a['cendor.trace_id']).toBe('run-42');
  });

  it('a guardrail decision renders a governance span', () => {
    instrument(fakeClient());
    bus.emit(guardrailDecision());
    expect(gov().map((s) => s.name)).toEqual(['governance.guardrail_decision']);
    const a = gov()[0]!.attributes;
    expect(a['cendor.gov.guardrail']).toBe('keyword_deny');
    expect(a['cendor.gov.stage']).toBe('input');
    expect(a['cendor.gov.action']).toBe('block');
    expect(a['cendor.gov.agent']).toBe('support');
    expect(a['cendor.gov.tool']).toBeUndefined(); // empty fields omitted, not stamped as ''
  });

  it('carries no audit vocabulary at all (rule 6)', () => {
    instrument(fakeClient());
    bus.emit(budgetEvent());
    bus.emit(guardrailDecision());
    for (const span of gov()) {
      expect(span.name.startsWith('audit.')).toBe(false);
      expect(Object.keys(span.attributes).some((k) => k.startsWith('cendor.audit.'))).toBe(false);
    }
  });

  it('never emits a reason, and no payload text can reach a gov attr', () => {
    instrument(fakeClient());
    const marker = 'SSN-123-45-6789-SECRET';
    bus.emit(
      guardrailDecision({ reason: `the user said ${marker}`, metadata: { matched: marker } }),
    );
    bus.emit(budgetEvent({ reason: marker, description: marker }));
    for (const span of gov()) {
      expect(span.attributes['cendor.gov.reason']).toBeUndefined();
      for (const [key, value] of Object.entries(span.attributes)) {
        expect(String(value)).not.toContain(marker);
        expect(key).not.toContain(marker);
      }
    }
  });

  it('the audit mirror wins while one is attached, and they resume after', () => {
    instrument(fakeClient());
    otel.governanceMirrored(true);
    bus.emit(budgetEvent());
    expect(gov()).toEqual([]);
    otel.governanceMirrored(false);
    bus.emit(budgetEvent());
    expect(gov()).toHaveLength(1);
  });

  it('the mirror refcount composes for several logs', () => {
    instrument(fakeClient());
    otel.governanceMirrored(true);
    otel.governanceMirrored(true);
    otel.governanceMirrored(false);
    bus.emit(budgetEvent());
    expect(gov()).toEqual([]);
    otel.governanceMirrored(false);
    bus.emit(budgetEvent());
    expect(gov()).toHaveLength(1);
  });

  it('CENDOR_TELEMETRY=off kills governance spans too', () => {
    process.env.CENDOR_TELEMETRY = 'off';
    instrument(fakeClient());
    bus.emit(budgetEvent());
    expect(gov()).toEqual([]);
  });

  it('an unrelated event renders nothing', () => {
    instrument(fakeClient());
    bus.emit({ something: 'else' });
    expect(gov()).toEqual([]);
  });

  it('a liveSpans scope defers the flat rendering (the SDK owns it there)', async () => {
    instrument(fakeClient());
    await (async () => {
      await Promise.resolve();
      otel.enterLiveSpans();
      bus.emit(budgetEvent());
      otel.exitLiveSpans();
    })();
    expect(gov()).toEqual([]);
  });
});
