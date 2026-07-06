/**
 * Python-`json`-compatible serialization + a number-preserving parser — the cross-language
 * conformance backbone shared (vendored) by @cendor/cassette and @cendor/acttrace.
 *
 * Reproduces `json.dumps(..., ensure_ascii=False)` byte-for-byte for Cendor's value shapes:
 *  - strings/bools/null: via `JSON.stringify` (JS matches Python's ensure_ascii=False escaping —
 *    same control-char escapes, `/` unescaped, non-ASCII raw, U+2028/U+2029 raw).
 *  - integers: `bigint` (or an integer-valued producer `number`) -> decimal string (no `.0`, no exp).
 *  - floats: `PyFloat` wrapper (or a non-integer producer `number`) -> Python `repr(float)` form.
 *
 * The int/float distinction is the #1 hazard: `JSON.parse` collapses `2.0` and `2`. So the VERIFIER
 * side must parse with {@link parsePreserving} (tags each number token int vs float from its literal).
 * The PRODUCER side builds payloads with plain numbers; integer-valued numbers serialize as ints
 * (self-consistent and Python-verifiable — Python re-reads `"12"` as int too).
 */

export class PyFloat {
  constructor(public readonly value: number) {}
}

export type PyValue =
  | null
  | boolean
  | string
  | number
  | bigint
  | PyFloat
  | PyValue[]
  | { [key: string]: PyValue };

/** Python `repr(float)`-compatible string (exact for finite non-exponential values; best-effort exp). */
export function pyFloatRepr(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Number.POSITIVE_INFINITY) return 'Infinity';
  if (n === Number.NEGATIVE_INFINITY) return '-Infinity';
  let s = n.toString();
  if (s.includes('e') || s.includes('E')) {
    const m = s.match(/^(-?)(\d+(?:\.\d+)?)[eE]([+-]?)(\d+)$/);
    if (m) {
      const sign = m[1] ?? '';
      const mant = m[2] ?? '';
      const esign = m[3] === '-' ? '-' : '+';
      const edig = m[4] ?? '';
      s = `${sign}${mant}e${esign}${edig.length < 2 ? `0${edig}` : edig}`;
    }
    return s;
  }
  if (!s.includes('.')) s += '.0';
  return s;
}

function numberToken(v: number | bigint | PyFloat): string {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof PyFloat) return pyFloatRepr(v.value);
  if (Number.isInteger(v)) return Number.isSafeInteger(v) ? BigInt(v).toString() : v.toString();
  return pyFloatRepr(v);
}

/** Sort by Unicode code point (Python `sort_keys`), not UTF-16 code unit. */
function codePointCompare(a: string, b: string): number {
  const ia = Array.from(a);
  const ib = Array.from(b);
  const n = Math.min(ia.length, ib.length);
  for (let i = 0; i < n; i++) {
    const ca = ia[i]!.codePointAt(0)!;
    const cb = ib[i]!.codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
  return ia.length - ib.length;
}

interface SerOptions {
  sortKeys: boolean;
  indent: number | null;
  compact: boolean; // compact => separators (",",":"); else (", ", ": ")
}

function serialize(v: PyValue, opts: SerOptions, depth: number): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'bigint' || v instanceof PyFloat) return numberToken(v);

  const pad = opts.indent !== null ? `\n${' '.repeat(opts.indent * (depth + 1))}` : '';
  const padEnd = opts.indent !== null ? `\n${' '.repeat(opts.indent * depth)}` : '';
  const itemSep = opts.indent !== null ? `,${pad}` : opts.compact ? ',' : ', ';
  const kvSep = opts.compact ? ':' : ': ';

  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    const items = v.map((x) => serialize(x, opts, depth + 1));
    return `[${pad}${items.join(itemSep)}${padEnd}]`;
  }
  let keys = Object.keys(v);
  if (opts.sortKeys) keys = keys.sort(codePointCompare);
  if (keys.length === 0) return '{}';
  const items = keys.map(
    (k) => `${JSON.stringify(k)}${kvSep}${serialize(v[k] as PyValue, opts, depth + 1)}`,
  );
  return `{${pad}${items.join(itemSep)}${padEnd}}`;
}

