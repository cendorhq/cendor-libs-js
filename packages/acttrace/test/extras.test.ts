/** Opt-in extras: locale gov-ID packs, entropy detector, NER adapter. Mirrors tests/test_extras.py. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DETECTORS, verhoeff } from '../src/detectors.js';
import {
  AuditLog,
  defaultRedactor,
  enableEntropyDetector,
  enableLocalePack,
  nerAvailable,
  nerRedactor,
  scan,
} from '../src/index.js';
import { ninoValid, shannonEntropy } from '../src/packs.js';

let snapshot: (typeof DETECTORS)[number][] = [];
beforeEach(() => {
  snapshot = [...DETECTORS];
});
afterEach(() => {
  DETECTORS.length = 0;
  DETECTORS.push(...snapshot);
});

describe('off by default', () => {
  it('detects none of the opt-in categories on a clean install', () => {
    expect(scan('ni AB123456C and aadhaar 2341 2341 2346')).toEqual([]);
    expect(DETECTORS.every((d) => d.category !== 'high_entropy_secret')).toBe(true);
    expect(DETECTORS.some((d) => d.category === 'uk_nino' || d.category === 'in_aadhaar')).toBe(
      false,
    );
  });
});

describe('locale packs', () => {
  it('enable adds detectors', () => {
    const added = enableLocalePack('uk', 'in');
    expect(new Set(added)).toEqual(new Set(['uk_nino', 'in_aadhaar']));
    expect(scan('ni AB123456C').map((f) => f.category)).toEqual(['uk_nino']);
    expect(scan('aadhaar 2341 2341 2346').map((f) => f.category)).toEqual(['in_aadhaar']);
  });

  it('is idempotent', () => {
    enableLocalePack('in');
    const before = DETECTORS.length;
    expect(enableLocalePack('in')).toEqual([]);
    expect(DETECTORS.length).toBe(before);
  });

  it('unknown code rejected', () => {
    expect(() => enableLocalePack('zz')).toThrow(/unknown locale pack/);
  });

  it.each([
    ['234123412346', true],
    ['234123412345', false],
    ['2341 2341 2346', true],
  ] as const)('aadhaar verhoeff(%s) === %s', (a, ok) => expect(verhoeff(a)).toBe(ok));

  it.each([
    ['AB123456C', true],
    ['DA123456C', false],
    ['BG123456C', false],
    ['AO123456C', false],
  ] as const)('nino(%s) === %s', (nino, ok) => expect(ninoValid(nino)).toBe(ok));

  it('aadhaar validator gates bad checksums', () => {
    enableLocalePack('in');
    expect(scan('aadhaar 234123412345')).toEqual([]);
  });
});

describe('entropy detector', () => {
  it('flags a high-entropy token', () => {
    enableEntropyDetector(24, 3.5);
    const hits = scan('secret dGhpcyBpcyBhIHJhbmRvbXNlY3JldDEyMzQ1Njc4OTBhYg').map(
      (f) => f.category,
    );
    expect(hits).toEqual(['high_entropy_secret']);
  });

  it('ignores low-entropy and short tokens', () => {
    enableEntropyDetector(24, 3.5);
    expect(scan('a'.repeat(32))).toEqual([]);
    expect(scan('abc123')).toEqual([]);
  });

  it('is re-tunable in place (no duplicate)', () => {
    enableEntropyDetector(24);
    enableEntropyDetector(8, 2.0);
    expect(DETECTORS.filter((d) => d.category === 'high_entropy_secret').length).toBe(1);
  });

  it('shannon entropy basics', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('ab')).toBeCloseTo(1.0);
  });
});

describe('NER adapter (compromise backend)', () => {
  it('nerAvailable() is true when the optional compromise dependency is present', () => {
    expect(nerAvailable()).toBe(true);
  });

  it('redacts PERSON and LOCATION spans with the <redacted> token, preserving surrounds', () => {
    const redact = nerRedactor(['PERSON', 'LOCATION']);
    expect(redact('John Smith flew to Paris on business')).toBe(
      '<redacted> flew to <redacted> on business',
    );
  });

  it('only redacts the requested entity types', () => {
    const out = nerRedactor(['PERSON'])('Alice met Bob in Berlin') as string;
    expect(out).toBe('<redacted> met <redacted> in Berlin'); // names gone, location kept
  });

  it('walks dicts and arrays', () => {
    const out = nerRedactor(['PERSON'])({ note: 'call John Smith', tags: ['ask Mary'] }) as {
      note: string;
      tags: string[];
    };
    expect(out.note).toBe('call <redacted>');
    expect(out.tags[0]).toBe('ask <redacted>');
  });

  it('runs compose (regex scrub) first, then NER', () => {
    // defaultRedactor scrubs the email; NER then scrubs the name — both gone.
    const out = nerRedactor(
      ['PERSON'],
      'en',
      defaultRedactor,
    )('email John Smith at alice@example.com') as string;
    expect(out).not.toContain('alice@example.com');
    expect(out).not.toContain('John Smith');
    expect(out).toContain('<redacted>');
  });

  it('leaves entity-free text unchanged', () => {
    expect(nerRedactor(['PERSON', 'LOCATION'])('the quick brown fox jumps')).toBe(
      'the quick brown fox jumps',
    );
  });

  it('plugs into AuditLog as a custom redactor (bypasses the built-in policy path)', async () => {
    const log = new AuditLog('test-system', {
      redactor: nerRedactor(['PERSON', 'LOCATION'], 'en', defaultRedactor),
    });
    await log.decision(() => 'ok', { input: 'John Smith requested a refund from Paris' });
    const entry = log.entries.find((e) => e.type === 'decision');
    expect(entry).toBeDefined();
    const input = (entry?.payload as { input?: string }).input ?? '';
    expect(input).not.toContain('John Smith');
    expect(input).not.toContain('Paris');
    expect(input).toContain('<redacted>');
  });
});
