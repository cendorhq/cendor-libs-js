/**
 * A chain names the format it implements and the library that opened it (D8).
 * Mirrors `cendor-libs/packages/cendor-acttrace/tests/test_provenance.py`.
 *
 * The two fields ride INSIDE the `audit_open` payload, which makes them part of the hashed chain (so
 * they cannot be edited after the fact) and changes nothing about how hashes are computed — the
 * hashed body is still exactly `{seq, ts, type, payload}`. That is why chains written before this
 * release keep verifying and a mixed old/new file verifies end to end. Putting the version at the TOP
 * level of an entry instead would have changed the hashed body for EVERY entry and invalidated every
 * chain in existence.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bus } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, CHAIN_FORMAT, chainHash, verify } from '../src/index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cendor-prov-'));
  bus._reset();
});
afterEach(() => bus._reset());

function entries(path: string): Array<Record<string, any>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
    .filter((r) => !('_meta' in r));
}

describe('chain provenance', () => {
  it('audit_open names the format and the producer', () => {
    const path = join(dir, 'chain.jsonl');
    const log = new AuditLog('checkout-agent', { path });
    log.detach();

    const first = entries(path)[0];
    expect(first.type).toBe('audit_open');

    // The format is IDENTICAL to Python's — it is the one part of provenance that must not differ.
    expect(first.payload.format).toBe(CHAIN_FORMAT);
    expect(first.payload.format).toBe('acttrace-chain/1');

    // The producer legitimately DIFFERS from Python's (`cendor-acttrace/…`): separate packages on
    // independent version lines. Assert the SHAPE, never a literal that would couple the two ports.
    expect(String(first.payload.producer)).toMatch(/^@cendor\/acttrace\/\d+\.\d+\.\d+/);

    expect(first.payload.system).toBe('checkout-agent');
    expect(verify(path)[0]).toBe(true);
  });

  it('provenance is inside the hashed chain — tampering with it breaks verification', () => {
    const path = join(dir, 'chain.jsonl');
    new AuditLog('s', { path }).detach();

    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const i = lines.findIndex((l) => !('_meta' in JSON.parse(l)));
    const row = JSON.parse(lines[i] as string);
    row.payload.producer = '@cendor/acttrace/99.99.99'; // a lie about what wrote this file
    lines[i] = JSON.stringify(row);
    writeFileSync(path, `${lines.join('\n')}\n`);

    const [ok, detail] = verify(path);
    expect(ok).toBe(false);
    expect(detail).toContain('tampered');
  });

  it('a chain opened by an OLD writer (no provenance) still verifies, and can be appended to', () => {
    // THE compatibility guarantee. Strip the two fields from the opener and re-link that entry the
    // way an older acttrace would have written it, then reopen and append with THIS version.
    const path = join(dir, 'chain.jsonl');
    const first = new AuditLog('s', { path });
    first.detach();

    // Rebuild the opener's payload WITHOUT the two fields — destructuring rather than `delete`,
    // which biome rejects on perf grounds.
    const rows = entries(path);
    const opener = rows[0] as Record<string, any>;
    const { format: _f, producer: _p, ...withoutProvenance } = opener.payload;
    opener.payload = withoutProvenance;
    // Re-link entry 0 exactly as an old writer produced it, using the library's OWN exported
    // chainHash — hand-rolling the digest here would only test the test's arithmetic.
    let prev = '0'.repeat(64);
    for (const r of rows) {
      r.prev_hash = prev;
      r.hash = chainHash(prev, r.seq, r.ts, r.type, r.payload);
      prev = r.hash;
    }
    writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    expect(verify(path)[0]).toBe(true);

    const reopened = new AuditLog('s', { path });
    reopened.flag('appended by the NEW writer, after an OLD opener');
    reopened.detach();

    const after = entries(path);
    expect(after[0]?.payload.format).toBeUndefined(); // the old opener stays as it was written
    expect(after.length).toBeGreaterThan(rows.length); // and the new entry landed
    const [ok2, detail2] = verify(path);
    expect(ok2, `a mixed old/new chain must verify: ${detail2}`).toBe(true);
  });
});