/** `json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",",":"))` — the HASH input. */
export function canonical(v: PyValue): string {
  return serialize(v, { sortKeys: true, indent: null, compact: true }, 0);
}

/** `json.dumps(obj, ensure_ascii=False)` — insertion order, spaces after `,`/`:` (acttrace JSONL). */
export function dumpsDefault(v: PyValue): string {
  return serialize(v, { sortKeys: false, indent: null, compact: false }, 0);
}

/** `json.dumps(obj, indent=2, ensure_ascii=False)` — insertion order, 2-space indent (cassette file). */
export function dumpsIndent2(v: PyValue): string {
  return serialize(v, { sortKeys: false, indent: 2, compact: false }, 0);
}

// --------------------------------------------------------------------------- number-preserving parse

class PreservingParser {
  private i = 0;
  constructor(private readonly s: string) {}

  parse(): PyValue {
    this.ws();
    const v = this.value();
    this.ws();
    if (this.i !== this.s.length) throw new SyntaxError(`trailing content at ${this.i}`);
    return v;
  }
  private ws(): void {
    while (this.i < this.s.length) {
      const c = this.s.charCodeAt(this.i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.i++;
      else break;
    }
  }
  private value(): PyValue {
    const c = this.s[this.i];
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    if (c === '"') return this.string();
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return this.number();
    if (this.s.startsWith('true', this.i)) {
      this.i += 4;
      return true;
    }
    if (this.s.startsWith('false', this.i)) {
      this.i += 5;
      return false;
    }
    if (this.s.startsWith('null', this.i)) {
      this.i += 4;
      return null;
    }
    throw new SyntaxError(`unexpected '${c}' at ${this.i}`);
  }
  private object(): { [key: string]: PyValue } {
    const o: { [key: string]: PyValue } = {};
    this.i++;
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return o;
    }
    for (;;) {
      this.ws();
      const k = this.string();
      this.ws();
      if (this.s[this.i] !== ':') throw new SyntaxError(`expected ':' at ${this.i}`);
      this.i++;
      this.ws();
      o[k] = this.value();
      this.ws();
      const ch = this.s[this.i];
      if (ch === ',') {
        this.i++;
        continue;
      }
      if (ch === '}') {
        this.i++;
        return o;
      }
      throw new SyntaxError(`expected ',' or '}' at ${this.i}`);
    }
  }
  private array(): PyValue[] {
    const a: PyValue[] = [];
    this.i++;
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      return a;
    }
    for (;;) {
      this.ws();
      a.push(this.value());
      this.ws();
      const ch = this.s[this.i];
      if (ch === ',') {
        this.i++;
        continue;
      }
      if (ch === ']') {
        this.i++;
        return a;
      }
      throw new SyntaxError(`expected ',' or ']' at ${this.i}`);
    }
  }
  private string(): string {
    if (this.s[this.i] !== '"') throw new SyntaxError(`expected string at ${this.i}`);
    const start = this.i;
    this.i++;
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined) throw new SyntaxError('unterminated string');
      if (c === '"') break;
      if (c === '\\') this.i++;
    }
    // Reuse JSON.parse for exact unescaping (inverse of JSON.stringify).
    return JSON.parse(this.s.slice(start, this.i)) as string;
  }
  private number(): bigint | PyFloat {
    const start = this.i;
    if (this.s[this.i] === '-') this.i++;
    let isFloat = false;
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c >= '0' && c <= '9') this.i++;
      else if (c === '.' || c === 'e' || c === 'E' || c === '+' || c === '-') {
        isFloat = isFloat || c === '.' || c === 'e' || c === 'E';
        this.i++;
      } else break;
    }
    const token = this.s.slice(start, this.i);
    return isFloat ? new PyFloat(Number(token)) : BigInt(token);
  }
}

/** Parse JSON preserving int (`bigint`) vs float ({@link PyFloat}) from each numeric literal. */
export function parsePreserving(text: string): PyValue {
  return new PreservingParser(text).parse();
}
