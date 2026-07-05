/**
 * A JSON parser that decodes every number as a `Decimal` instead of an IEEE double — the TS mirror of
 * Python's `json.loads(text, parse_float=Decimal)`. The price-dataset spec mandates that rates (money)
 * never round-trip through binary floating point in any language, so both the bundled snapshot and any
 * `refresh()`ed table are parsed through this. Dependency-free recursive-descent parser.
 */
import { Dec, type Decimal } from './decimal.js';

export type DecimalJsonValue =
  | null
  | boolean
  | string
  | Decimal
  | DecimalJsonValue[]
  | { [key: string]: DecimalJsonValue };

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  parse(): DecimalJsonValue {
    this.ws();
    const value = this.value();
    this.ws();
    if (this.i !== this.s.length) throw new SyntaxError(`Unexpected trailing content at ${this.i}`);
    return value;
  }

  private ws(): void {
    while (this.i < this.s.length) {
      const c = this.s.charCodeAt(this.i);
      // space, tab, newline, carriage return
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.i++;
      else break;
    }
  }

  private value(): DecimalJsonValue {
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
    throw new SyntaxError(`Unexpected token '${c}' at ${this.i}`);
  }

  private object(): { [key: string]: DecimalJsonValue } {
    const obj: { [key: string]: DecimalJsonValue } = {};
    this.i++; // {
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return obj;
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') throw new SyntaxError(`Expected key string at ${this.i}`);
      const key = this.string();
      this.ws();
      if (this.s[this.i] !== ':') throw new SyntaxError(`Expected ':' at ${this.i}`);
      this.i++;
      this.ws();
      obj[key] = this.value();
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
      throw new SyntaxError(`Expected ',' or '}' at ${this.i}`);
    }
  }

  private array(): DecimalJsonValue[] {
    const arr: DecimalJsonValue[] = [];
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
      throw new SyntaxError(`Expected ',' or ']' at ${this.i}`);
    }
  }

  private string(): string {
    this.i++; // opening quote
    let out = '';
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined) throw new SyntaxError('Unterminated string');
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
            this.i += 4;
            out += String.fromCharCode(Number.parseInt(hex, 16));
            break;
          }
          default:
            throw new SyntaxError(`Bad escape \\${e}`);
        }
      } else {
        out += c;
      }
    }
  }

  private number(): Decimal {
    const start = this.i;
    if (this.s[this.i] === '-') this.i++;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (
        (c !== undefined && c >= '0' && c <= '9') ||
        c === '.' ||
        c === 'e' ||
        c === 'E' ||
        c === '+' ||
        c === '-'
      ) {
        this.i++;
      } else {
        break;
      }
    }
    const token = this.s.slice(start, this.i);
    // Pass the raw token straight to Decimal so precision is preserved (never through a JS number).
    return new Dec(token);
  }
}

export function parseDecimalJson(text: string): DecimalJsonValue {
  return new Parser(text).parse();
}
