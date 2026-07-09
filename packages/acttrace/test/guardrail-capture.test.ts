/**
 * acttrace chains a guardrail decision by duck typing — no import of @cendor/guardrails.
 * Mirrors tests/test_guardrail_capture.py. We emit a plain object carrying guardrail/stage/action
 * so the test proves the *shape* contract, not a package dependency.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bus } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, verify } from '../src/index.js';

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'acttrace-gr-')), 'g.jsonl');
}

function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guardrail: 'keyword_deny',
    stage: 'input',
    action: 'block',
    reason: "denied keyword: 'bomb'",
    agent: 'triage',
    tool: '',
    ...overrides,
  };
}

describe('guardrail decision capture', () => {
  it('chains a guardrail_decision entry and verifies', () => {
    const path = tmpFile();
    const log = new AuditLog('s', { path });
    bus.emit(decision());
    log.detach();

    const entries = log.entries.filter((e) => e.type === 'guardrail_decision');
    expect(entries).toHaveLength(1);
    const p = entries[0]?.payload as Record<string, unknown>;
    expect(p.guardrail).toBe('keyword_deny');
    expect(p.stage).toBe('input');
    expect(p.action).toBe('block');
    expect(p.reason).toBe("denied keyword: 'bomb'");
    expect(p.agent).toBe('triage');
    expect(verify(path)[0]).toBe(true);
  });

  it('captures metadata for policy provenance', () => {
    const path = tmpFile();
    const log = new AuditLog('s', { path });
    bus.emit(decision({ metadata: { policy_hash: 'sha256:abc', policy_version: '2026-07-09' } }));
    log.detach();
    const entry = log.entries.find((e) => e.type === 'guardrail_decision');
    const md = (entry?.payload as Record<string, unknown>).metadata as Record<string, unknown>;
    expect(md.policy_hash).toBe('sha256:abc');
    expect(md.policy_version).toBe('2026-07-09');
    expect(verify(path)[0]).toBe(true);
  });

  it('defaults metadata to {} when absent', () => {
    const path = tmpFile();
    const log = new AuditLog('s', { path });
    bus.emit(decision());
    log.detach();
    const entry = log.entries.find((e) => e.type === 'guardrail_decision');
    expect((entry?.payload as Record<string, unknown>).metadata).toEqual({});
  });

  it('correlates with the active decision', async () => {
    const path = tmpFile();
    const log = new AuditLog('s', { path });
    await log.decision(
      async () => {
        bus.emit(decision({ action: 'flag', reason: 'matched' }));
      },
      { input: 'claim' },
    );
    log.detach();

    const entry = log.entries.find((e) => e.type === 'guardrail_decision');
    expect((entry?.payload as Record<string, unknown>).decision_id).toBeTruthy();
    expect((entry?.payload as Record<string, unknown>).action).toBe('flag');
    expect(verify(path)[0]).toBe(true);
  });
});
