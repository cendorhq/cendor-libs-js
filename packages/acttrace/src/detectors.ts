/**
 * Offline, deterministic sensitive-data detectors for `@cendor/acttrace` — the TS port of
 * `cendor.acttrace.detectors`.
 *
 * A {@link Detector} is a labelled regex plus an optional checksum/format **validator** that gates
 * loose matches (Luhn for cards, mod-97 for IBANs, Verhoeff for Aadhaar, ABA for US routing numbers,
 * range checks for SSNs). {@link DETECTORS} is the single source of truth for both scanning and
 * redaction, so the built-in `default_redactor` is rebuilt from it and the original six categories
 * still scrub byte-for-byte.
 *
 * Everything here is **local-first**: regex + arithmetic, no network, no model, no account. The
 * registry is ordered original-six-first (`email` → `bearer_token`) so redaction application order —
 * and therefore output — is unchanged for pre-existing payloads.
 *
 * Regex porting notes (vs Python `re`): the `u` flag is intentionally OFF so `\d`/`\w`/`\b` keep
 * ASCII semantics; `i` mirrors `re.IGNORECASE`; `g` is used for finditer/scan and replace.
 */

/** What a scrubbed span is replaced with. Kept identical to the original redactor's token. */
export const REDACTED = '<redacted>';

/** A single offline detector: a labelled pattern, optionally gated by a validator. */
export interface Detector {
  /** Stable, specific label recorded on findings/flags (e.g. `"credit_card"`). */
  category: string;
  /** Coarse family used for policy resolution (`"secret"`, `"pii"`, ...). */
  group: string;
  /** Recommended seriousness — `"info"` | `"warning"` | `"critical"`. */
  severity: string;
  /** Compiled regex (global-flagged). Every match is a candidate; `validator` decides if it counts. */
  pattern: RegExp;
  /** Optional `str -> bool` gate applied to each raw match (checksum/format check). */
  validator?: (value: string) => boolean;
}

// --------------------------------------------------------------------------- validators

function digits(s: string): number[] {
  const out: number[] = [];
  for (const c of s) {
    if (c >= '0' && c <= '9') out.push(c.charCodeAt(0) - 48);
  }
  return out;
}

/** Luhn (mod-10) check for a 13–19 digit payment card number. */
export function luhn(number: string): boolean {
  const d = digits(number);
  if (!(d.length >= 13 && d.length <= 19)) return false;
  let total = 0;
  const rev = [...d].reverse();
  for (let i = 0; i < rev.length; i++) {
    let digit = rev[i]!;
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    total += digit;
  }
  return total % 10 === 0;
}

/** ISO 13616 IBAN check (mod-97 == 1) after the country/check-digit rearrangement. */
export function ibanMod97(iban: string): boolean {
  const s = iban.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let numeric = '';
  for (const c of rearranged) {
    // int(c, 36): '0'-'9' -> 0-9, 'A'-'Z' -> 10-35.
    numeric += c >= '0' && c <= '9' ? c : String(c.charCodeAt(0) - 55);
  }
  return BigInt(numeric) % 97n === 1n;
}

// Verhoeff dihedral-group tables (used by the Aadhaar locale pack).
const VERHOEFF_D: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Verhoeff checksum (used for India's Aadhaar); true when the trailing digit checks out. */
export function verhoeff(number: string): boolean {
  const d = digits(number);
  let c = 0;
  const rev = [...d].reverse();
  for (let i = 0; i < rev.length; i++) {
    c = VERHOEFF_D[c]![VERHOEFF_P[i % 8]![rev[i]!]!]!;
  }
  return c === 0;
}

/** ABA routing-transit checksum for a 9-digit US routing number. */
export function abaValid(number: string): boolean {
  const d = digits(number);
  if (d.length !== 9) return false;
  const checksum =
    3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!);
  return checksum % 10 === 0;
}

/** Reject structurally-invalid US SSNs (area 000/666/900-999, group 00, serial 0000). */
export function ssnValid(ssn: string): boolean {
  const d = digits(ssn);
  if (d.length !== 9) return false;
  const area = d[0]! * 100 + d[1]! * 10 + d[2]!;
  const group = d[3]! * 10 + d[4]!;
  const serial = d[5]! * 1000 + d[6]! * 100 + d[7]! * 10 + d[8]!;
  if (area === 0 || area === 666 || area >= 900) return false;
  return group !== 0 && serial !== 0;
}

/** A candidate phone number is plausible when it carries 9–15 significant digits. */
export function phoneValid(s: string): boolean {
  const n = s.replace(/\D/g, '').length;
  return n >= 9 && n <= 15;
}

