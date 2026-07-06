/** max_entries bounds the in-memory ring; the file stays the complete chain. Mirrors test_bounded_memory.py. */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LLMCall, Usage, bus } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, BoundedMemoryWithoutPathWarning, verify } from '../src/index.js';

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

let n = 0;
const tmpFile = (name = 'audit.jsonl'): string =>
  join(mkdtempSync(join(tmpdir(), `bounded-${n++}-`)), name);

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
type Dict = Record<string, unknown>;

it('evicts the oldest but the file stays complete', () => {
  const path = tmpFile();
  const log = new AuditLog('s', { path, maxEntries: 10 });
  let head: string;
  try {
    emitCalls(100); // + audit_open = 101 appended
    expect(log.entries.length).toBe(10);
    expect(log.evictedFromMemory).toBe(91);
    expect(log.entries.map((e) => Number(e.seq))).toEqual(
      Array.from({ length: 10 }, (_, i) => 91 + i),
    );
    head = log.head;
  } finally {
    log.detach();
  }
  expect(fileLines(path).length).toBe(101);
  const [ok, detail] = verify(path, { expectedHead: head!, expectEntries: 101 });
  expect(ok, detail).toBe(true);
});

it('default unbounded retains all and evicted is zero', () => {
  const path = tmpFile();
  const log = new AuditLog('s', { path });
  let head: string;
  try {
    emitCalls(50);
    expect(log.entries.length).toBe(51);
    expect(log.evictedFromMemory).toBe(0);
    expect(log.entries.some((e) => e.type === 'policy_flag')).toBe(false);
    head = log.head;
  } finally {
    log.detach();
  }
  const [ok, detail] = verify(path, { expectedHead: head!, expectEntries: 51 });
  expect(ok, detail).toBe(true);
});

it('bounded export reads the full chain from the file', () => {
  const path = tmpFile();
  const pack = tmpFile('pack.jsonl');
  const log = new AuditLog('s', { path, maxEntries: 5 });
  let head: string;
  try {
    emitCalls(40); // 41 appended, 5 retained
    expect(log.entries.length).toBe(5);
    log.export(pack, 'eu_ai_act');
    head = log.head;
  } finally {
    log.detach();
  }
  const rows = fileLines(pack).map((l) => JSON.parse(l) as Dict);
  const meta = rows[0]!._meta as Dict;
  expect(meta.entries).toBe(41);
  expect(meta.head_hash).toBe(head!);
  expect((meta.summary as Dict).llm_calls).toBe(40);
  expect(rows.filter((r) => !('_meta' in r)).length).toBe(41);
  const [ok, detail] = verify(pack);
  expect(ok, detail).toBe(true);
});

it('bounded without path warns', () => {
  const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
  const log = new AuditLog('s', { maxEntries: 5 });
  log.detach();
  expect(spy).toHaveBeenCalled();
  expect(spy.mock.calls[0]![0]).toBeInstanceOf(BoundedMemoryWithoutPathWarning);
  spy.mockRestore();
});

it('max_entries must be positive', () => {
  expect(() => new AuditLog('s', { maxEntries: 0 })).toThrow();
  expect(() => new AuditLog('s', { maxEntries: -3 })).toThrow();
});

it('bounded + signed still verifies the full chain', () => {
  const path = tmpFile();
  const pack = tmpFile('pack.jsonl');
  const log = new AuditLog('s', { path, maxEntries: 3, signingKey: 'k' });
  try {
    emitCalls(20); // 21 appended, 3 retained
    log.export(pack, 'eu_ai_act');
  } finally {
    log.detach();
  }
  const [ok, detail] = verify(pack, { key: 'k' });
  expect(ok, detail).toBe(true);
  expect(detail).toContain('metadata signature verified');
});
