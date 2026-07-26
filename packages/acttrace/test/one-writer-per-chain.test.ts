/**
 * One **live** `AuditLog` per chain file — a second one silently corrupted the evidence.
 *
 * Reopening a path is supported (see `resume.test.ts`): a process restarts, constructs an `AuditLog`
 * over the same path, and the chain resumes from the last on-disk entry. What was never guarded is
 * **two logs alive at once on one path**. Both subscribe to the process-global bus, so one `LLMCall`
 * is auto-captured twice, and each appends at its own `seq`/`prevHash` — identical right after the
 * reopen. Two chains interleave into one file and `verify()` reports
 * `broken link at seq N: prev_hash mismatch`.
 *
 * Measured before the fix (`plan/evidence-cendor-libs-ripple-2026-07-26/probe_f2_ts_double_writer.mjs`):
 * byte-identical to the Python twin — a duplicate seq, and no row restarting from GENESIS. The
 * written-up cause ("a reopen restarts from genesis") was wrong in both languages.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LLMCall, Money, Usage, bus } from '@cendor/core';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AuditLog, verify } from '../src/index.js';

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

let n = 0;
const tmpFile = (name = 'audit.jsonl'): string =>
  join(mkdtempSync(join(tmpdir(), `one-writer-${n++}-`)), name);

function emitCall(i = 0): void {
  bus.emit(
    new LLMCall({
      id: `c${i}`,
      provider: 'openai',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      usage: new Usage({ inputTokens: 10, outputTokens: 2 }),
      cost: new Money('0.0000027'),
    }),
  );
}

const rows = (path: string): Record<string, unknown>[] =>
  readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => !('_meta' in r));

it('refuses a second live AuditLog on the same path, and names the way out', () => {
  const path = tmpFile();
  const log1 = new AuditLog('s', { path, mirror: false });
  try {
    expect(() => new AuditLog('s', { path, mirror: false })).toThrow(/detach/);
    // the refusal must not have damaged the first log
    emitCall();
    const [ok, detail] = verify(path);
    expect(ok, detail).toBe(true);
  } finally {
    log1.detach();
  }
});

it('is what keeps verify() green: no duplicate seq reaches the file', () => {
  const path = tmpFile();
  const log1 = new AuditLog('s', { path, mirror: false });
  try {
    emitCall(1);
    emitCall(2);
    expect(() => new AuditLog('s', { path, mirror: false })).toThrow();
    emitCall(3);
  } finally {
    log1.detach();
  }
  const seqs = rows(path).map((r) => Number(r.seq));
  expect(seqs, 'a duplicate seq means two writers got through').toStrictEqual([...new Set(seqs)]);
  const [ok, detail] = verify(path);
  expect(ok, detail).toBe(true);
});

it('detach() releases the path, so a restart still resumes the chain', () => {
  const path = tmpFile();
  const log1 = new AuditLog('s', { path, mirror: false });
  const head1 = log1.head;
  log1.detach();

  const log2 = new AuditLog('s', { path, mirror: false }); // the real restart case: allowed
  try {
    expect(log2.head).toBe(head1); // a pure resume, no fresh audit_open
    emitCall();
  } finally {
    log2.detach();
  }

  const log3 = new AuditLog('s', { path, mirror: false }); // and again, indefinitely
  log3.detach();

  const [ok, detail] = verify(path);
  expect(ok, detail).toBe(true);
  expect(rows(path).filter((r) => r.type === 'audit_open')).toHaveLength(1);
});

it('detach() is idempotent and does not over-release the path', () => {
  const path = tmpFile();
  const log1 = new AuditLog('s', { path, mirror: false });
  log1.detach();
  log1.detach();

  const log2 = new AuditLog('s', { path, mirror: false });
  try {
    expect(() => new AuditLog('s', { path, mirror: false })).toThrow();
  } finally {
    log2.detach();
  }
});

it('different paths are independent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'one-writer-multi-'));
  const a = new AuditLog('a', { path: join(dir, 'a.jsonl'), mirror: false });
  const b = new AuditLog('b', { path: join(dir, 'b.jsonl'), mirror: false });
  try {
    emitCall();
  } finally {
    a.detach();
    b.detach();
  }
  for (const name of ['a.jsonl', 'b.jsonl']) {
    const [ok, detail] = verify(join(dir, name));
    expect(ok, `${name}: ${detail}`).toBe(true);
  }
});

it('the same file written two ways is still one path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'one-writer-alias-'));
  const log1 = new AuditLog('s', { path: join(dir, 'audit.jsonl'), mirror: false });
  try {
    const alias = join(dir, 'sub', '..', 'audit.jsonl');
    expect(() => new AuditLog('s', { path: alias, mirror: false })).toThrow(/detach/);
  } finally {
    log1.detach();
  }
});

it('path-less and storage-injected logs are never registered', () => {
  // An in-memory log has no file to corrupt, and an injected storage owns its own writer.
  const a = new AuditLog('a', { mirror: false });
  const b = new AuditLog('b', { mirror: false });
  try {
    emitCall();
    expect(a.entries.length).toBeGreaterThanOrEqual(2);
    expect(b.entries.length).toBeGreaterThanOrEqual(2);
  } finally {
    a.detach();
    b.detach();
  }
});
