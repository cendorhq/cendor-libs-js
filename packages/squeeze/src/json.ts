/**
 * A tiny order-preserving JSON parser + a serializer that mirrors Python's
 * `json.dumps(obj, ensure_ascii=False, separators=(",", ":"))` as closely as practical.
 *
 * Why not `JSON.parse` / `JSON.stringify`? Three Python behaviors must be reproduced for byte-close
 * output: (1) object key order is document order (JS objects reorder integer-like keys, so parsed
 * objects are `Map`s here); (2) duplicate keys keep the last value; (3) an integer-valued *float*
 * literal (`1.0`, `1e5`) serializes with a trailing `.0` (`"1.0"`, `"100000.0"`) where JS would emit
 * `"1"`. Numbers are therefore carried as raw source tokens (`JNum`). String escaping already matches
 * (`JSON.stringify` of a string == Python `ensure_ascii=False` for the C0 range, `"`, and `\\`).
 *
 * Reversibility never depends on this: `expand()` returns the stored original verbatim.
 */

/** A JSON number carried as its raw source token, so int/float formatting round-trips. */
export class JNum {
  constructor(public readonly raw: string) {}
}

/** The parsed-JSON value tree. Objects are `Map` (ordered), arrays are arrays, numbers are `JNum`. */
export type JVal = null | boolean | string | JNum | JVal[] | Map<string, JVal>;

const WS = new Set([' ', '\t', '\n', '\r']);

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  parse(): JVal {
    this.ws();
    const v = this.value();
    this.ws();
    if (this.i !== this.s.length) throw new SyntaxError(`trailing content at ${this.i}`);
    return v;
  }

  private ws(): void {
    while (this.i < this.s.length && WS.has(this.s[this.i] as string)) this.i++;
  }

  private value(): JVal {
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
    throw new SyntaxError(`unexpected token '${String(c)}' at ${this.i}`);
  }

  private object(): Map<string, JVal> {
    const obj = new Map<string, JVal>();
    this.i++; // {
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return obj;
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') throw new SyntaxError(`expected key string at ${this.i}`);
      const key = this.string();
      this.ws();
      if (this.s[this.i] !== ':') throw new SyntaxError(`expected ':' at ${this.i}`);
      this.i++;
      this.ws();
      obj.set(key, this.value()); // duplicate keys: last wins (Map.set overwrites, keeps position)
      this.ws();
      const ch = this.s[this.i];
      if (ch === ',') {
        this.i++;
        continue;
      }
      if (ch === '}') {
        this.i++;
        return obj;
      }
      throw new SyntaxError(`expected ',' or '}' at ${this.i}`);
    }
  }

  private array(): JVal[] {
    const arr: JVal[] = [];
    this.i++; // [
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      return arr;
    }
    for (;;) {
      this.ws();
      arr.push(this.value());
      this.ws();
      const ch = this.s[this.i];
      if (ch === ',') {
        this.i++;
        continue;
      }
      if (ch === ']') {
        this.i++;
        return arr;
      }
      throw new SyntaxError(`expected ',' or ']' at ${this.i}`);
    }
  }

  private string(): string {
    this.i++; // opening quote
    let out = '';
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined) throw new SyntaxError('unterminated string');
      if (c === '"') return out;
      if (c === '\\') {
        const e = this.s[this.i++];
        switch (e) {
          case '"':
            out += '"';
            break;
          case '\\':
            out += '\\';
            break;
          case '/':
            out += '/';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'u': {
            const hex = this.s.slice(this.i, this.i + 4);
            if (hex.length !== 4) throw new SyntaxError('bad \\u escape');
            this.i += 4;
            out += String.fromCharCode(Number.parseInt(hex, 16));
            break;
          }
          default:
            throw new SyntaxError(`bad escape \\${String(e)}`);
        }
      } else {
        out += c;
      }
    }
  }

  private number(): JNum {
    const start = this.i;
    if (this.s[this.i] === '-') this.i++;
    let sawDigit = false;
    while (this.i < this.s.length) {
      const c = this.s[this.i] as string;
      if (c >= '0' && c <= '9') {
        sawDigit = true;
        this.i++;
      } else if (c === '.' || c === 'e' || c === 'E' || c === '+' || c === '-') {
        this.i++;
      } else {
        break;
      }
    }
    if (!sawDigit) throw new SyntaxError(`invalid number at ${start}`);
    return new JNum(this.s.slice(start, this.i));
  }
}

/** Parse standard JSON into the ordered `JVal` tree. Throws `SyntaxError` on invalid input. */
export function parseJson(text: string): JVal {
  return new Parser(text).parse();
}

function formatNumberToken(raw: string): string {
  // Integer literal: emit the exact digits (Python `int` -> same string, exact for big ints too).
  if (!/[.eE]/.test(raw)) return raw;
  // Float literal: match Python's `repr(float)` for the common cases. Integer-valued floats keep a
  // trailing ".0"; anything JS already prints with a '.'/'e' (1.5, 1e+21) is left as-is.
  const n = Number(raw);
  let s = String(n);
  if (!/[.eE]/.test(s)) s += '.0';
  return s;
}

/**
 * Serialize a value the way Python's compact `json.dumps` would. Accepts both the parsed `JVal` tree
 * (`Map`/`JNum`) and plain JS values (used for object input, where numbers are plain `number`).
 */
export function dumps(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (v instanceof JNum) return formatNumberToken(v.raw);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : Number.isNaN(v) ? 'NaN' : '-Infinity';
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(dumps).join(',')}]`;
  if (v instanceof Map) {
    const parts: string[] = [];
    for (const [k, val] of v) parts.push(`${JSON.stringify(String(k))}:${dumps(val)}`);
    return `{${parts.join(',')}}`;
  }
  if (typeof v === 'object') {
    const parts: string[] = [];
    for (const k of Object.keys(v as object)) {
      const val = (v as Record<string, unknown>)[k];
      if (val === undefined) continue; // JS undefined has no JSON form (JSON.stringify drops it)
      parts.push(`${JSON.stringify(k)}:${dumps(val)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return 'null';
}
