/**
 * Provider-aware token counting, the TS mirror of `cendor.core.tokens`. Uses `js-tiktoken` (pure JS,
 * no WASM) so counts are exact for OpenAI models (fine-tunes map to their base model's encoding) and
 * a close BPE proxy (`o200k_base`) for Claude/Gemini **and every other non-OpenAI or unrecognized
 * model** (llama/mistral/deepseek/qwen, new o-series ids, hosted open weights). `js-tiktoken` is a
 * hard dependency here, so the "heuristic" tier only ever appears if an encoding genuinely fails to
 * load; it is kept for parity and edge-case robustness.
 */
import { type Tiktoken, type TiktokenModel, encodingForModel, getEncoding } from 'js-tiktoken';
import type { Message } from './types.js';

const MESSAGE_OVERHEAD = 4;
const PRIMING = 3;

const CHARS_PER_TOKEN: Record<string, number> = { openai: 4.0, default: 4.0 };
const PIECE_RE = /\w+|[^\w\s]/g;

export type TokenizerFamily = 'openai' | 'anthropic' | 'google' | 'default';
export type Counter = (textOrMessages: string | Message[], model: string) => number;

const counters = new Map<string, Counter>();
const encCache = new Map<string, Tiktoken>();
const nativeCache = new Map<string, boolean>();
let o200kCache: Tiktoken | null | undefined;

function o200k(): Tiktoken | null {
  if (o200kCache === undefined) {
    try {
      o200kCache = getEncoding('o200k_base');
    } catch {
      o200kCache = null;
    }
  }
  return o200kCache;
}

// Eager warm-up: js-tiktoken decodes the ~2.3 MB `o200k_base` BPE table lazily on first use, so the
// first `count()` in a process otherwise stalls ~1 ms. Building it once at module import moves that
// cost off the hot path (subsequent counts are ~100 µs). Runs exactly once and never throws — a
// failed warm leaves `o200kCache` unset so the normal lazy path still applies on first real use.
let warmed = false;
function warmDefaultEncoder(): void {
  if (warmed) return;
  warmed = true;
  try {
    o200k();
  } catch {
    // ignore: warming is a pure optimization; fall back to the lazy build on first count()
  }
}
warmDefaultEncoder();

function tiktokenEncoding(model: string): Tiktoken | null {
  const cached = encCache.get(model);
  if (cached) return cached;
  try {
    const enc = encodingForModel(baseModel(model) as TiktokenModel);
    encCache.set(model, enc);
    return enc;
  } catch {
    return o200k();
  }
}

function openaiEncodingIsNative(model: string): boolean {
  const cached = nativeCache.get(model);
  if (cached !== undefined) return cached;
  let native: boolean;
  try {
    encodingForModel(baseModel(model) as TiktokenModel);
    native = true;
  } catch {
    native = false;
  }
  nativeCache.set(model, native);
  return native;
}

// OpenAI reasoning ("o-series") ids: an `o` followed by a digit — `o1`/`o3`/`o4`/`o5`/…. Anchored,
// so `ollama`/`olmo` (no digit after `o`) don't match. Kept general so a future o-series id
// (`o5-mini`, `o6`) is recognized as OpenAI instead of silently falling through to `default`.
const OSERIES = /^o\d/;

/**
 * Normalize a fine-tuned OpenAI id to its base model: `ft:<base>:<org>::<id>` → `<base>`. Fine-tunes
 * use the base model's tokenizer, so they should count exactly under the base encoding. Non-`ft:`
 * ids are returned unchanged.
 */
function baseModel(model: string): string {
  if (model.toLowerCase().startsWith('ft:')) {
    const parts = model.split(':');
    if (parts.length >= 2 && parts[1]) return parts[1];
  }
  return model;
}

/** Tokenizer family for a model id (substring matches handle Bedrock-style prefixed ids; an `ft:`
 * fine-tune wrapper is unwrapped to its base model first). */