// ISO 3166-1 alpha-2 codes, used to gate SWIFT/BIC (chars 5–6 are the country) so an arbitrary
// 8-letter uppercase token isn't mistaken for a bank code.
const ISO_ALPHA2: ReadonlySet<string> = new Set(
  (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ ' +
    'BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM ' +
    'DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS ' +
    'GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN ' +
    'KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ ' +
    'MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM ' +
    'PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV ' +
    'SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI ' +
    'VN VU WF WS YE YT ZA ZM ZW'
  ).split(' '),
);

/** Structural SWIFT/BIC check: 8 or 11 chars with a valid ISO-3166 country code at 5–6. */
export function bicValid(s: string): boolean {
  return (s.length === 8 || s.length === 11) && ISO_ALPHA2.has(s.slice(4, 6));
}

// --------------------------------------------------------------------------- registry

/** Compile a pattern (always global; add `i` for IGNORECASE). No `u` flag — ASCII class semantics. */
function c(pattern: string, ignoreCase = false): RegExp {
  return new RegExp(pattern, ignoreCase ? 'gi' : 'g');
}

/**
 * The built-in detectors. Ordered original-six-first so redaction output is byte-identical for
 * pre-existing payloads. `registerDetector` appends to this list (custom detectors run last).
 */
export const DETECTORS: Detector[] = [
  // -- the original six (order preserved; email first) ------------------------------------------
  {
    category: 'email',
    group: 'pii',
    severity: 'warning',
    pattern: c('\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b'),
  },
  // openai/anthropic sk- keys incl. the hyphenated modern forms (sk-ant-…, sk-proj-…) + legacy
  {
    category: 'api_key',
    group: 'secret',
    severity: 'critical',
    pattern: c('\\bsk-[A-Za-z0-9_-]{8,}'),
  },
  {
    category: 'aws_key',
    group: 'secret',
    severity: 'critical',
    pattern: c('\\bAKIA[0-9A-Z]{16}\\b'),
  },
  {
    category: 'google_api_key',
    group: 'secret',
    severity: 'critical',
    pattern: c('\\bAIza[0-9A-Za-z_-]{35}\\b'),
  },
  {
    category: 'jwt',
    group: 'secret',
    severity: 'critical',
    pattern: c('\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}'),
  },
  {
    category: 'bearer_token',
    group: 'secret',
    severity: 'critical',
    pattern: c('\\b[Bb]earer\\s+[A-Za-z0-9._-]+\\b'),
  },
  // -- additional secrets ----------------------------------------------------------------------
  {
    category: 'github_token',
    group: 'secret',
    severity: 'critical',
    pattern: c('\\bgh[pousr]_[A-Za-z0-9]{36,}\\b'),
  },
  {
    category: 'slack_token',
    group: 'secret',
    severity: 'critical',
    pattern: c('\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b'),
  },
  {
    category: 'private_key',
    group: 'secret',
    severity: 'critical',
    pattern: c('-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----'),
  },
  // -- free-text credentials -------------------------------------------------------------------
  {
    category: 'password',
    group: 'credential',
    severity: 'critical',
    pattern: c('\\b(?:password|passphrase|passwd|pwd)\\b\\s*(?:is|:|=)\\s*\\S+', true),
  },
  // -- financial (validator-gated) -------------------------------------------------------------
  {
    category: 'credit_card',
    group: 'financial',
    severity: 'critical',
    pattern: c('\\b\\d(?:[ -]?\\d){12,18}\\b'),
    validator: luhn,
  },
  {
    category: 'iban',
    group: 'financial',
    severity: 'critical',
    pattern: c('\\b[A-Z]{2}\\d{2}[A-Z0-9]{11,30}\\b'),
    validator: ibanMod97,
  },
  {
    category: 'us_routing',
    group: 'financial',
    severity: 'critical',
    pattern: c('\\b\\d{9}\\b'),
    validator: abaValid,
  },
  {
    category: 'swift_bic',
    group: 'financial',
    severity: 'critical',
    pattern: c('\\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\\b'),
    validator: bicValid,
  },
  // -- government IDs (validator-gated) --------------------------------------------------------
  {
    category: 'us_ssn',
    group: 'gov_id',
    severity: 'critical',
    pattern: c('\\b\\d{3}-\\d{2}-\\d{4}\\b'),
    validator: ssnValid,
  },
  // -- remaining PII ---------------------------------------------------------------------------
  {
    category: 'phone',
    group: 'pii',
    severity: 'warning',
    pattern: c(
      '(?<!\\w)(?:\\+?1[ .\\-]?)?(?:\\(\\d{3}\\)[ .\\-]?|\\d{3}[ .\\-])\\d{3}[ .\\-]\\d{4}(?!\\d)' +
        '|(?<!\\w)\\+\\d{9,15}(?!\\d)',
    ),
    validator: phoneValid,
  },
  {
    category: 'ipv4',
    group: 'pii',
    severity: 'warning',
    pattern: c(
      '\\b(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}' +
        '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\b',
    ),
  },
  {
    category: 'ipv6',
    group: 'pii',
    severity: 'warning',
    pattern: c(
      '\\b(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}\\b' +
        '|\\b(?:[A-Fa-f0-9]{1,4}:){1,7}:(?:[A-Fa-f0-9]{1,4}\\b)?',
    ),
  },
  {
    category: 'mac_address',
    group: 'pii',
    severity: 'warning',
    pattern: c('\\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\\b'),
  },
  // -- GDPR Art.9 special categories (best-effort keyword lexicon) -----------------------------
  {
    category: 'special_category',
    group: 'special_category',
    severity: 'warning',
    pattern: c(
      '\\b(?:diagnos(?:is|es|ed)?|hiv|pregnan(?:t|cy)|disab(?:led|ility)|biometric|' +
        'fingerprints?|genetic|ethnicity|religio(?:n|us))\\b',
      true,
    ),
  },
];

