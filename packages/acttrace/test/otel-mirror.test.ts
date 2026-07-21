/**
 * AuditLog mirror seam, OTelMirror no-op safety, and budget_event chaining. Mirrors
 * tests/test_otel_mirror.py. The mirror is an operational copy — a failing mirror must never break
 * the tamper-evident chain, and the file stays the sole verify() artifact. @opentelemetry/api is an
 * optional peer (absent in this workspace), so the active-span tests live on the Python side; here we
 * cover the seam with a fake mirror and OTelMirror's no-op path.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LLMCall, Money, Usage, bus } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AuditEntry, AuditLog, OTelMirror, verify } from '../src/index.js';

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'acttrace-otel-')), 'a.jsonl');
}

class ListMirror {
  entries: AuditEntry[] = [];
  closed = false;
  write(entry: AuditEntry): void {
    this.entries.push(entry);
  }
  close(): void {
    this.closed = true;
  }
}

describe('AuditLog mirror seam', () => {
  it('mirrors every chained entry and closes on detach', async () => {
    const mirror = new ListMirror();
    const log = new AuditLog('s', { path: tmpFile(), mirror });
    await log.decision(
      async (d) => {
        d.humanOversight('ops', 'approved');
      },
      { input: 'hi' },
    );
    log.detach();

    const types = mirror.entries.map((e) => e.type);
    expect(types).toContain('audit_open');
    expect(types).toContain('decision');
    expect(types).toContain('human_oversight');
    expect(mirror.closed).toBe(true);
  });

  it('never breaks the chain when the mirror throws', async () => {
    const path = tmpFile();
    const boom = {
      write(): void {
        throw new Error('mirror down');
      },
    };
    const log = new AuditLog('s', { path, mirror: boom });
    await log.decision(async () => {}, { input: 'x' });
    log.detach();
    expect(verify(path)[0]).toBe(true); // chain intact despite the mirror throwing on every write
  });

  it('OTelMirror is safe to attach without @opentelemetry/api', async () => {
    const path = tmpFile();
    const log = new AuditLog('s', { path, mirror: new OTelMirror() });
    await log.decision(async () => {}, { input: 'hi' });
    log.detach();
    expect(verify(path)[0]).toBe(true);
  });
});

describe('budget_event capture', () => {
  it('chains a tokenguard BudgetEvent by duck typing', () => {
    const path = tmpFile();
    const log = new AuditLog('s', { path });
    // A BudgetEvent shape (camelCase props) — proves the shape contract, not a package dependency.
    bus.emit({
      action: 'blocked',
      reason: 'pre-flight block: projected $9.00 would exceed cap $5.00',
      model: 'gpt-4o',
      toModel: null,
      scope: 'session',
      projectedUsd: '9.00',
      capUsd: '5.00',
      projectedTokens: null,
      capTokens: null,
      tags: { feature: 'refund_sync' },
    });
    log.detach();

    const entry = log.entries.find((e) => e.type === 'budget_event');
    expect(entry).toBeTruthy();
    const p = entry?.payload as Record<string, unknown>;
    expect(p.action).toBe('blocked');
    expect(p.cap_usd).toBe('5.00'); // written as snake_case for cross-language chain parity
    expect((p.tags as Record<string, unknown>).feature).toBe('refund_sync');
    expect(verify(path)[0]).toBe(true);
  });
});

// --------------------------------------------- V2 mirror completeness (G11/G12/G16 span attributes)
// The TS OTelMirror accepts an injected tracer, so we exercise the real attribute logic with a fake
// tracer even though @opentelemetry/api is absent in this workspace (parity with test_otel_mirror.py).

type Attrs = Record<string, unknown>;
class FakeSpan {
  attrs: Attrs = {};
  constructor(readonly name: string) {}
  setAttribute(key: string, value: unknown): void {
    this.attrs[key] = value;
  }
  end(): void {}
}
class FakeTracer {
  spans: FakeSpan[] = [];
  startSpan(name: string): FakeSpan {
    const s = new FakeSpan(name);
    this.spans.push(s);
    return s;
  }
}
function spanFor(tracer: FakeTracer, type: string): Attrs {
  const s = tracer.spans.find((sp) => sp.name === `audit.${type}`);
  if (!s) throw new Error(`no audit.${type} span`);
  return s.attrs;
}

describe('OTelMirror span attributes (V2 completeness)', () => {
  it('budget_event carries identity + numeric projected-vs-cap (G10/G11)', () => {
    const tracer = new FakeTracer();
    const log = new AuditLog('s', { path: tmpFile(), mirror: new OTelMirror(tracer) });
    bus.emit({
      action: 'blocked',
      reason: 'projected $9.00 would exceed cap $5.00',
      name: 'per-run cap',
      description: 'hard ceiling per support run',
      model: 'gpt-4o',
      toModel: null,
      scope: 'session',
      projectedUsd: '9.00',
      capUsd: '5.00',
      projectedTokens: null,
      capTokens: null,
      tags: { feature: 'refund_sync' },
    });
    log.detach();
    const a = spanFor(tracer, 'budget_event');
    expect(a['cendor.audit.budget']).toBe('per-run cap');
    expect(a['cendor.audit.name']).toBeUndefined(); // suppressed for budget_event
    expect(a['cendor.audit.description']).toBe('hard ceiling per support run');
    expect(a['cendor.audit.scope']).toBe('session');
    expect(a['cendor.audit.projected_usd']).toBe('9.00');
    expect(a['cendor.audit.cap_usd']).toBe('5.00');
    expect(a['cendor.audit.tag.feature']).toBe('refund_sync');
  });

  it('guardrail_decision carries agent/tool + policy provenance (G12)', () => {
    const tracer = new FakeTracer();
    const log = new AuditLog('s', { path: tmpFile(), mirror: new OTelMirror(tracer) });
    bus.emit({
      guardrail: 'prompt_injection',
      stage: 'input',
      action: 'block',
      reason: 'injection detected',
      agent: 'triage',
      tool: '',
      metadata: { severity: 'high', policy_version: '2', policy_hash: 'abc123' },
    });
    log.detach();
    const a = spanFor(tracer, 'guardrail_decision');
    expect(a['cendor.audit.agent']).toBe('triage');
    expect(a['cendor.audit.severity']).toBe('high'); // nested severity now reaches the span
    expect(a['cendor.audit.policy_version']).toBe('2');
    expect(a['cendor.audit.policy_hash']).toBe('abc123');
  });

  it('llm_call carries usage/latency/replayed (G12)', () => {
    const tracer = new FakeTracer();
    const log = new AuditLog('s', { path: tmpFile(), mirror: new OTelMirror(tracer) });
    bus.emit(
      new LLMCall({
        id: '1',
        provider: 'openai',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'x' }],
        usage: new Usage({ inputTokens: 100, outputTokens: 40, reasoningTokens: 10 }),
        cost: Money.zero(),
        latencyMs: 123,
        metadata: { replayed: true },
      }),
    );
    log.detach();
    const a = spanFor(tracer, 'llm_call');
    expect(a['cendor.audit.input_tokens']).toBe(100);
    expect(a['cendor.audit.output_tokens']).toBe(40);
    expect(a['cendor.audit.reasoning_tokens']).toBe(10);
    expect(a['cendor.audit.replayed']).toBe(true);
    // latency is PyFloat-wrapped in the payload (int/float JSON parity) — it must reach the span as a
    // real number, not "[object Object]" from String(PyFloat).
    expect(a['cendor.audit.latency_ms']).toBe(123);
  });

  it('context_assembly carries budget math + block counts (G16)', () => {
    const tracer = new FakeTracer();
    const log = new AuditLog('s', { path: tmpFile(), mirror: new OTelMirror(tracer) });
    bus.emit({
      model: 'gpt-4o',
      budget: 8000,
      used: 6500,
      decisions: [
        { action: 'kept' },
        { action: 'kept' },
        { action: 'compressed' },
        { action: 'dropped' },
      ],
    });
    log.detach();
    const a = spanFor(tracer, 'context_assembly');
    expect(a['cendor.audit.budget_tokens']).toBe(8000);
    expect(a['cendor.audit.used_tokens']).toBe(6500);
    expect(a['cendor.audit.kept']).toBe(2);
    expect(a['cendor.audit.compressed']).toBe(1); // squeeze's indirect visibility
    expect(a['cendor.audit.dropped']).toBe(1);
    expect(a['cendor.audit.truncated']).toBeUndefined(); // zero counts omitted
  });
});

// ----------------------------------------------------- V3: squeeze CompressionEvent chaining (G21)

describe('compression (G21)', () => {
  it('is chained by duck-typing (technique + ratio), metadata only', () => {
    const path = tmpFile();
    const log = new AuditLog('s', { path });
    bus.emit({
      technique: 'minify+dropnulls',
      tokens_before: 1200,
      tokens_after: 300,
      ratio: 0.25,
      store_kind: 'MemoryStore',
      handle_id: 'abc123',
      kind: 'json',
    });
    log.detach();
    const entry = log.entries.find((e: AuditEntry) => e.type === 'compression');
    expect(entry?.payload.technique).toBe('minify+dropnulls');
    expect(entry?.payload.handle_id).toBe('abc123');
    expect(verify(path)[0]).toBe(true);
  });

  it('mirrors technique + savings onto an audit.compression span', () => {
    const tracer = new FakeTracer();
    const log = new AuditLog('s', { path: tmpFile(), mirror: new OTelMirror(tracer) });
    bus.emit({
      technique: 'minify',
      tokens_before: 1000,
      tokens_after: 250,
      ratio: 0.25,
      store_kind: 'SQLiteStore',
      handle_id: 'h1',
      kind: 'json',
    });
    log.detach();
    const a = spanFor(tracer, 'compression');
    expect(a['cendor.audit.technique']).toBe('minify');
    expect(a['cendor.audit.tokens_before']).toBe(1000);
    expect(a['cendor.audit.tokens_after']).toBe(250);
    expect(a['cendor.audit.store_kind']).toBe('SQLiteStore');
    expect(a['cendor.audit.handle_id']).toBe('h1');
  });
});
