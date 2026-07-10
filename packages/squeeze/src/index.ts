/**
 * `@cendor/squeeze` — content-aware, reversible context compression. The TS port of
 * `cendor.squeeze`.
 *
 * Shrink verbose context without throwing anything away: {@link compress} returns `[small, handle]`
 * and `handle.expand()` restores the original on demand. Content is routed by type — JSON, logs,
 * code, and prose each get a purpose-built, deterministic compressor (no LLM). Reversibility is
 * guaranteed by a content-addressed store (CCR): every original is kept keyed by its hash, deduped
 * across calls, so `expand()` is always exact no matter how hard we squeeze.
 *
 * Satisfies `@cendor/core`'s `Compressor` protocol by shape (see {@link SqueezeCompressor}).
 */
import { createHash } from 'node:crypto';
import { tokens } from '@cendor/core';
import { type JVal, dumps, parseJson } from './json.js';
import { MemoryStore, type StoreBackend } from './store.js';
import {
  isAsciiDigit,
  isPySpace,
  pyLStrip,
  pyRStrip,
  pyStrip,
  rstripChars,
  splitlines,
} from './text.js';

export { KeyError, MemoryStore, SQLiteStore } from './store.js';
export type { StoreBackend } from './store.js';

/** Content kind: `"auto"` (detect + route) or a forced compressor. */
export type Kind = 'auto' | 'json' | 'logs' | 'code' | 'prose';
/** How hard to squeeze. Reversibility is unaffected — the original is always in the handle. */
export type Fidelity = 'lossless' | 'balanced' | 'aggressive';

const FIDELITY: readonly Fidelity[] = ['lossless', 'balanced', 'aggressive'];
const TIMES = String.fromCharCode(0xd7); // U+00D7 MULTIPLICATION SIGN (not ASCII 'x')

/** Raised on invalid `fidelity` (mirrors Python's `ValueError`). */
class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