/** Add a custom {@link Detector} to the global registry (it runs after the built-ins). */
export function registerDetector(detector: Detector): void {
  DETECTORS.push(detector);
}

/** A copy of the active detector registry (built-ins plus anything registered). */
export function detectors(): Detector[] {
  return [...DETECTORS];
}

/** The group a category belongs to per the active registry (`null` if unknown). */
export function groupOf(category: string): string | null {
  for (const d of DETECTORS) {
    if (d.category === category) return d.group;
  }
  return null;
}

// --------------------------------------------------------------------------- scan / scrub

/** A plain `{}`-shaped object (a JSON dict), not a wrapper instance like `PyFloat` or a Date. */
function isPlainObject(o: unknown): o is Record<string, unknown> {
  if (o === null || typeof o !== 'object') return false;
  const proto = Object.getPrototypeOf(o);
  return proto === Object.prototype || proto === null;
}

/**
 * Walk `obj` (str/dict/list) and count validated matches per category. Returns an insertion-ordered
 * map `category -> [detector, occurrences]` accumulated across the walk. Never returns raw values.
 */
export function scanCounts(obj: unknown): Map<string, [Detector, number]> {
  const counts = new Map<string, [Detector, number]>();

  const walk = (o: unknown): void => {
    if (typeof o === 'string') {
      for (const det of DETECTORS) {
        let n = 0;
        for (const match of o.matchAll(det.pattern)) {
          const value = match[0];
          if (det.validator === undefined || det.validator(value)) n += 1;
        }
        if (n) {
          const slot = counts.get(det.category);
          if (slot === undefined) counts.set(det.category, [det, n]);
          else slot[1] += n;
        }
      }
    } else if (Array.isArray(o)) {
      for (const v of o) walk(v);
    } else if (isPlainObject(o)) {
      for (const v of Object.values(o)) walk(v);
    }
  };

  walk(obj);
  return counts;
}

/**
 * Return a copy of `obj` with every span matching a category in `categories` replaced. Applies
 * detectors in **registry order** (original six first), so output is byte-identical to the historical
 * redactor. Validator-gated detectors only scrub the spans that actually validate.
 */
export function scrub<T>(obj: T, categories: Iterable<string>): T {
  const wanted = new Set(categories);
  const active = DETECTORS.filter((d) => wanted.has(d.category));
  if (active.length === 0) return obj;

  const subs = active.map((det): [RegExp, (m: string) => string] => {
    const validator = det.validator;
    if (validator === undefined) return [det.pattern, () => REDACTED];
    return [det.pattern, (m: string) => (validator(m) ? REDACTED : m)];
  });

  const go = (o: unknown): unknown => {
    if (typeof o === 'string') {
      let out = o;
      for (const [pattern, repl] of subs) {
        out = out.replace(pattern, (m: string) => repl(m));
      }
      return out;
    }
    if (Array.isArray(o)) return o.map(go);
    if (isPlainObject(o)) {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) result[k] = go(v);
      return result;
    }
    return o;
  };

  return go(obj) as T;
}
