/**
 * Cross-language conformance: these fixtures were produced by the Python `cendor-acttrace` and prove
 * Python-produced artifacts interoperate with the JS port byte-for-byte. If one fails, the port is
 * wrong — never weaken the assertion.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chainHash, metaSignature, redact, scan, verify } from '../src/index.js';
import { type PyValue, canonical } from '../src/pyjson.js';
import { fixturePath, loadJson, loadPreserved } from './_fixtures.js';

type Dict = Record<string, PyValue>;

describe('acttrace hashes.json — canonical body + chain hash (int/float preserving)', () => {
  const data = loadPreserved('acttrace/hashes.json') as Dict;
  const cases = data.cases as Dict[];
  for (const [i, c] of cases.entries()) {
    it(`case ${i} (${String(c.type)}) canonical + hash match`, () => {
      const body = canonical({ seq: c.seq, ts: c.ts, type: c.type, payload: c.payload });
      expect(body).toBe(c.canonicalBody);
      const h = chainHash(c.prevHash as string, c.seq, c.ts, c.type, c.payload);
      expect(h).toBe(c.hash);
    });
  }
});

describe('acttrace meta-sig.json — export _meta signature', () => {
  const data = loadPreserved('acttrace/meta-sig.json') as Dict;
  it('canonical body + HMAC signature match', () => {
    const meta = data.meta as Dict;
    const body = canonical({
      entries: meta.entries,
      head_hash: meta.head_hash,
      risk_tier: meta.risk_tier,
      system: meta.system,
    });
    expect(body).toBe(data.canonicalBody);
    const sig = metaSignature(data.key as string, {
      system: meta.system,
      risk_tier: meta.risk_tier,
      head_hash: meta.head_hash,
      entries: meta.entries,
    });
    expect(sig).toBe(data.sig);
  });
});

describe('acttrace detect.json — scan findings + redaction', () => {
  const data = loadJson<{ cases: { input: string; findings: unknown[]; redacted: string }[] }>(
    'acttrace/detect.json',
  );
  for (const [i, c] of data.cases.entries()) {
    it(`case ${i} scan/redact match`, () => {
      const findings = scan(c.input).map((f) => ({
        category: f.category,
        group: f.group,
        severity: f.severity,
        action: f.action,
        count: f.count,
      }));
      expect(findings).toEqual(c.findings);
      expect(redact(c.input)[0]).toBe(c.redacted);
    });
  }
});

describe('acttrace manifest.json — verify() on Python-written chains', () => {
  interface Manifest {
    signed: {
      file: string;
      key: string;
      head: string;
      entries: number;
      pythonVerify: { ok: boolean; detail: string };
    };
    unsigned?: { file: string; head: string; entries: number };
  }
  const manifest = loadJson<Manifest>('acttrace/manifest.json');

  it('signed pack verifies with the key (chain + entry sigs + meta sig)', () => {
    const path = fixturePath(`acttrace/${manifest.signed.file}`);
    const [ok, detail] = verify(path, { key: manifest.signed.key });
    expect(ok).toBe(true);
    expect(detail).toContain('signatures verified');
    expect(detail).toContain('metadata signature verified');
    expect(detail).toContain(manifest.signed.head.slice(0, 12));
  });

  it('signed pack verifies with expected head + entry count', () => {
    const path = fixturePath(`acttrace/${manifest.signed.file}`);
    const [ok] = verify(path, {
      key: manifest.signed.key,
      expectedHead: manifest.signed.head,
      expectEntries: manifest.signed.entries,
    });
    expect(ok).toBe(true);
  });

  it('chain-only verify (no key) reports the head, flags unauthenticated _meta', () => {
    const path = fixturePath(`acttrace/${manifest.signed.file}`);
    const [ok, detail] = verify(path);
    expect(ok).toBe(true);
    expect(detail).toContain('unauthenticated');
    expect(detail).toContain('expected_head');
  });

  it('a tampered payload fails with "tampered"', () => {
    const src = readFileSync(fixturePath(`acttrace/${manifest.signed.file}`), 'utf-8');
    const lines = src.split('\n').filter((l) => l.trim());
    // Corrupt the human_oversight entry's note without touching its hash.
    const idx = lines.findIndex((l) => l.includes('"type": "human_oversight"'));
    lines[idx] = lines[idx]!.replace('"looks fine"', '"HACKED"');
    const dir = mkdtempSync(join(tmpdir(), 'acttrace-'));
    const p = join(dir, 'tampered.jsonl');
    writeFileSync(p, `${lines.join('\n')}\n`);
    const [ok, detail] = verify(p, { key: manifest.signed.key });
    expect(ok).toBe(false);
    expect(detail).toContain('tampered');
  });

  it('the wrong key fails with "signature"', () => {
    const path = fixturePath(`acttrace/${manifest.signed.file}`);
    const [ok, detail] = verify(path, { key: 'wrong-key' });
    expect(ok).toBe(false);
    expect(detail).toContain('signature');
  });

  it('unsigned chain verifies without a key and fails when a key is required', () => {
    if (!manifest.unsigned || !existsSync(fixturePath(`acttrace/${manifest.unsigned.file}`))) {
      return; // fixture not committed in this snapshot
    }
    const path = fixturePath(`acttrace/${manifest.unsigned.file}`);
    expect(verify(path)[0]).toBe(true);
    const [ok, detail] = verify(path, { key: 'expected' });
    expect(ok).toBe(false);
    expect(detail).toContain('signature');
  });
});