function pyRepr(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// --------------------------------------------------------------------------- CCR backend

// Active content-addressed store: sha256(original) -> original. Deduped; the basis of reversibility.
// Default in-process; swap via useStore() for a persistent backend.
let backend: StoreBackend = new MemoryStore();

/**
 * Swap the CCR backend (e.g. `SQLiteStore`); returns the previous one. A backend is any object with
 * `get(key) -> string` and `put(key, value) -> void`. Handles expand against whichever backend is
 * active at expand time.
 *
 * @example
 * ```ts
 * import { SQLiteStore, useStore } from '@cendor/squeeze';
 * useStore(new SQLiteStore('cache.db'));   // persist originals across processes
 * ```
 */
export function useStore(store: StoreBackend): StoreBackend {
  const previous = backend;
  backend = store;
  return previous;
}

/** The active backend (test/inspection accessor; not part of the stable public surface). */
export function _backend(): StoreBackend {
  return backend;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function store(original: string): string {
  const key = sha256Hex(original);
  backend.put(key, original);
  return key;
}

// --------------------------------------------------------------------------- Handle

/** Restore handle for a compression. `expand()` returns the exact original. */
export class Handle {
  constructor(
    public id: string,
    public kind: string,
    public originalRef: string,
    public restoreMap: Record<string, unknown> = {},
  ) {}

  /** Return the original content, byte-for-byte (from the active CCR backend). */
  expand(): string {
    return backend.get(this.originalRef);
  }

  /** The compression technique recorded for this handle (e.g. `"minify+dropnulls"`). */
  get technique(): string {
    const t = this.restoreMap.technique;
    return t === undefined || t === null ? '' : String(t);
  }

  /**
   * Serialize the handle (not the original). Persist it alongside a durable store. Python casing is
   * `to_dict` / `from_dict`; the TS surface is camelCase.
   *
   * @example
   * ```ts
   * import { compress, Handle } from '@cendor/squeeze';
   * const [, handle] = compress('some verbose log line…');
   * const data = handle.toDict();                    // persist this JSON
   * const original = Handle.fromDict(data).expand(); // rebuild + restore later
   * ```
   */
  toDict(): Record<string, unknown> {
    return {
      id: this.id,
      kind: this.kind,
      original_ref: this.originalRef,
      restore_map: { ...this.restoreMap },
    };
  }

  /**
   * Rebuild a handle from {@link toDict}; `expand()` resolves via the active store. Python casing is
   * `from_dict`.
   *
   * @example
   * ```ts
   * import { Handle } from '@cendor/squeeze';
   * const data = { id: 'x', kind: 'json', original_ref: 'abc123', restore_map: {} };
   * const handle = Handle.fromDict(data);   // rebuild a persisted handle
   * ```
   */
  static fromDict(data: Record<string, unknown>): Handle {
    return new Handle(String(data.id), String(data.kind), String(data.original_ref), {
      ...((data.restore_map as Record<string, unknown> | undefined) ?? {}),
    });
  }
}

// --------------------------------------------------------------------------- detection

const TS_SRC =
  '\\b\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?\\b';
const UUID_SRC = '\\b[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\\b';
const IP_SRC = '\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b';
const HEX_SRC = '\\b0x[0-9a-fA-F]+\\b|\\b[0-9a-fA-F]{8,}\\b';
const INT_SRC = '\\b\\d+\\b';

// Global variants for `.replace` (all occurrences); non-global for `.test` (stateless).
const TS_RE = new RegExp(TS_SRC, 'g');
const UUID_RE = new RegExp(UUID_SRC, 'g');
const IP_RE = new RegExp(IP_SRC, 'g');
const HEX_RE = new RegExp(HEX_SRC, 'g');
const INT_RE = new RegExp(INT_SRC, 'g');
const TS_SEARCH = new RegExp(TS_SRC);
const LEVEL_RE = /\b(?:DEBUG|INFO|WARN|WARNING|ERROR|CRITICAL|TRACE|FATAL)\b/;

const CODE_MARKERS = [
  'def ',
  'class ',
  'function ',
  'func ',
  'import ',
  'from ',
  'return ',
  'const ',
  'let ',
  'var ',
  'public ',
  'private ',
  '#include',
  '=>',
  '</',
];

// Preprocessor/import directives that begin with `#` but must NOT be stripped as comments.
const PREPROC_STICKY =
  /#\s*(?:include|define|undef|ifdef|ifndef|endif|else|elif|if|pragma|error|line|import)\b/y;

/** Detect the content kind: `"json"` | `"logs"` | `"code"` | `"prose"`. */
export function detect(content: string): 'json' | 'logs' | 'code' | 'prose' {
  const s = pyStrip(content);
  if (s === '') return 'prose';
  const c0 = s[0];
  if (c0 === '{' || c0 === '[') {
    try {
      parseJson(s);
      return 'json';
    } catch {
      // not JSON — fall through
    }
  }
  if (looksLikeLogs(s)) return 'logs';
  if (looksLikeCode(s)) return 'code';
  return 'prose';
}

function nonBlankLines(s: string): string[] {
  return splitlines(s).filter((ln) => pyStrip(ln) !== '');
}

function looksLikeLogs(s: string): boolean {
  const lines = nonBlankLines(s);
  if (lines.length < 3) return false;
  let hits = 0;
  for (const ln of lines) if (TS_SEARCH.test(ln) || LEVEL_RE.test(ln)) hits++;
  return hits >= lines.length * 0.5;
}

function looksLikeCode(s: string): boolean {
  const lines = nonBlankLines(s);
  if (lines.length === 0) return false;
  let hits = 0;
  for (const ln of lines) {
    const st = pyStrip(ln);
    const endsSpecial =
      st.endsWith('{') || st.endsWith('}') || st.endsWith(';') || st.endsWith(':');
    if (CODE_MARKERS.some((m) => ln.includes(m)) || endsSpecial) hits++;
  }
  return hits >= Math.max(1, lines.length * 0.3);
}

// --------------------------------------------------------------------------- public API

/** Options for {@link compress} (Python keyword args -> a trailing options object). */
export interface CompressOptions {
  kind?: Kind;
  targetTokens?: number | null;
  model?: string;
  fidelity?: Fidelity;
}

/**
 * Compress `content` and return `[small, handle]`. `handle.expand()` restores it byte-for-byte.
 *
 * @param content A string, or a JSON-serializable object/array.
 * @param opts `kind` (`"auto"` detects), `targetTokens` (best-effort budget, never exceeded),
 *   `model` (for token counting, default `"gpt-4o"`), `fidelity` (`"lossless" | "balanced" |
 *   "aggressive"`, default `"balanced"`).
 *
 * @example
 * ```ts
 * import { compress } from '@cendor/squeeze';
 * const [small, handle] = compress({ id: 42, items: [], meta: null }, { kind: 'json', fidelity: 'balanced' });
 * const original = handle.expand();   // reversible — exact byte-for-byte restore
 * ```
 */
export function compress(content: unknown, opts: CompressOptions = {}): [string, Handle] {
  const fidelity = opts.fidelity ?? 'balanced';
  const targetTokens = opts.targetTokens ?? null;
  const model = opts.model ?? 'gpt-4o';
  let kind: string = opts.kind ?? 'auto';

  if (!FIDELITY.includes(fidelity)) {
    throw new ValueError(
      `fidelity must be one of ('lossless', 'balanced', 'aggressive'), got ${pyRepr(String(fidelity))}`,
    );
  }

  let original: string;
  if (typeof content === 'string') {
    original = content;
  } else {
    const t = typeof content;
    if (content === undefined || t === 'bigint' || t === 'function' || t === 'symbol') {
      const got = content === undefined ? 'undefined' : t;
      throw new ValueError(
        `compress() takes a string or a JSON-serializable object/array; got ${got}, which cannot be encoded as JSON.`,
      );
    }
    original = dumps(content);
    if (kind === 'auto') kind = 'json';
  }

  if (kind === 'auto') kind = detect(original);

  let small: string;
  let restoreMap: Record<string, unknown>;
  if (kind === 'json') {
    [small, restoreMap] = compressJson(original, targetTokens, model, fidelity);
  } else if (kind === 'logs') {
    [small, restoreMap] = compressLogs(original, targetTokens, model);
  } else if (kind === 'code') {
    [small, restoreMap] = compressCode(original, targetTokens, model, fidelity);
  } else {
    [small, restoreMap] = compressProse(original, targetTokens, model, fidelity);
  }

  const ref = store(original);
  // Deterministic id (squeeze is deterministic): derived from the content-addressed ref + technique,
  // so identical (content, technique) yields the same id. First 32 hex chars of sha256(`ref:tech`).
  const technique = restoreMap.technique === undefined ? '' : String(restoreMap.technique);
  const id = sha256Hex(`${ref}:${technique}`).slice(0, 32);
  const handle = new Handle(id, kind, ref, restoreMap);
  return [small, handle];
}

/** Restore the original content for a handle (same as `handle.expand()`). */
export function decompress(handle: Handle): string {
  return handle.expand();
}

/** Options for {@link SqueezeCompressor.compress} (matches core's `Compressor` protocol shape). */
export interface CompressorOptions {
  targetTokens?: number | null;
  model?: string | null;
  kind?: Kind;
  fidelity?: Fidelity;
}

/** Object form satisfying `@cendor/core`'s `Compressor` protocol (delegates to {@link compress}). */
export class SqueezeCompressor {
  compress(content: unknown, opts: CompressorOptions = {}): [string, Handle] {
    return compress(content, {
      kind: opts.kind ?? 'auto',
      targetTokens: opts.targetTokens ?? null,
      model: opts.model ?? 'gpt-4o',
      fidelity: opts.fidelity ?? 'balanced',
    });
  }
}

// --------------------------------------------------------------------------- compressors

function stripNulls(obj: JVal): JVal {
  if (obj instanceof Map) {
    const out = new Map<string, JVal>();
    for (const [k, v] of obj) if (v !== null) out.set(k, stripNulls(v));
    return out;
  }
  if (Array.isArray(obj)) return obj.map(stripNulls);
  return obj;
}

// Code-point length, matching Python `len()` (used only for stable drop-ordering).
function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function isNonEmpty(v: JVal): v is JVal[] | Map<string, JVal> {
  if (v instanceof Map) return v.size > 0;
  return Array.isArray(v) && v.length > 0;
}

/** Deep-clone a `JVal` tree so `peelOne` never mutates the caller's value (scalars are immutable). */
function cloneJson(v: JVal): JVal {
  if (v instanceof Map) {
    const out = new Map<string, JVal>();
    for (const [k, val] of v) out.set(k, cloneJson(val));
    return out;
  }
  if (Array.isArray(v)) return v.map(cloneJson);
  return v;
}

/**
 * Remove one structural unit from `obj` **in place**, returning `true` if anything was removed
 * (`false` for an un-peelable scalar / empty container). Descends through single-child wrappers, so
 * a payload nested under one key (`{"data":[…]}` / `{"results":{…}}`) is peeled element-by-element
 * instead of being deleted wholesale (which used to collapse the whole thing to `{}`). Dicts drop
 * the largest-valued key; lists drop the trailing element (keeping a valid chronological prefix).
 */
function peelOne(obj: JVal): boolean {
  if (obj instanceof Map && obj.size > 0) {
    if (obj.size === 1) {
      const key = obj.keys().next().value as string;
      const val = obj.get(key) as JVal;
      if (isNonEmpty(val) && peelOne(val)) return true;
      obj.delete(key); // sole key wraps a scalar / now-empty container — drop it (→ {})
      return true;
    }
    // largest-valued key; first max on ties (insertion order), mirroring Python's max().
    let biggest: string | undefined;
    let bestLen = -1;
    for (const [k, v] of obj) {
      const len = cpLen(dumps(v));
      if (len > bestLen) {
        bestLen = len;
        biggest = k;
      }
    }
    obj.delete(biggest as string);
    return true;
  }
  if (Array.isArray(obj) && obj.length > 0) {
    const tail = obj[obj.length - 1] as JVal;
    if (obj.length === 1 && isNonEmpty(tail) && peelOne(tail)) return true;
    obj.pop();
    return true;
  }
  return false;
}

function fitJson(obj: JVal, target: number, model: string): [string, boolean] {
  let small = dumps(obj);
  if (tokens.count(small, model) <= target) return [small, false];
  const kept = cloneJson(obj); // never mutate the caller's value
  while (tokens.count(dumps(kept), model) > target && peelOne(kept)) {
    // peel one unit per iteration until it fits or nothing is left to drop
  }
  small = dumps(kept);
  if (tokens.count(small, model) <= target) return [small, true];
  // last resort: a single giant scalar/leaf — prefix-cut (may not parse; documented).
  return [truncateToTokens(small, target, model), true];
}

function compressJson(
  text: string,
  targetTokens: number | null,
  model: string,
  fidelity: Fidelity,
): [string, Record<string, unknown>] {
  let obj: JVal;
  try {
    obj = parseJson(text);
  } catch {
    return compressProse(text, targetTokens, model, 'balanced');
  }
  const shaped = fidelity === 'lossless' ? obj : stripNulls(obj);
  let technique = fidelity === 'lossless' ? 'minify' : 'minify+dropnulls';
  if (targetTokens === null) return [dumps(shaped), { technique }];
  const [small, dropped] = fitJson(shaped, targetTokens, model);
  if (dropped) technique += '+drop';
  return [small, { technique }];
}

function compressCode(
  text: string,
  targetTokens: number | null,
  model: string,
  fidelity: Fidelity,
): [string, Record<string, unknown>] {
  let code = text;
  if (fidelity !== 'lossless') code = stripComments(code);
  const out: string[] = [];
  for (const raw of splitlines(code)) {
    let line = pyRStrip(raw);
    if (pyStrip(line) === '') continue;
    if (fidelity === 'aggressive') {
      const stripped = pyLStrip(line);
      const indent = line.slice(0, line.length - stripped.length);
      line = indent + stripped.replace(/[ \t]{2,}/g, ' ');
    }
    out.push(line);
  }
  let small = out.join('\n');
  if (targetTokens !== null && tokens.count(small, model) > targetTokens) {
    small = truncateToTokens(small, targetTokens, model);
  }
  return [small, { technique: `code:${fidelity}` }];
}

function normalizeLogLine(line: string): string {
  let out = line.replace(TS_RE, '<ts>');
  out = out.replace(UUID_RE, '<uuid>');
  out = out.replace(IP_RE, '<ip>');
  out = out.replace(HEX_RE, '<hex>');
  return out.replace(INT_RE, '<n>');
}

function compressLogs(
  text: string,
  targetTokens: number | null,
  model: string,
): [string, Record<string, unknown>] {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const line of splitlines(text)) {
    const norm = normalizeLogLine(line);
    if (!counts.has(norm)) order.push(norm);
    counts.set(norm, (counts.get(norm) ?? 0) + 1);
  }

  const rendered = new Map<string, string>();
  for (const norm of order) {
    const c = counts.get(norm) as number;
    rendered.set(norm, c > 1 ? `${norm} (${TIMES}${c})` : norm);
  }

  let kept: string[];
  if (targetTokens === null) {
    kept = order;
  } else {
    const chosen = new Set<string>();
    let running = 0;
    // most-frequent first, stable (ties keep chronological order).
    const decorated = order.map((norm, idx) => ({ norm, idx, c: counts.get(norm) as number }));
    decorated.sort((a, b) => b.c - a.c || a.idx - b.idx);
    for (const { norm } of decorated) {
      const cost = tokens.count(rendered.get(norm) as string, model) + 1; // +1 for the separator
      if (running + cost > targetTokens && chosen.size > 0) break; // first pattern always kept
      chosen.add(norm);
      running += cost;
    }
    kept = order.filter((norm) => chosen.has(norm)); // back to chronological order
  }

  let small = kept.map((norm) => rendered.get(norm) as string).join('\n');
  if (targetTokens !== null && tokens.count(small, model) > targetTokens) {
    small = truncateToTokens(small, targetTokens, model);
  }
  return [small, { technique: 'normalize+dedup', patterns: order.length }];
}

function stripComments(code: string): string {
  const out: string[] = [];
  let i = 0;
  const n = code.length;
  let quote: string | null = null;
  let inBlock = false;
  let atLineStart = true; // no non-space char seen yet on the current line
  while (i < n) {
    const ch = code[i] as string;
    const nxt = i + 1 < n ? (code[i + 1] as string) : '';
    if (inBlock) {
      if (ch === '*' && nxt === '/') {
        inBlock = false;
        i += 2;
      } else {
        if (ch === '\n') out.push('\n'); // preserve newlines inside block comments
        i += 1;
      }
      continue;
    }
    if (quote !== null) {
      out.push(ch);
      if (ch === '\\' && i + 1 < n) {
        out.push(nxt); // escape — copy the escaped char verbatim
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out.push(ch);
      atLineStart = false;
      i += 1;
      continue;
    }
    if (ch === '/' && nxt === '/') {
      while (i < n && code[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && nxt === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    if (ch === '#' && !((atLineStart && nxt === '!') || preprocMatch(code, i))) {
      while (i < n && code[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '\n') atLineStart = true;
    else if (!isPySpace(ch)) atLineStart = false;
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

function preprocMatch(code: string, i: number): boolean {
  PREPROC_STICKY.lastIndex = i;
  return PREPROC_STICKY.test(code);
}

const SENT_RE = /(?<=[.!?])\s+/;
const LAST_WORD_RE = /([A-Za-z][A-Za-z.]*)\.?\s*$/;
const WORD_RE = /[a-zA-Z']+/g;
const STOP = new Set(
  'the a an and or but of to in on for with is are was were be been it this that as at by'.split(
    ' ',
  ),
);
// Abbreviations that end in a period but don't end a sentence. Compared lowercase, trailing dots
// stripped; note "e.g" / "i.e" keep their internal dot.
const ABBREV = new Set(
  'dr mr mrs ms prof sr jr st vs etc no fig eq al inc ltd co e.g i.e cf approx dept vol pp'.split(
    ' ',
  ),
);

/** Split prose into sentences, but don't break after a common abbreviation or a decimal. */
export function _splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const part of pyStrip(text).split(SENT_RE)) {
    if (part === '') continue;
    if (out.length > 0) {
      const prev = out[out.length - 1] as string;
      const m = prev.match(LAST_WORD_RE);
      const tail = m ? rstripChars(m[1] as string, '.').toLowerCase() : '';
      const trimmed = rstripChars(pyRStrip(prev), '.');
      const lastChar = trimmed.slice(-1);
      const endsNumber = lastChar !== '' && isAsciiDigit(lastChar);
      if (ABBREV.has(tail) || endsNumber) {
        out[out.length - 1] = `${prev} ${part}`;
        continue;
      }
    }
    out.push(part);
  }
  return out.filter((s) => pyStrip(s) !== '');
}

function compressProse(
  text: string,
  targetTokens: number | null,
  model: string,
  fidelity: Fidelity,
): [string, Record<string, unknown>] {
  const sentences = _splitSentences(text).filter((s) => pyStrip(s) !== '');
  if (sentences.length <= 1 || fidelity === 'lossless') {
    // Nothing to rank, but still honor the budget (one long sentence, or lossless).
    let small = text;
    if (targetTokens !== null && tokens.count(small, model) > targetTokens) {
      small = truncateToTokens(small, targetTokens, model);
    }
    return [small, { technique: 'extractive', kept: sentences.length, of: sentences.length }];
  }

  const freq = new Map<string, number>();
  for (const word of text.toLowerCase().match(WORD_RE) ?? []) {
    if (!STOP.has(word)) freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  // Length-normalized keyword mass: sum(freq) / sqrt(word count) — NOT the mean.
  const score = (sentence: string): number => {
    const words = sentence.toLowerCase().match(WORD_RE) ?? [];
    if (words.length === 0) return 0;
    let sum = 0;
    for (const w of words) sum += freq.get(w) ?? 0;
    return sum / Math.sqrt(words.length);
  };

  const scores = sentences.map(score);
  // indices ranked by descending score; stable (ties keep ascending original index).
  const ranked = sentences.map((_, i) => i).sort((a, b) => scores[b]! - scores[a]! || a - b);

  let keep: Set<number>;
  if (targetTokens !== null) {
    keep = new Set<number>();
    for (const i of ranked) {
      const idxs = [...keep, i].sort((a, b) => a - b);
      const trial = idxs.map((j) => sentences[j] as string).join(' ');
      if (tokens.count(trial, model) > targetTokens && keep.size > 0) break; // first always kept
      keep.add(i);
    }
  } else {
    const divisor = fidelity === 'aggressive' ? 3 : 2; // aggressive: top third, balanced: top half
    const n = Math.max(1, Math.floor(sentences.length / divisor));
    keep = new Set(ranked.slice(0, n));
  }

  const keptIdx = [...keep].sort((a, b) => a - b);
  let small = keptIdx.map((i) => sentences[i] as string).join(' ');
  // The top-ranked sentence is always kept; truncate so targetTokens is never exceeded.
  if (targetTokens !== null && tokens.count(small, model) > targetTokens) {
    small = truncateToTokens(small, targetTokens, model);
  }
  return [small, { technique: 'extractive', kept: keep.size, of: sentences.length }];
}

/** Binary-search the longest prefix of `text` that fits `target` tokens (by code point). */
function truncateToTokens(text: string, target: number, model: string): string {
  if (target <= 0) return '';
  if (tokens.count(text, model) <= target) return text;
  const cps = Array.from(text); // slice by code point, matching Python str indexing
  let lo = 0;
  let hi = cps.length;
  let best = '';
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cand = cps.slice(0, mid).join('');
    if (tokens.count(cand, model) <= target) {
      best = cand;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
