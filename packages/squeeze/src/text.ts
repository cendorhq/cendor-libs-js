/**
 * Python-faithful string helpers used by the compressors. JS's built-ins differ from CPython in ways
 * that matter for a byte-reproducible port: `str.splitlines()` breaks on many boundaries and drops a
 * single trailing terminator's empty line; `str.strip()` uses the Unicode whitespace set. These
 * reproduce that behavior. (Reversibility never depends on them — `expand()` returns the stored
 * original — but detection/splitting shape does.)
 */

const cc = (cp: number): string => String.fromCharCode(cp);

// CPython `str.isspace()` set: ASCII controls + NEL/NBSP + Unicode Zs + line/paragraph separators.
// Built from code points so the source stays pure-ASCII.
const PY_SPACE = new Set<string>([
  '\t',
  '\n',
  '\v',
  '\f',
  '\r',
  '\x1c',
  '\x1d',
  '\x1e',
  '\x1f',
  ' ',
  cc(0x85), // NEL
  cc(0xa0), // NBSP
  cc(0x1680),
  ...Array.from({ length: 11 }, (_, k) => cc(0x2000 + k)), // U+2000..U+200A
  cc(0x2028), // LINE SEPARATOR
  cc(0x2029), // PARAGRAPH SEPARATOR
  cc(0x202f), // NARROW NBSP
  cc(0x205f), // MEDIUM MATH SPACE
  cc(0x3000), // IDEOGRAPHIC SPACE
]);

// CPython `str.splitlines()` boundaries (besides the `\r\n` pair, handled specially).
const LINE_BOUNDARIES = new Set<string>([
  '\n',
  '\r',
  '\v',
  '\f',
  '\x1c',
  '\x1d',
  '\x1e',
  cc(0x85), // NEL
  cc(0x2028), // LINE SEPARATOR
  cc(0x2029), // PARAGRAPH SEPARATOR
]);

/** `true` if `ch` (a single char) is Python whitespace. */
export function isPySpace(ch: string): boolean {
  return PY_SPACE.has(ch);
}

/** `true` if `ch` is an ASCII digit (0-9). */
export function isAsciiDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/** Python `str.strip()` (no arg) — strip Unicode whitespace from both ends. */
export function pyStrip(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && PY_SPACE.has(s[start] as string)) start++;
  while (end > start && PY_SPACE.has(s[end - 1] as string)) end--;
  return s.slice(start, end);
}

/** Python `str.lstrip()` (no arg). */
export function pyLStrip(s: string): string {
  let start = 0;
  while (start < s.length && PY_SPACE.has(s[start] as string)) start++;
  return s.slice(start);
}

/** Python `str.rstrip()` (no arg). */
export function pyRStrip(s: string): string {
  let end = s.length;
  while (end > 0 && PY_SPACE.has(s[end - 1] as string)) end--;
  return s.slice(0, end);
}

/** Python `str.rstrip(chars)` — strip any trailing char present in `chars`. */
export function rstripChars(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1] as string)) end--;
  return s.slice(0, end);
}

/**
 * Python `str.splitlines()` (no `keepends`). Breaks on `\n`, `\r`, `\r\n`, `\v`, `\f`, the file/
 * group/record separators, NEL, and the Unicode line/paragraph separators; does not emit a trailing
 * empty line for a terminal boundary.
 */
export function splitlines(s: string): string[] {
  const out: string[] = [];
  const n = s.length;
  let i = 0;
  let start = 0;
  while (i < n) {
    const c = s[i] as string;
    if (LINE_BOUNDARIES.has(c)) {
      out.push(s.slice(start, i));
      i += c === '\r' && s[i + 1] === '\n' ? 2 : 1;
      start = i;
    } else {
      i += 1;
    }
  }
  if (start < n) out.push(s.slice(start));
  return out;
}
