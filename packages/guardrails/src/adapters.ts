/**
 * Opt-in detection-tier adapters — beyond the deterministic tier-0 built-ins in `./rules`. The TS
 * port of `cendor.guardrails.adapters`.
 *
 * These reach past regex/arithmetic to a **local ML classifier**, a **language detector**, and a
 * **hosted moderation endpoint** (the detection tier of docs/guardrails.md "Threat model"). Each
 * rides a **bring-your-own** dependency or client — never a hard dependency of this package: a
 * classifier callable, a `detect` callable, or a provider client you pass in. They are re-exported
 * through `./rules` (`rules.classifier` / `rules.language` / `rules.openaiModeration`) and at the
 * package root (`import { adapters } from '@cendor/guardrails'`).
 *
 * **Honest claims.** There is **no jailbreak-detection claim** anywhere here. `classifier` is a
 * generic, license-agnostic contract around a local classifier *you* supply (a prompt-injection
 * classifier such as PromptGuard, an ONNX model, or a heuristic wires through it). Reproduce a
 * model's public eval and publish the numbers before citing any detection rate — classifiers are
 * beaten by mutation/obfuscation attacks, so layer them, don't trust one. See the "Threat model".
 *
 * This module imports only `./decision` and reuses `payloadText` from `./rules` (a hoisted function,
 * so the `rules` ↔ `adapters` re-export cycle is safe at runtime).
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

/**
 * Default the error policy from a guardrail's action: a `block` gate fails **closed**; a `flag`
 * degrades to advisory (`fail_open`). An explicit `onError` always wins. (Same rule as `rules`.)
 */
function resolveOnError(action: Action, onError?: OnError): OnError {
  if (onError !== undefined) return onError;
  return action === 'flag' ? 'fail_open' : 'fail_closed';
}

/** Build an adapter's `Guardrail` via the leaf `defineGuardrail`, resolving the error policy. */
function mk(
  check: Check,
  opts: { name: string; stage: Stage; action: Action; timeout?: number; onError?: OnError },
): Guardrail {
  return defineGuardrail(check, {
    name: opts.name,
    stage: opts.stage,
    timeout: opts.timeout,
    onError: resolveOnError(opts.action, opts.onError),
  });
}

function get(obj: unknown, name: string, dflt: unknown = undefined): unknown {
  if (obj == null) return dflt;
  if (obj instanceof Map) return obj.has(name) ? obj.get(name) : dflt;
  if (typeof obj !== 'object' && typeof obj !== 'function') return dflt;
  const v = (obj as Record<string, unknown>)[name];
  return v === undefined ? dflt : v;
}

// --------------------------------------------------------------------------- classifier

/** Normalise a classifier result (bool / number / `{label: score}`) to `[score, tripped]`. */
function score(result: unknown, label: string | undefined, threshold: number): [number, boolean] {
  if (typeof result === 'boolean') return [result ? 1 : 0, result];
  if (typeof result === 'number') return [result, result >= threshold];
  if (result !== null && typeof result === 'object') {
    const rec = result as Record<string, unknown>;
    let s: number;
    if (label !== undefined) {
      s = Number(rec[label] ?? 0);
    } else {
      const vals = Object.values(rec).map((v) => Number(v));
      s = vals.length > 0 ? Math.max(...vals) : 0;
    }
    return [s, s >= threshold];
  }
  throw new TypeError(
    `classifier returned ${result === null ? 'null' : typeof result}; expected bool, number, or mapping`,
  );
}

export interface ClassifierOptions {
  /** Trip when the score is `>= threshold` (default `0.5`). */
  threshold?: number;
  /** For a `{label: score}` result, the label to read (else the max score is used). */
  label?: string;
  stage?: Stage;
  action?: Action;
  name?: string;
  /** Override the trip reason (default `"<name>: score <s> >= <threshold>"`). */
  reason?: string;
  /** Per-check wall-clock limit in seconds (async path only). */
  timeout?: number;
  /** Error/timeout policy; defaults from `action` (flag → `fail_open`, else `fail_closed`). */
  onError?: OnError;
}

/**
 * Wrap a **local classifier** as a guardrail — the generic, license-agnostic contract.
 *
 * `classify(text)` returns a float score in `[0, 1]`, a `{label: score}` mapping, or a bool. The
 * guardrail trips when the (selected `label`'s, else the max) score `>= threshold` (or the bool is
 * `true`). Bring **any** local classifier — an ONNX model, a transformers.js pipeline, a heuristic,
 * or a prompt-injection classifier (PromptGuard-class). A remote classifier can hang, so set
 * `timeout` / `onError` for it. No jailbreak-detection claim — see the module "Threat model" note.
 */
export function classifier(
  classify: (text: string) => number | boolean | Record<string, number>,
  opts: ClassifierOptions = {},
): Guardrail {
  const {
    threshold = 0.5,
    label,
    stage = 'input',
    action = 'block',
    name = 'classifier',
    reason,
    timeout,
    onError,
  } = opts;
  const check: Check = (payload: unknown, _ctx: Context) => {
    const [s, tripped] = score(classify(payloadText(payload)), label, threshold);
    if (!tripped) return null;
    return new Verdict(action, reason ?? `${name}: score ${s.toFixed(2)} >= ${threshold}`);
  };
  return mk(check, { name, stage, action, timeout, onError });
}

