/**
 * S4 — every governance row names its actor. TS mirror of the Python assertions in cendor-sdk's
 * `tests/test_agent_id.py` (there they can be one file; here the producer and the consumer live in two
 * repos, so this is the **consuming** half — see the note in cendor-sdk-js's `agent-id.test.ts`).
 *
 * Measured 2026-07-26: `governance_events.agent` was populated on **13 of 386** SDK rows, so "which
 * agent was blocked" was answerable only by inferring it from step ordering. The types that carry an
 * agent field (a guardrail decision) had one; the ones that do not (a budget block, a decision record,
 * an `llm_call`) were anonymous.
 *
 * Neither `@cendor/acttrace` nor `@cendor/core` may import the SDK (rule 2), so the actor arrives
 * through core's **ambient registry**: something registers a provider, core merges it, these two read
 * it. This test registers the provider itself — exactly what `@cendor/sdk` does per run.
 */
import {
  LLMCall,
  Usage,
  addAmbientProvider,
  ambientAttrs,
  bus,
  otel,
  removeAmbientProvider,
} from '@cendor/core';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, OTelMirror } from '../src/index.js';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

// Registered providers are removed by identity in afterEach. `_resetAmbient` is deliberately NOT used
// here: it lives in core's SOURCE module while `@cendor/core` resolves to core's built entry, so the
// two would touch different provider lists and a leak from one test would silently pass the next.
const registered: Array<Parameters<typeof addAmbientProvider>[0]> = [];

/** What the SDK registers per run: the acting agent, and its id when the app gave one. */
function actor(agent: string, agentId?: string): void {
  const fn = (): Record<string, unknown> => ({ agent, ...(agentId ? { agent_id: agentId } : {}) });
  registered.push(fn);
  addAmbientProvider(fn);
}

const attrs = (prefix: string): Array<Record<string, unknown>> =>
  exporter
    .getFinishedSpans()
    .filter((s) => s.name.startsWith(prefix))
    .map((s) => ({ ...s.attributes }));

beforeEach(() => {
  Reflect.deleteProperty(process.env, 'CENDOR_TELEMETRY');
  bus._reset();
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});
afterEach(async () => {
  bus._reset();
  for (const fn of registered.splice(0)) removeAmbientProvider(fn);
  await provider.shutdown();
  trace.disable();
});

const llmCall = (): LLMCall =>
  new LLMCall({
    id: 'c1',
    provider: 'openai',
    model: 'gpt-4o',
    messages: [],
    usage: new Usage({ inputTokens: 5, outputTokens: 1 }),
    traceId: 'run-42',
  });

// A budget block, duck-typed exactly as @cendor/tokenguard emits it (core imports no tool — rule 2).
const budgetEvent = (): Record<string, unknown> => ({
  action: 'blocked',
  reason: 'projected $0.0026 > cap $1e-9',
  name: 'per-run cap',
  model: 'gpt-4o',
  scope: 'session',
  projectedUsd: '0.0026',
  capUsd: '1e-9',
  projectedTokens: null,
  capTokens: null,
  toModel: null,
  tags: {},
  traceId: 'run-42',
});

describe('the actor on a governance.* ops span (core, Option C)', () => {
  it('a budget block — an event with NO agent field — names the acting agent', () => {
    actor('refund-bot', 'agent-7');
    otel.useSpanEmitter();
    bus.emit(budgetEvent());
    const gov = attrs('governance.');
    expect(gov.length, 'no governance span').toBeGreaterThan(0);
    expect(gov[0]?.['cendor.gov.agent']).toBe('refund-bot');
    expect(gov[0]?.['cendor.gov.agent_id']).toBe('agent-7');
    // rail 14: an agent name is app-supplied configuration; a guardrail's REASON can paraphrase the
    // payload and must still never reach a default-on span.
    expect(gov[0]?.['cendor.gov.reason']).toBeUndefined();
  });

  it('with no actor registered the attributes are OMITTED, not invented', () => {
    otel.useSpanEmitter();
    bus.emit(budgetEvent());
    const gov = attrs('governance.');
    expect(gov.length).toBeGreaterThan(0);
    expect(gov[0]?.['cendor.gov.agent']).toBeUndefined();
    expect(gov[0]?.['cendor.gov.agent_id']).toBeUndefined();
    expect(ambientAttrs()).toEqual({});
  });

  it("the event's OWN agent field still wins over the ambient one", () => {
    actor('ambient-bot');
    otel.useSpanEmitter();
    bus.emit({
      guardrail: 'keyword_deny',
      stage: 'input',
      action: 'block',
      agent: 'explicit-bot',
      tool: '',
      traceId: 'run-42',
      metadata: {},
    });
    expect(attrs('governance.')[0]?.['cendor.gov.agent']).toBe('explicit-bot');
  });
});

describe('the actor on an audit.* mirror span (acttrace)', () => {
  it('every mirrored entry names the agent — including the types with no agent field', () => {
    actor('refund-bot', 'agent-7');
    const log = new AuditLog('refunds', { riskTier: 'high', mirror: new OTelMirror() });
    try {
      bus.emit(llmCall()); // an AuditLog chains from the bus — this is how a real entry arrives
    } finally {
      log.detach();
    }
    const rows = attrs('audit.');
    expect(rows.length, 'no audit mirror spans').toBeGreaterThan(0);
    // `audit_open` and `llm_call` both have no agent field in their payload at all — exactly the case
    // the measured 13/386 was missing.
    expect(
      rows.every((a) => a['cendor.audit.agent'] === 'refund-bot'),
      `an entry did not name the agent: ${JSON.stringify(rows.map((a) => [a['cendor.audit.type'], a['cendor.audit.agent']]))}`,
    ).toBe(true);
    expect(rows.every((a) => a['cendor.audit.agent_id'] === 'agent-7')).toBe(true);
  });

  it('with no actor registered the mirror stays exactly as it was', () => {
    const log = new AuditLog('refunds', { mirror: new OTelMirror() });
    try {
      bus.emit(llmCall());
    } finally {
      log.detach();
    }
    const rows = attrs('audit.');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((a) => a['cendor.audit.agent'] === undefined)).toBe(true);
    expect(rows.every((a) => a['cendor.audit.agent_id'] === undefined)).toBe(true);
  });
});
