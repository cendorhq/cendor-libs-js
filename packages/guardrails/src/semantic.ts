/**
 * Similarity checks over a **bring-your-own** embedding function — groundedness + denied-topics. The
 * TS port of `cendor.guardrails.semantic`.
 *
 * - `groundedness` — trip when a response is **not** close enough to any provided source (a RAG
 *   hallucination gate).
 * - `deniedTopics` — trip when the payload is **too** close to any denied-topic exemplar.
 *
 * Both take an `embed(text) => number[]` callable — **you** supply the model (a local
 * sentence-transformer, a hosted embeddings endpoint, anything). cendor ships **no** embedding model,
 * mirroring `cassette`'s bring-your-own-scorer. Cosine similarity is computed in pure TS (no deps).
 * These are heuristics: a threshold you tune, not a guarantee — keep an ungrounded answer advisory
 * (`action: 'flag'`) unless you have measured your own corpus. For richer, reasoned judgement, use the
 * `judge` LLM-judge helpers instead.
 *
 * Imports only `./decision` and reuses `payloadText` from `./rules` (a hoisted function), so the
 * re-export cycle is safe at runtime.
 */
import {
  type Check,
  type Context,
  type Guardrail,
  type OnError,
  Verdict,
  defineGuardrail,
} from './decision.js';
import { payloadText } from './rules.js';

type Stage = string | readonly string[];
type Action = 'block' | 'redact' | 'flag';

export type Embed = (text: string) => number[] | readonly number[];

function resolveOnError(action: Action, onError?: OnError): OnError {
  if (onError !== undefined) return onError;
  return action === 'flag' ? 'fail_open' : 'fail_closed';
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
  }
  for (const x of a) na += x * x;
  for (const y of b) nb += y * y;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Embed `texts` once, on first check (not at construction — so building an agent makes no call). */
function lazyVectors(embed: Embed, texts: readonly string[]): () => number[][] {
  let cache: number[][] | undefined;
  return () => {
    if (cache === undefined) cache = texts.map((t) => [...embed(t)]);
    return cache;
  };
}

export interface GroundednessOptions {
  threshold?: number;
  stage?: Stage;
  action?: Action;
  name?: string;
  timeout?: number;
  onError?: OnError;
}

/**
 * Trip when the payload's max cosine similarity to any of `sources` is **below** `threshold` — i.e.
 * the response is not grounded in the retrieved passages (a RAG hallucination gate). Defaults to the
 * `output` stage and `action: 'flag'`. Empty `sources` never trips.
 */
export function groundedness(
  embed: Embed,
  sources: readonly string[],
  opts: GroundednessOptions = {},
): Guardrail {
  const {
    threshold = 0.75,
    stage = 'output',
    action = 'flag',
    name = 'groundedness',
    timeout,
    onError,
  } = opts;
  const sourceVecs = lazyVectors(embed, [...sources]);
  const check: Check = (payload: unknown, _ctx: Context) => {
    const vecs = sourceVecs();
    if (vecs.length === 0) return null;
    const answer = [...embed(payloadText(payload))];
    const best = vecs.reduce((m, v) => Math.max(m, cosine(answer, v)), 0);
    if (best >= threshold) return null;
    return new Verdict(action, `ungrounded: max similarity ${best.toFixed(2)} < ${threshold}`);
  };
  return defineGuardrail(check, { name, stage, timeout, onError: resolveOnError(action, onError) });
}

export interface CustomCategoryOptions {
  threshold?: number;
  stage?: Stage;
  action?: Action;
  name?: string;
  timeout?: number;
  onError?: OnError;
}

/**
 * Trip when the payload is semantically close to a **custom category** you define by example — the
 * local, `$0` counterpart to Azure Content Safety's *rapid custom categories* (description + examples
 * → embedding search), with no cloud call and no training step. Trips when the payload's max cosine
 * similarity to any example is **at or above** `threshold`, recording `metadata.category` /
 * `metadata.score`; catches paraphrases `keywordDeny` misses. Defaults to `action:'flag'` (a tuned
 * heuristic — calibrate before you block). No catch-rate claim; empty `examples` never trips.
 *
 * `embed(text)` is **bring-your-own** — a local sentence-transformer, a hosted endpoint, or e.g. a
 * transformers.js pipeline. (There is no zero-config `localEmbedder` in TS yet — model2vec is
 * Python-only; parity 🚧.)
 */
export function customCategory(
  category: string,
  examples: readonly string[],
  embed: Embed,
  opts: CustomCategoryOptions = {},
): Guardrail {
  const {
    threshold = 0.8,
    stage = 'input',
    action = 'flag',
    name = `custom_category:${category}`,
    timeout,
    onError,
  } = opts;
  const exampleVecs = lazyVectors(embed, [...examples]);
  const check: Check = (payload: unknown, _ctx: Context) => {
    const vecs = exampleVecs();
    if (vecs.length === 0) return null;
    const query = [...embed(payloadText(payload))];
    const best = vecs.reduce((m, v) => Math.max(m, cosine(query, v)), Number.NEGATIVE_INFINITY);
    if (best < threshold) return null;
    return new Verdict(
      action,
      `custom category ${JSON.stringify(category)}: sim ${best.toFixed(2)} >= ${threshold}`,
      null,
      { category, score: Math.round(best * 1e4) / 1e4 },
    );
  };
  return defineGuardrail(check, { name, stage, timeout, onError: resolveOnError(action, onError) });
}

export interface DeniedTopicsOptions {
  threshold?: number;
  stage?: Stage;
  action?: Action;
  name?: string;
  timeout?: number;
  onError?: OnError;
}

/**
 * Trip when the payload's max cosine similarity to any denied-topic exemplar is **at or above**
 * `threshold` — steer an agent off subjects it must never engage. The reason names the closest topic
 * and the similarity — never the payload. A tuned heuristic: calibrate `threshold` on your inputs.
 */
export function deniedTopics(
  embed: Embed,
  topics: readonly string[],
  opts: DeniedTopicsOptions = {},
): Guardrail {
  const {
    threshold = 0.8,
    stage = 'input',
    action = 'block',
    name = 'denied_topics',
    timeout,
    onError,
  } = opts;
  const topicList = [...topics];
  const topicVecs = lazyVectors(embed, topicList);
  const check: Check = (payload: unknown, _ctx: Context) => {
    const vecs = topicVecs();
    if (vecs.length === 0) return null;
    const query = [...embed(payloadText(payload))];
    let bestI = 0;
    let bestSim = Number.NEGATIVE_INFINITY;
    vecs.forEach((v, i) => {
      const s = cosine(query, v);
      if (s > bestSim) {
        bestSim = s;
        bestI = i;
      }
    });
    if (bestSim < threshold) return null;
    return new Verdict(
      action,
      `denied topic ${JSON.stringify(topicList[bestI])}: sim ${bestSim.toFixed(2)} >= ${threshold}`,
    );
  };
  return defineGuardrail(check, { name, stage, timeout, onError: resolveOnError(action, onError) });
}
