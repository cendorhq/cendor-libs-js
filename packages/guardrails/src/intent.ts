/**
 * Pre-LLM **intent screening** — should this request reach the model at all, and is it on-topic? The
 * TS port of `cendor.guardrails.intent`.
 *
 * A first-class gate for the question every app asks but no local-first guardrail packages. Two
 * backends: embedding exemplars (a `{ label: [examples] }` map + a BYO `embed`), or a BYO
 * `classify(text) => label | { label: score }`. For the LLM-judge backend, use
 * {@link judge.intentPrompt} with `rules.llmJudge`. `mode:"deny"` trips on a match (topics you never
 * serve); `mode:"allow"` trips when it matches none (an off-topic gate). Defaults to `action:'flag'`.
 * No accuracy claim, no bundled taxonomy. Reuses `payloadText` from `./rules`.
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
export type Classify = (text: string) => string | Record<string, number>;
export type IntentMode = 'deny' | 'allow';

function resolveOnError(action: Action, onError?: OnError): OnError {
  if (onError !== undefined) return onError;
  return action === 'flag' ? 'fail_open' : 'fail_closed';
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  for (const x of a) na += x * x;
  for (const y of b) nb += y * y;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Normalise a classifier result to `[label, score]`: a bare string ⇒ score 1; a map ⇒ its argmax. */
function classifiedLabel(result: string | Record<string, number>): [string, number] {
  if (typeof result === 'string') return [result, 1.0];
  const entries = Object.entries(result);
  if (entries.length === 0) return ['', 0.0];
  return entries.reduce((best, e) => (e[1] > best[1] ? e : best));
}

export interface IntentOptions {
  /** Embedding backend — a `{ label: [example, …] }` map + this `embed`. */
  embed?: Embed;
  /** Classifier backend — `classify(text) => label | { label: score }`. */
  classify?: Classify;
  mode?: IntentMode;
  threshold?: number;
  stage?: Stage;
  action?: Action;
  name?: string;
  timeout?: number;
  onError?: OnError;
}

/**
 * Screen a request by **intent** before the model runs. Provide exactly one backend — `embed` (with
 * `intents` a `{ label: [examples] }` map) or `classify` (with `intents` the in-scope label names).
 * `mode:"deny"` trips on a match; `mode:"allow"` trips when nothing matched (off-topic). Records
 * `metadata.intent` / `metadata.score`. No accuracy claim; calibrate `threshold` (and prefer `flag`)
 * before you `block`.
 */
export function intent(
  intents: Record<string, readonly string[]> | readonly string[],
  opts: IntentOptions = {},
): Guardrail {
  const {
    embed,
    classify,
    mode = 'deny',
    threshold = 0.8,
    stage = 'input',
    action = 'flag',
    name = 'intent',
    timeout,
    onError,
  } = opts;
  if (mode !== 'deny' && mode !== 'allow') {
    throw new Error(`unknown mode ${JSON.stringify(mode)}; must be 'deny' or 'allow'`);
  }
  if ((embed === undefined) === (classify === undefined)) {
    throw new Error('intent() needs exactly one of embed or classify');
  }

  const check: Check =
    embed !== undefined
      ? embeddingCheck(intents as Record<string, readonly string[]>, embed, mode, threshold, action)
      : classifierCheck(labelSet(intents), classify!, mode, threshold, action);

  return defineGuardrail(check, { name, stage, timeout, onError: resolveOnError(action, onError) });
}

function labelSet(intents: Record<string, readonly string[]> | readonly string[]): Set<string> {
  if (Array.isArray(intents)) return new Set(intents.map(String));
  return new Set(Object.keys(intents as Record<string, readonly string[]>));
}

function embeddingCheck(
  intents: Record<string, readonly string[]>,
  embed: Embed,
  mode: IntentMode,
  threshold: number,
  action: Action,
): Check {
  let cache: [string, number[]][] | undefined;
  const vectors = (): [string, number[]][] => {
    if (cache === undefined) {
      cache = [];
      for (const [label, examples] of Object.entries(intents)) {
        for (const ex of examples) cache.push([label, [...embed(ex)]]);
      }
    }
    return cache;
  };
  return (payload: unknown, _ctx: Context) => {
    const vecs = vectors();
    if (vecs.length === 0) return null;
    const query = [...embed(payloadText(payload))];
    let bestLabel = '';
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const [label, vec] of vecs) {
      const sim = cosine(query, vec);
      if (sim > bestScore) {
        bestScore = sim;
        bestLabel = label;
      }
    }
    return verdict(mode, action, bestScore >= threshold, bestLabel, bestScore, threshold);
  };
}

function classifierCheck(
  labels: Set<string>,
  classify: Classify,
  mode: IntentMode,
  threshold: number,
  action: Action,
): Check {
  return (payload: unknown, _ctx: Context) => {
    const [label, score] = classifiedLabel(classify(payloadText(payload)));
    const matched = score >= threshold && labels.has(label);
    return verdict(mode, action, matched, label, score, threshold);
  };
}

function verdict(
  mode: IntentMode,
  action: Action,
  matched: boolean,
  label: string,
  score: number,
  threshold: number,
): Verdict | null {
  const meta = { intent: label, score: Math.round(score * 1e4) / 1e4 };
  if (mode === 'deny') {
    if (!matched) return null;
    return new Verdict(
      action,
      `denied intent ${JSON.stringify(label)}: ${score.toFixed(2)} >= ${threshold}`,
      null,
      meta,
    );
  }
  if (matched) return null;
  const detail = label
    ? `closest ${JSON.stringify(label)} ${score.toFixed(2)}`
    : 'no intent matched';
  return new Verdict(action, `off-topic (${detail} < ${threshold})`, null, meta);
}
