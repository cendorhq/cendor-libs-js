/**
 * The audit mirror auto-attaches (DR-2a): governance is one line, not four. TS mirror of
 * cendor-libs' tests/test_mirror_autoattach.py.
 *
 * `new AuditLog('support')` is the *governance* line a user writes anyway. Under the telemetry switch
 * its **operational copy** now reaches the backend the app already configured — no
 * `mirror: new OTelMirror()`, no telemetry code. `mirror: false` is the per-log opt-out; an explicit
 * mirror is used verbatim. Nothing ever creates an AuditLog for you (DR-2b).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bus } from '@cendor/core';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, OTelMirror, verify } from '../src/index.js';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

function auditSpans(): string[] {
  return exporter
    .getFinishedSpans()
    .map((s) => s.name)
    .filter((n) => n.startsWith('audit.'));
}

beforeEach(() => {
  Reflect.deleteProperty(process.env, 'CENDOR_TELEMETRY');
  bus._reset();
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});
afterEach(async () => {
  bus._reset();
  await provider.shutdown();
  trace.disable();
});

describe('audit mirror auto-attach', () => {
  it('a bare AuditLog puts governance on the wire', async () => {
    const log = new AuditLog('support');
    await log.decision(async (d) => d.humanOversight('ops', 'approved'), {
      input: 'refund please',
    });
    log.detach();
    const names = auditSpans();
    expect(names).toContain('audit.audit_open');
    expect(names).toContain('audit.decision');
    expect(names).toContain('audit.human_oversight');
  });

  it('mirror:false never mirrors', async () => {
    const log = new AuditLog('support', { mirror: false });
    await log.decision(async () => {}, { input: 'hi' });
    log.detach();
    expect(auditSpans()).toEqual([]);
  });

  it('an explicit mirror is used verbatim', async () => {
    const seen: string[] = [];
    const log = new AuditLog('support', {
      mirror: { write: (e: { type?: string }) => seen.push(String(e.type)) },
    });
    await log.decision(async () => {}, { input: 'hi' });
    log.detach();
    expect(seen[0]).toBe('audit_open');
    expect(auditSpans()).toEqual([]);
  });

  it('CENDOR_TELEMETRY=off never attaches', async () => {
    process.env.CENDOR_TELEMETRY = 'off';
    const log = new AuditLog('support');
    await log.decision(async () => {}, { input: 'hi' });
    log.detach();
    expect(auditSpans()).toEqual([]);
  });

  it('the auto mirror is an OTelMirror, and detach() closes it', async () => {
    const log = new AuditLog('support');
    expect((log as unknown as { _mirror: unknown })._mirror).toBeInstanceOf(OTelMirror);
    await log.decision(async () => {}, { input: 'hi' });
    expect(() => log.detach()).not.toThrow();
  });

  it('a failing auto mirror never breaks the chain', async () => {
    const original = OTelMirror.prototype.write;
    OTelMirror.prototype.write = () => {
      throw new Error('mirror down');
    };
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cendor-audit-')), 'audit.jsonl');
    try {
      const log = new AuditLog('support', { path: file });
      await log.decision(async (d) => d.humanOversight('ops', 'ok'), { input: 'hi' });
      log.detach();
      const [ok, message] = verify(file);
      expect(ok, message).toBe(true);
    } finally {
      OTelMirror.prototype.write = original;
    }
  });
});
