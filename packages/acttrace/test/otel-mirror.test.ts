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
import { bus } from '@cendor/core';
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
