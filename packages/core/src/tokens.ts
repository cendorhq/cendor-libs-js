/**
 * Provider-aware token counting, the TS mirror of `cendor.core.tokens`. Uses `js-tiktoken` (pure JS,
 * no WASM) so counts are exact for OpenAI models and a close BPE proxy (`o200k_base`) for Claude/
 * Gemini. `js-tiktoken` is a hard dependency here, so the "heuristic" tier only ever appears if an
 * encoding genuinely fails to load; it is kept for parity and edge-case robustness.
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

function tiktokenEncoding(model: string): Tiktoken | null {
  const cached = encCache.get(model);
  if (cached) return cached;
  try {
    const enc = encodingForModel(model as TiktokenModel);
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
    encodingForModel(model as TiktokenModel);
    native = true;
  } catch {
    native = false;
  }
  nativeCache.set(model, native);
  return native;
}

/** Tokenizer family for a model id (substring matches handle Bedrock-style prefixed ids). */
export function family(model: string): TokenizerFamily {
  const m = model.toLowerCase();
  if (
    m.startsWith('gpt') ||
    m.startsWith('o1') ||
    m.startsWith('o3') ||
    m.startsWith('o4') ||
    m.startsWith('chatgpt') ||
    m.startsWith('text-') ||
    m.startsWith('davinci')
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
  if ((fam === 'anthropic' || fam === 'google') && o200k() !== null) return 'bpe-estimate';
  return 'heuristic';
}

/** `true` when {@link count} is exact for `model` (OpenAI with tiktoken). */
export function isExact(model: string): boolean {
  return method(model) === 'exact';
}

/** Count tokens for a string or a list of chat messages under `model`. */
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
    if (enc) return enc.encode(text).length;
  } else if (fam === 'anthropic' || fam === 'google') {
    const enc = o200k();
    if (enc) return enc.encode(text).length;
    return subwordEstimate(text);
  }
  const cpt = CHARS_PER_TOKEN[fam] ?? CHARS_PER_TOKEN.default ?? 4.0;
  return Math.ceil(text.length / cpt);
}

function subwordEstimate(text: string): number {
  const pieces = (text.match(PIECE_RE) ?? []).length;
  const charEst = text.length / 3.5;
  const pieceEst = pieces * 1.2;
  return Math.max(1, Math.ceil((charEst + pieceEst) / 2));
}