export function family(model: string): TokenizerFamily {
  const m = baseModel(model).toLowerCase();
  if (
    m.startsWith('gpt') ||
    m.startsWith('chatgpt') ||
    m.startsWith('text-') ||
    m.startsWith('davinci') ||
    OSERIES.test(m)
  ) {
    return 'openai';
  }
  if (m.includes('claude')) return 'anthropic';
  if (m.includes('gemini')) return 'google';
  return 'default';
}

/** Override the counter for a family (e.g. plug in a precise tokenizer). */
export function register(fam: string, counter: Counter): void {
  counters.set(fam, counter);
}

/** Test helper: drop registered counters (cached encodings are pure memoization and kept). */
export function _reset(): void {
  counters.clear();
}

/**
 * How {@link count} will measure `model`: `"registered"`, `"exact"` (OpenAI, model-native tiktoken),
 * `"bpe-estimate"` (Claude/Gemini via o200k, or an unknown OpenAI id falling back to o200k), or
 * `"heuristic"`.
 */
export function method(model: string): 'registered' | 'exact' | 'bpe-estimate' | 'heuristic' {
  const fam = family(model);
  if (counters.has(fam)) return 'registered';
  if (fam === 'openai') {
    if (tiktokenEncoding(model) === null) return 'heuristic';
    return openaiEncodingIsNative(model) ? 'exact' : 'bpe-estimate';
  }
  // anthropic / google / default: the o200k BPE proxy when tiktoken is present, else heuristic.
  if (o200k() !== null) return 'bpe-estimate';
  return 'heuristic';
}

/** `true` when {@link count} is exact for `model` (OpenAI with tiktoken). */
export function isExact(model: string): boolean {
  return method(model) === 'exact';
}

/**
 * Count tokens for a string or a list of chat messages under `model`. It's `tokens.count`, not
 * `countTokens`; the model is the second positional arg.
 *
 * @example
 * ```ts
 * import { tokens } from '@cendor/core';
 * const n = tokens.count([{ role: 'user', content: 'hi' }], 'gpt-4o');
 * ```
 */
export function count(textOrMessages: string | Message[], model: string): number {
  const fam = family(model);
  const custom = counters.get(fam);
  if (custom) return custom(textOrMessages, model);

  if (typeof textOrMessages === 'string') {
    return countText(textOrMessages, fam, model);
  }

  let total = PRIMING;
  for (const msg of textOrMessages) {
    total += MESSAGE_OVERHEAD;
    total += countText(messageText(msg), fam, model);
  }
  return total;
}

function messageText(msg: unknown): string {
  if (typeof msg !== 'object' || msg === null) {
    if (typeof msg === 'string') return msg;
    const text = (msg as { text?: unknown } | null)?.text;
    return typeof text === 'string' ? text : String(msg);
  }
  const content = (msg as { content?: unknown }).content ?? '';
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { text?: unknown } => p != null && typeof p === 'object')
      .map((p) => {
        const t = p.text;
        return typeof t === 'string' ? t : '';
      })
      .join('');
  }
  return String(content || '');
}

function countText(text: string, fam: TokenizerFamily, model: string): number {
  if (!text) return 0;
  if (fam === 'openai') {
    const enc = tiktokenEncoding(model);
    if (enc) return enc.encode(text).length; // exact (or the o200k proxy for an unknown OpenAI id)
    // js-tiktoken failed to load — the defensive char heuristic (never a normal install).
    return Math.ceil(text.length / (CHARS_PER_TOKEN.openai ?? 4.0));
  }
  // anthropic / google / default: the o200k BPE proxy — a real tokenizer beats a char heuristic
  // for the whole non-OpenAI class (Claude/Gemini + llama/mistral/deepseek/hosted open weights).
  const enc = o200k();
  if (enc) return enc.encode(text).length;
  return subwordEstimate(text);
}

function subwordEstimate(text: string): number {
  const pieces = (text.match(PIECE_RE) ?? []).length;
  const charEst = text.length / 3.5;
  const pieceEst = pieces * 1.2;
  return Math.max(1, Math.ceil((charEst + pieceEst) / 2));
}
