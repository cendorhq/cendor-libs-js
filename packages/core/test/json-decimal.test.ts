/**
 * Direct unit suite for the hand-rolled `parseDecimalJson` (json-decimal.ts) — the money-path guard
 * that decodes every JSON number as a `Decimal` (never an IEEE double), the TS mirror of Python's
 * `json.loads(text, parse_float=Decimal)`. Covers escapes, exponents, deep nesting, malformed input,
 * duplicate keys, and — the whole point — precision preservation on values a JS number would corrupt.
 */
import { describe, expect, it } from 'vitest';
import { Dec, type Decimal } from '../src/decimal.js';
import { type DecimalJsonValue, parseDecimalJson } from '../src/json-decimal.js';

/** Narrow a parsed value to a Decimal (every JSON number decodes to one). */
function dec(v: DecimalJsonValue): Decimal {
  return v as Decimal;
}

describe('parseDecimalJson', () => {
  describe('numbers decode to Decimal (never a JS number)', () => {
    it('returns a Decimal object, not a primitive number', () => {
      const v = parseDecimalJson('42');
      expect(typeof v).toBe('object');
      expect(dec(v).eq(new Dec('42'))).toBe(true);
    });

    it('preserves integer precision beyond 2^53 (a double would round it)', () => {
      // 2^53 + 1 = 9007199254740993; as a JS double it collapses to ...992.
      const v = dec(parseDecimalJson('9007199254740993'));
      expect(v.toString()).toBe('9007199254740993');
      expect(Number('9007199254740993')).toBe(9007199254740992); // proof the double would lose it
    });

    it('preserves fractional money precision (no float round-trip)', () => {
      const v = dec(parseDecimalJson('0.1234567890123456789'));
      expect(v.toString()).toBe('0.1234567890123456789');
    });

    it('parses negatives and zero', () => {
      expect(dec(parseDecimalJson('-2.5')).eq(new Dec('-2.5'))).toBe(true);
      expect(dec(parseDecimalJson('0')).eq(new Dec('0'))).toBe(true);
      expect(dec(parseDecimalJson('-0')).eq(new Dec('0'))).toBe(true);
    });

    it('parses exponents (lower/upper e, signed)', () => {
      expect(dec(parseDecimalJson('1e3')).eq(new Dec('1000'))).toBe(true);
      expect(dec(parseDecimalJson('1.5E-2')).eq(new Dec('0.015'))).toBe(true);
      expect(dec(parseDecimalJson('-2.5e+10')).eq(new Dec('-25000000000'))).toBe(true);
    });

    it('keeps a rate exact through a nested object (the real price-snapshot shape)', () => {
      const parsed = parseDecimalJson('{"gpt-4o":{"input":0.0000025,"output":0.00001}}') as {
        [k: string]: { [k: string]: DecimalJsonValue };
      };
      expect(dec(parsed['gpt-4o']!.input!).toString()).toBe('0.0000025');
      expect(dec(parsed['gpt-4o']!.output!).toString()).toBe('0.00001');
    });
  });

  describe('strings + escapes', () => {
    it('decodes every JSON escape', () => {
      expect(parseDecimalJson('"a\\"b\\\\c\\/d"')).toBe('a"b\\c/d');
      expect(parseDecimalJson('"\\b\\f\\n\\r\\t"')).toBe('\b\f\n\r\t');
    });

    it('decodes \\uXXXX escapes', () => {
      expect(parseDecimalJson('"\\u0041\\u00e9"')).toBe('Aé');
    });

    it('passes plain unicode through', () => {
      expect(parseDecimalJson('"héllo 世界"')).toBe('héllo 世界');
    });
  });

  describe('composites', () => {
    it('parses booleans and null', () => {
      expect(parseDecimalJson('true')).toBe(true);
      expect(parseDecimalJson('false')).toBe(false);
      expect(parseDecimalJson('null')).toBe(null);
    });

    it('parses empty and nested containers', () => {
      expect(parseDecimalJson('{}')).toEqual({});
      expect(parseDecimalJson('[]')).toEqual([]);
    });

    it('handles deep nesting without overflow', () => {
      const depth = 200;
      const text = `${'['.repeat(depth)}1${']'.repeat(depth)}`;
      let cur = parseDecimalJson(text);
      for (let d = 0; d < depth; d++) {
        expect(Array.isArray(cur)).toBe(true);
        cur = (cur as DecimalJsonValue[])[0]!;
      }
      expect(dec(cur).eq(new Dec('1'))).toBe(true);
    });

    it('tolerates whitespace around tokens', () => {
      expect(parseDecimalJson('  {\n "a" : [ 1 , 2 ]\t}\n')).toEqual({
        a: [expect.anything(), expect.anything()],
      });
    });

    it('last value wins on duplicate keys (JSON object semantics)', () => {
      const v = parseDecimalJson('{"a":1,"a":2}') as { [k: string]: DecimalJsonValue };
      expect(dec(v.a!).eq(new Dec('2'))).toBe(true);
      expect(Object.keys(v)).toEqual(['a']);
    });
  });

  describe('malformed input throws SyntaxError', () => {
    const bad: Array<[string, string]> = [
      ['trailing content', '1 2'],
      ['unterminated string', '"abc'],
      ['bad escape', '"a\\x"'],
      ['unexpected token', 'nope'],
      ['missing colon', '{"a" 1}'],
      ['missing comma / close', '{"a":1 "b":2}'],
      ['non-string key', '{1:2}'],
      ['empty input', ''],
      ['dangling comma then EOF', '[1,'],
    ];
    for (const [label, input] of bad) {
      it(label, () => {
        expect(() => parseDecimalJson(input)).toThrow(SyntaxError);
      });
    }
  });
});
