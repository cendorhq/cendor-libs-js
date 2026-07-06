/** Opt-in extras: locale gov-ID packs, entropy detector, NER adapter. Mirrors tests/test_extras.py. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DETECTORS, verhoeff } from '../src/detectors.js';
import {
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

describe('NER adapter (absent in the JS port)', () => {
  it('ner_available() is a boolean and false', () => {
    expect(typeof nerAvailable()).toBe('boolean');
    expect(nerAvailable()).toBe(false);
  });

  it('ner_redactor() throws a clear JS-honest not-available error', () => {
    expect(() => nerRedactor()).toThrow(/not available in @cendor\/acttrace/);
    expect(() => nerRedactor()).toThrow(/Python-only/);
  });
});
