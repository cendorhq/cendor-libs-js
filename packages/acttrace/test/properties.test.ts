/** Property-style: a fresh chain verifies; any single-entry tamper breaks it. Mirrors test_acttrace_properties.py. */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bus } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, verify } from '../src/index.js';

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

let n = 0;
const tmpFile = (): string => join(mkdtempSync(join(tmpdir(), `prop-${n++}-`)), 'a.jsonl');

// A spread of inputs standing in for Hypothesis's generated string lists (empty, unicode, quotes).
const CASES: string[][] = [
  ['a'],
  ['', 'b', 'ccc'],
  ['café ☕', 'x"y', 'multi\nline'],
  ['1', '2', '3', '4', '5', '6'],
  ['{"nested":true}', '\\backslash', 'tab\ttab'],
];

describe('chain verifies and any single-entry tamper is detected', () => {
  it.each(CASES.map((c, i) => [i, c] as const))('case %i', async (_i, inputs) => {
    const path = tmpFile();
    const log = new AuditLog('s', { path });
    log.detach(); // explicit decisions only — no bus involvement
    for (const value of inputs) {
      await log.decision(async () => {}, { input: value });
    }
    expect(verify(path)[0]).toBe(true);

    const lines = readFileSync(path, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    const row = JSON.parse(lines[1]!) as { payload?: Record<string, unknown> };
    row.payload = { ...(row.payload ?? {}), tampered: 'yes' };
    lines[1] = JSON.stringify(row);
    writeFileSync(path, `${lines.join('\n')}\n`);
    expect(verify(path)[0]).toBe(false);
  });
});
