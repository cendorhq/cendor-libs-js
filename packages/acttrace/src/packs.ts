/**
 * Opt-in detector packs — locale government IDs and a high-entropy generic-secret detector. The TS
 * port of `cendor.acttrace.packs`.
 *
 * None of these ship in the default registry: the default install stays precision-first and
 * pure-regex. Enable them explicitly. Everything here is still **offline** — regex + local
 * checksums/entropy, no model, no network.
 */

import { DETECTORS, type Detector, groupOf, registerDetector, verhoeff } from './detectors.js';

/** Named error mirroring Python `ValueError` for an unknown locale pack. */
class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

/** UK National Insurance number prefix rules (offline structural check). */
export function ninoValid(s: string): boolean {
  const t = s.replace(/ /g, '').toUpperCase();
  if (t.length !== 9) return false;
  const first = t[0]!;
  const second = t[1]!;
  if ('DFIQUV'.includes(first) || 'DFIOQUV'.includes(second)) return false;
  return !['BG', 'GB', 'NK', 'KN', 'NT', 'TN', 'ZZ'].includes(t.slice(0, 2));
}

/**
 * Locale government-ID detectors, keyed by ISO country code. Registered only via
 * {@link enableLocalePack}. Aadhaar is Verhoeff-checked; NINO is prefix-validated.
 */
export const LOCALE_PACKS: Record<string, Detector[]> = {
  uk: [
    {
      category: 'uk_nino',
      group: 'gov_id',
      severity: 'critical',
      pattern: /\b[A-Z]{2}\d{6}[A-D]\b/g,
      validator: ninoValid,
    },
  ],
  in: [
    {
      category: 'in_aadhaar',
      group: 'gov_id',
      severity: 'critical',
      pattern: /\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b/g,
      validator: verhoeff,
    },
  ],
};

/**
 * Register locale gov-ID detectors (opt-in). Idempotent; returns the categories added.
 *
 * @throws ValueError if a code has no bundled pack.
 */
export function enableLocalePack(...codes: string[]): string[] {
  const added: string[] = [];
  for (const code of codes) {
    const pack = LOCALE_PACKS[code.toLowerCase()];
    if (pack === undefined) {
      const available = Object.keys(LOCALE_PACKS).sort();
      throw new ValueError(
        `unknown locale pack ${JSON.stringify(code)}; available: [${available
          .map((a) => `'${a}'`)
          .join(', ')}]`,
      );
    }
    for (const detector of pack) {
      if (groupOf(detector.category) === null) {
        // not already registered → idempotent
        registerDetector(detector);
        added.push(detector.category);
      }
    }
  }
  return added;
}

/** Shannon entropy (bits/char) of a string. */
export function shannonEntropy(s: string): number {
  if (!s) return 0.0;
  const n = s.length;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let sum = 0;
  for (const cnt of freq.values()) {
    const ppp = cnt / n;
    sum += ppp * Math.log2(ppp);
  }
  return sum === 0 ? 0 : -sum; // normalize -0 to 0 (single-symbol strings)
}

/**
 * Register a high-entropy generic-secret detector (opt-in). Idempotent (re-tunes in place). Catches
 * opaque high-entropy tokens the anchored detectors miss — **noisy**, which is why it is off by
 * default. Category `high_entropy_secret` (group `secret`).
 */
export function enableEntropyDetector(minLength = 24, minEntropy = 3.5): Detector {
  const highEntropy = (value: string): boolean =>
    value.length >= minLength && shannonEntropy(value) >= minEntropy;

  const detector: Detector = {
    category: 'high_entropy_secret',
    group: 'secret',
    severity: 'warning',
    pattern: new RegExp(`\\b[A-Za-z0-9+/=_-]{${minLength},}\\b`, 'g'),
    validator: highEntropy,
  };
  // Idempotent + re-tunable: drop any previous instance, then append the freshly-configured one.
  const kept = DETECTORS.filter((d) => d.category !== 'high_entropy_secret');
  DETECTORS.length = 0;
  DETECTORS.push(...kept);
  registerDetector(detector);
  return detector;
}