// --------------------------------------------------------------------------- language

export interface LanguageOptions {
  /** Bring-your-own detector: `(text) => isoCode`. Required in TS — no bundled langid. */
  detect?: (text: string) => string;
  stage?: Stage;
  action?: Action;
  name?: string;
  timeout?: number;
  onError?: OnError;
}

/**
 * Trip when the payload's detected language is **not** in `allowed` (ISO codes; case-insensitive) —
 * a guard against the language-switch bypass (smuggling disallowed content in another language). See
 * the "Threat model".
 *
 * `detect(text) -> isoCode` is **bring-your-own**: the TS port bundles no language detector (adding
 * one would be a heavy dependency), so `detect` is required. Without it the check throws a clear
 * error, which the guardrail's `onError` policy turns into a block (default) or flag. Language ID on
 * short/mixed text is unreliable — keep this advisory (`action: 'flag'`) unless you control the input.
 */
export function language(allowed: Iterable<string>, opts: LanguageOptions = {}): Guardrail {
  const { detect, stage = 'input', action = 'block', name = 'language', timeout, onError } = opts;
  const allow = new Set([...allowed].map((a) => a.toLowerCase()));
  const defaultDetect = (_text: string): string => {
    throw new Error(
      'language() needs a detector: pass detect=(text) => isoCode. The TS port bundles no ' +
        'language detector — wire your own (a small langid model, an ONNX/transformers.js classifier).',
    );
  };
  const det = detect ?? defaultDetect;
  const check: Check = (payload: unknown, _ctx: Context) => {
    const text = payloadText(payload).trim();
    if (!text) return null;
    const lang = det(text);
    if (lang && !allow.has(lang.toLowerCase())) {
      const listed = [...allow]
        .sort()
        .map((a) => `'${a}'`)
        .join(', ');
      return new Verdict(action, `language '${lang}' not in allowed [${listed}]`);
    }
    return null;
  };
  return mk(check, { name, stage, action, timeout, onError });
}

// --------------------------------------------------------------------------- openai_moderation

/** The category names an OpenAI moderation result flagged truthy (plain object or class instance). */
function flaggedCategories(categories: unknown): string[] {
  if (categories == null) return [];
  let entries: [string, unknown][];
  if (categories instanceof Map) {
    entries = [...categories.entries()];
  } else if (typeof categories === 'object') {
    entries = Object.entries(categories as Record<string, unknown>);
  } else {
    return [];
  }
  return entries
    .filter(([, v]) => Boolean(v))
    .map(([k]) => k)
    .sort();
}

export interface OpenaiModerationOptions {
  model?: string;
  /** Restrict to specific category names (else trip on any flag). */
  categories?: Iterable<string>;
  stage?: Stage;
  action?: Action;
  name?: string;
  timeout?: number;
  onError?: OnError;
}

/**
 * Trip when OpenAI's **free, non-LLM** moderation endpoint flags the payload — the cheapest hosted
 * tier. `client` is *your* OpenAI client (needs a key); this calls `client.moderations.create(...)`.
 *
 * Restrict to specific `categories` (e.g. `['violence', 'hate']`) or trip on any flag. It is a
 * network call — bound it with `timeout` and pick an `onError` policy (fail-closed by default for a
 * block gate). This library stores nothing; the request goes to OpenAI. The client/response are
 * duck-typed, so any OpenAI-shaped client works.
 */
export function openaiModeration(client: unknown, opts: OpenaiModerationOptions = {}): Guardrail {
  const {
    model = 'omni-moderation-latest',
    categories,
    stage = 'input',
    action = 'block',
    name = 'openai_moderation',
    timeout,
    onError,
  } = opts;
  const cats = categories ? new Set([...categories].map((c) => c.toLowerCase())) : null;
  const check: Check = async (payload: unknown, _ctx: Context) => {
    const moderations = get(client, 'moderations') as
      | { create: (args: { model: string; input: string }) => unknown }
      | undefined;
    if (moderations == null || typeof moderations.create !== 'function') {
      throw new TypeError('openaiModeration client has no moderations.create()');
    }
    const resp = await moderations.create({ model, input: payloadText(payload) });
    const results = (get(resp, 'results') as unknown[] | undefined) ?? [];
    if (results.length === 0) return null;
    const result = results[0];
    const flagged = flaggedCategories(get(result, 'categories', {}));
    if (cats !== null) {
      const hit = flagged.filter((c) => cats.has(c.toLowerCase())).sort();
      return hit.length > 0 ? new Verdict(action, `moderation flagged: ${hit.join(', ')}`) : null;
    }
    if (get(result, 'flagged', false)) {
      const names = flagged.join(', ') || 'policy';
      return new Verdict(action, `moderation flagged: ${names}`);
    }
    return null;
  };
  return mk(check, { name, stage, action, timeout, onError });
}
