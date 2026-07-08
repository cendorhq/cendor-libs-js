/**
 * Reopening an existing log resumes the chain instead of wiping it. Mirrors the Python twin's
 * reopen/resume contract: append-open, continue from the last entry's head/seq, no fresh audit_open,
 * and a corrupt tail fails loudly. (Regression for the truncate-on-construction bug.)
 */
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LLMCall, Usage, bus } from '@cendor/core';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AuditLog, verify } from '../src/index.js';

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

let n = 0;
const tmpFile = (name = 'audit.jsonl'): string =>
  join(mkdtempSync(join(tmpdir(), `resume-${n++}-`)), name);

function emitCalls(count: number): void {
  for (let i = 0; i < count; i++) {
    bus.emit(
      new LLMCall({
        id: `c${i}`,
        provider: 'openai',
        model: 'gpt-4o',
        messages: [],
        usage: new Usage({ inputTokens: 10, outputTokens: 5 }),
      }),
    );
  }
}

const fileLines = (path: string): string[] =>
  readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim());

it('reopening resumes the chain: file keeps N+M entries and verify() passes end-to-end', () => {
  const path = tmpFile();
  const N = 5;
  const M = 4;

  // Session 1: audit_open + N calls = N+1 lines.
  let log = new AuditLog('s', { path });
  try {
    emitCalls(N);
    expect(log.entries.length).toBe(N + 1);
  } finally {
    log.detach();
  }
  expect(fileLines(path).length).toBe(N + 1);

  // Session 2: reopen the SAME path, add M more. No fresh audit_open — pure continuation.
  log = new AuditLog('s', { path });
  let head: string;
  try {
    // Resumed head/seq come from the last on-disk entry (seq N), so the next seq is N+1.
    expect(log.entries.some((e) => e.type === 'audit_open')).toBe(true); // the original one, resumed
    expect(log.entries.filter((e) => e.type === 'audit_open').length).toBe(1);
    expect(Number(log.entries.at(-1)!.seq)).toBe(N);
    emitCalls(M);
    expect(Number(log.entries.at(-1)!.seq)).toBe(N + M);
    head = log.head;
  } finally {
    log.detach();
  }

  expect(fileLines(path).length).toBe(N + 1 + M);
  const [ok, detail] = verify(path, { expectedHead: head!, expectEntries: N + 1 + M });
  expect(ok, detail).toBe(true);
});

it('a fresh log still emits audit_open as seq 0', () => {
  const path = tmpFile();
  const log = new AuditLog('svc', { riskTier: 'high', path });
  try {
    expect(log.entries.length).toBe(1);
    expect(log.entries[0]!.type).toBe('audit_open');
    expect(Number(log.entries[0]!.seq)).toBe(0);
    expect(log.entries[0]!.prev_hash).toBe('0'.repeat(64));
  } finally {
    log.detach();
  }
});

it('reopen honours maxEntries: only the tail loads, the rest counts as evicted, file stays whole', () => {
  const path = tmpFile();

  // Session 1: audit_open + 20 calls = 21 lines on disk.
  let log = new AuditLog('s', { path, maxEntries: 5 });
  try {
    emitCalls(20);
    expect(log.entries.length).toBe(5);
  } finally {
    log.detach();
  }
  expect(fileLines(path).length).toBe(21);

  // Session 2: resume with the same bound — 21 on disk, 5 retained, 16 counted as evicted.
  log = new AuditLog('s', { path, maxEntries: 5 });
  let head: string;
  try {
    expect(log.entries.length).toBe(5);
    expect(log.evictedFromMemory).toBe(16);
    expect(Number(log.entries.at(-1)!.seq)).toBe(20);
    emitCalls(3); // seq 21,22,23; ring stays 5, evicted rises to 19
    expect(log.entries.length).toBe(5);
    expect(log.evictedFromMemory).toBe(19);
    head = log.head;
  } finally {
    log.detach();
  }

  expect(fileLines(path).length).toBe(24);
  const [ok, detail] = verify(path, { expectedHead: head!, expectEntries: 24 });
  expect(ok, detail).toBe(true);
});

it('a corrupt tail line fails loudly on reopen (never silently restarts from GENESIS)', () => {
  const path = tmpFile();
  const log = new AuditLog('s', { path });
  try {
    emitCalls(2);
  } finally {
    log.detach();
  }
  appendFileSync(path, '{ this is not valid json\n');
  expect(() => new AuditLog('s', { path })).toThrow(/cannot resume/);
});
