/**
 * Deterministic, local-first built-in rules — the microsecond, $0 tier. The TS port of
 * `cendor.guardrails.rules`. Regex/arithmetic only: no model, no network, no heavy dependency.
 *
 * Deliberately NOT here: PII/secret detection (that is `@cendor/acttrace`'s detector catalogue —
 * use `guard(Policy…)`), ML classifiers, jailbreak detection. `llmJudge` is an adapter *contract*
 * (you supply the model call), never a bundled classifier. Deterministic checks do not stop a novel
 * adversarial attack — see docs/guardrails.md "Honest limits".
 */
import { tokens } from '@cendor/core';
import {
  type Check,
  type Context,
  type Guardrail,
  type OnError,
  Verdict,
  normalizeStages,
  validateExecutionPolicy,
} from './decision.js';

type Message = Record<string, unknown>;
type Stage = string | readonly string[];

// --------------------------------------------------------------------------- payload helpers

/** Flatten a payload (string, chat-message array, or a single message object) to scannable text. */
export function payloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (Array.isArray(payload)) {
    return payload
      .filter((m) => m != null)
      .map((m) => (isMessageLike(m) ? messageText(m as Message) : String(m)))
      .join('\n');
  }
  if (payload && typeof payload === 'object') {
    const o = payload as Message;
    // a chat message ({role,content}) -> its text; any other object (e.g. tool args) -> its JSON.
    if ('content' in o || 'role' in o) return messageText(o);
    return JSON.stringify(o);
  }
  return String(payload);
}

function isMessageLike(m: unknown): boolean {
  return m != null && typeof m === 'object';
}

function messageText(msg: Message): string {
  const content = msg.content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' ? String((p as Message).text ?? '') : ''))
      .join('');
  }
  return content == null ? '' : String(content);
}

/** Apply `sub` to every text field of `payload`, returning a new structure of the same shape. */
function redactPayload(payload: unknown, sub: (s: string) => string): unknown {
  if (typeof payload === 'string') return sub(payload);
  if (Array.isArray(payload)) {
    return payload.map((m) =>
      isMessageLike(m) ? redactMessage(m as Message, sub) : typeof m === 'string' ? sub(m) : m,
    );
  }
  if (payload && typeof payload === 'object') return redactMessage(payload as Message, sub);
  return payload;
}

function redactMessage(msg: Message, sub: (s: string) => string): Message {
  const out: Message = { ...msg };
  const content = out.content;
  if (typeof content === 'string') {
    out.content = sub(content);
  } else if (Array.isArray(content)) {
    out.content = content.map((p) =>
      p && typeof p === 'object' && typeof (p as Message).text === 'string'
        ? { ...(p as Message), text: sub((p as Message).text as string) }
        : p,
    );
  }
  return out;
}

function mkGuardrail(
  name: string,
  stage: Stage,
  check: Check,
  exec: { timeout?: number; onError?: OnError } = {},
): Guardrail {
  const g: Guardrail = { name, stages: normalizeStages(stage), check };
  // Deterministic built-ins leave the execution policy unset (the engine defaults on_error to
  // fail_closed); only `custom` / `llmJudge` attach a timeout / on_error.
  if (exec.onError !== undefined || exec.timeout !== undefined) {
    const onError = exec.onError ?? 'fail_closed';
    validateExecutionPolicy(exec.timeout, onError);
    g.onError = onError;
    if (exec.timeout !== undefined) g.timeout = exec.timeout;
  }
  return g;
}

/**
 * Default the error policy from a guardrail's action: a `block` gate fails **closed** (an errored
 * check is treated as a block), while a `flag` degrades to advisory (`fail_open`). An explicit
 * `onError` always wins.
 */
function resolveOnError(action: 'block' | 'redact' | 'flag', onError?: OnError): OnError {
  if (onError !== undefined) return onError;
  return action === 'flag' ? 'fail_open' : 'fail_closed';
}

// --------------------------------------------------------------------------- matching helpers

/** Match modes for `keywordDeny` (`normalize` steps live in {@link NORMALIZATIONS}). */
export type MatchMode = 'substring' | 'word';
export const NORMALIZATIONS = [
  'nfkc',
  'nfc',
  'nfkd',
  'nfd',
  'casefold',
  'strip_zero_width',
  'collapse_whitespace',
] as const;
export type Normalization = (typeof NORMALIZATIONS)[number];

// Zero-width / invisible characters an attacker can splice into a term to slip a substring match
// ("b<zwsp>omb"); stripped only when "strip_zero_width" is in `normalize`. An alternation of explicit
// escapes (not a character class) so a joiner can't compose (biome noMisleadingCharacterClass).
const ZERO_WIDTH_RE = /​|‌|‍|⁠|﻿|­|᠎/g;
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build a text normalizer from `steps` (a subset of {@link NORMALIZATIONS}). Returns identity when
 * `steps` is empty — so the default matcher is byte-for-byte unchanged. Applied to both sides of a
 * comparison so a deny term and the payload fold the same way. (`casefold` maps to `toLowerCase()`,
 * the closest all-runtime fold.)
 */
function normalizer(steps: readonly string[] | undefined): (s: string) => string {
  if (!steps || steps.length === 0) return (s) => s;
  const ops: ((s: string) => string)[] = [];
  for (const step of steps) {
    const key = step.toLowerCase();
    if (key === 'nfkc' || key === 'nfc' || key === 'nfkd' || key === 'nfd') {
      const form = key.toUpperCase() as 'NFKC' | 'NFC' | 'NFKD' | 'NFD';
      ops.push((s) => s.normalize(form));
    } else if (key === 'casefold') {
      ops.push((s) => s.toLowerCase());
    } else if (key === 'strip_zero_width') {
      ops.push((s) => s.replace(ZERO_WIDTH_RE, ''));
    } else if (key === 'collapse_whitespace') {
      ops.push((s) => s.replace(/\s+/g, ' ').trim());
    } else {
      throw new Error(
        `unknown normalize step ${JSON.stringify(step)}; must be one of ${NORMALIZATIONS.join(', ')}`,
      );
    }
  }
  return (s) => ops.reduce((acc, op) => op(acc), s);
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * The regex fragment for one deny `term` under the chosen `match` mode. `"substring"` is the escaped
 * literal; `"word"` anchors it on Unicode word boundaries (JS `\b` is ASCII-only, so we use
 * `\p{L}\p{N}_` lookarounds under the `u` flag) and lets interior whitespace span line-wraps (`\s+`),
 * so `"python code"` still hits across a newline but not inside `"pythoncoder"`.
 */
function termRegex(term: string, match: MatchMode): string {
  if (match === 'substring') return escapeRegex(term);
  const stripped = term.trim();
  const parts = stripped.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const body = parts.map(escapeRegex).join('\\s+');
  const left = WORD_CHAR.test(stripped[0]!) ? '(?<![\\p{L}\\p{N}_])' : '';
  const right = WORD_CHAR.test(stripped[stripped.length - 1]!) ? '(?![\\p{L}\\p{N}_])' : '';
  return `${left}${body}${right}`;
}

// --------------------------------------------------------------------------- rules

export interface KeywordDenyOptions {
  stage?: Stage;
  action?: 'block' | 'redact' | 'flag';
  name?: string;
  ignoreCase?: boolean;
  /** `"substring"` (default) matches anywhere; `"word"` anchors on Unicode word boundaries. */
  match?: MatchMode;
  /** Fold both payload and terms before comparing (e.g. `["nfkc", "strip_zero_width"]`). Default off. */
  normalize?: readonly Normalization[];
}

/**
 * Trip when any of `words` appears in the payload; records the matched term in
 * `metadata.matched`. `action:"redact"` scrubs matches to `[redacted]`.
 *
 * Matching options default to the original substring behaviour (a deny-list is a security primitive,
 * so nothing changes silently in a minor). `match:"word"` anchors each term on Unicode word
 * boundaries; `normalize` folds both sides (recommended hardening `["nfkc", "strip_zero_width"]`
 * closes full-width `"ｂｏｍｂ"` / zero-width `"b​omb"` evasions). Combining `normalize` with
 * `action:"redact"` also normalizes the surviving text (match offsets live in normalized space).
 */
export function keywordDeny(words: Iterable<string>, opts: KeywordDenyOptions = {}): Guardrail {
  const {
    stage = 'input',
    action = 'block',
    name = 'keyword_deny',
    ignoreCase = true,
    match = 'substring',
    normalize,
  } = opts;
  if (match !== 'substring' && match !== 'word') {
    throw new Error(`unknown match ${JSON.stringify(match)}; must be 'substring' or 'word'`);
  }
  const norm = normalizer(normalize);
  const fragments = [...words]
    .filter(Boolean)
    .map((w) => termRegex(norm(w), match))
    .filter(Boolean);
  const flags = `${ignoreCase ? 'i' : ''}u`;
  const pattern = fragments.length > 0 ? new RegExp(fragments.join('|'), flags) : null;
  return mkGuardrail(name, stage, (payload) => {
    if (pattern === null) return null;
    const match_ = pattern.exec(norm(payloadText(payload)));
    if (match_ === null) return null;
    const hit = match_[0];
    const reason = `denied keyword: ${JSON.stringify(hit)}`;
    const meta = { matched: hit };
    if (action === 'redact') {
      const g = new RegExp(pattern.source, `${flags}g`);
      return new Verdict(
        'redact',
        reason,
        redactPayload(payload, (s) => norm(s).replace(g, '[redacted]')),
        meta,
      );
    }
    return new Verdict(action, reason, null, meta);
  });
}

export interface RegexRuleOptions {
  action?: 'block' | 'redact' | 'flag';
  stage?: Stage;
  name?: string;
  replacement?: string;
}

/** Trip when `pattern` matches the payload text. `action:"redact"` substitutes each match. */
export function regexRule(pattern: RegExp | string, opts: RegexRuleOptions = {}): Guardrail {
  const {
    action = 'flag',
    stage = 'input',
    name = 'regex_rule',
    replacement = '[redacted]',
  } = opts;
  const flags = typeof pattern === 'string' ? '' : pattern.flags.replace('g', '');
  const source = typeof pattern === 'string' ? pattern : pattern.source;
  const test = new RegExp(source, flags);
  return mkGuardrail(name, stage, (payload) => {
    if (!test.test(payloadText(payload))) return null;
    const reason = `matched /${source}/`;
    if (action === 'redact') {
      const g = new RegExp(source, `${flags.replace('g', '')}g`);
      return new Verdict(
        'redact',
        reason,
        redactPayload(payload, (s) => s.replace(g, replacement)),
      );
    }
    return new Verdict(action, reason);
  });
}

// --------------------------------------------------------------------------- spotlight

/** UTF-8 → base-64, all-runtime (btoa + TextEncoder; no `node:*` / Buffer). */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Derive the (opening, closing) wrapper from `delimiter`. A tag-shaped delimiter (`"<untrusted>"`)
 * yields a matching close tag (`"</untrusted>"`); any other string is used verbatim on both sides.
 */
function spotlightDelimiters(delimiter: string): [string, string] {
  const d = delimiter.trim();
  if (d.startsWith('<') && d.endsWith('>') && !d.startsWith('</')) {
    const tag = d.slice(1, -1).trim();
    if (tag) return [`<${tag}>`, `</${tag}>`];
  }
  return [delimiter, delimiter];
}

function spotlightWrap(text: string, delimiter: string, encode: boolean): string {
  if (!text.trim()) return text; // nothing to wrap
  const body = encode ? base64(text) : text;
  const [open, close] = spotlightDelimiters(delimiter);
  return `${open}\n${body}\n${close}`;
}

export interface SpotlightOptions {
  stage?: Stage;
  delimiter?: string;
  encode?: boolean;
  name?: string;
}

/**
 * Wrap untrusted content in a trust-lowering delimiter — a deterministic, `$0`, offline
 * **mitigation** (not a detector), inspired by Azure Foundry's *Spotlighting*.
 *
 * The check **always** returns a `redact` verdict — it never blocks; it rewrites the payload,
 * wrapping each scannable text field in `delimiter` (a tag like `"<untrusted>"` gets a matching
 * `"</untrusted>"` close; any other string is used on both sides) so the model treats that span as
 * lower-trust data, not instructions. With `encode:true` the wrapped body is base-64-encoded
 * (mirroring Azure). Payload shape (string / message array / object) is preserved, so it composes
 * with the rules that follow it and with a BYO judge. Most useful at `tool_output` (retrieved docs,
 * tool results, emails — the indirect-injection surface).
 *
 * **Honest limits (from Azure's own page):** a mitigation, not detection; `encode:true` inflates
 * token count (higher model cost, possible context-limit hits). `encode` defaults **off**.
 */
export function spotlight(opts: SpotlightOptions = {}): Guardrail {
  const {
    stage = ['input', 'tool_output'],
    delimiter = '<untrusted>',
    encode = false,
    name = 'spotlight',
  } = opts;
  return mkGuardrail(name, stage, (payload) => {
    const wrapped = redactPayload(payload, (s) => spotlightWrap(s, delimiter, encode));
    return new Verdict('redact', 'spotlighted untrusted content', wrapped, { redacted: true });
  });
}

const URL_RE = /https?:\/\/[^\s<>)\]}"']+/gi;

function* iterHosts(text: string): Generator<string> {
  for (const match of text.matchAll(URL_RE)) {
    try {
      const host = new URL(match[0]).hostname.toLowerCase();
      if (host) yield host;
    } catch {
      // not a parseable URL — skip
    }
  }
}

function hostMatches(host: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/^\.+/, '');
  return host === d || host.endsWith(`.${d}`);
}

export interface UrlRuleOptions {
  stage?: Stage;
  action?: 'block' | 'redact' | 'flag';
  name?: string;
}

/** Trip when a URL's host is NOT on `domains` (or a subdomain of one). */
export function urlAllowlist(domains: Iterable<string>, opts: UrlRuleOptions = {}): Guardrail {
  const { stage = 'input', action = 'block', name = 'url_allowlist' } = opts;
  const allowed = [...domains].filter(Boolean);
  return mkGuardrail(name, stage, (payload) => {
    for (const host of iterHosts(payloadText(payload))) {
      if (!allowed.some((d) => hostMatches(host, d))) {
        return new Verdict(action, `URL host not allowlisted: ${host}`);
      }
    }
    return null;
  });
}

/** Trip when a URL's host is on `domains` (or a subdomain of one). */
export function urlDeny(domains: Iterable<string>, opts: UrlRuleOptions = {}): Guardrail {
  const { stage = 'input', action = 'block', name = 'url_deny' } = opts;
  const denied = [...domains].filter(Boolean);
  return mkGuardrail(name, stage, (payload) => {
    for (const host of iterHosts(payloadText(payload))) {
      if (denied.some((d) => hostMatches(host, d))) {
        return new Verdict(action, `URL host denied: ${host}`);
      }
    }
    return null;
  });
}

export interface LengthBoundsOptions {
  maxChars?: number;
  maxTokens?: number;
  model?: string;
  stage?: Stage;
  action?: 'block' | 'redact' | 'flag';
  name?: string;
}

/** Trip when the payload exceeds `maxChars` and/or `maxTokens` (exact token counts via core). */
export function lengthBounds(opts: LengthBoundsOptions = {}): Guardrail {
  const {
    maxChars,
    maxTokens,
    model = 'gpt-4o',
    stage = 'input',
    action = 'block',
    name = 'length_bounds',
  } = opts;
  if (maxChars === undefined && maxTokens === undefined) {
    throw new Error('lengthBounds needs at least one of maxChars / maxTokens');
  }
  return mkGuardrail(name, stage, (payload) => {
    const text = payloadText(payload);
    if (maxChars !== undefined && text.length > maxChars) {
      return new Verdict(action, `${text.length} chars exceeds max ${maxChars}`);
    }
    if (maxTokens !== undefined) {
      const countable = (Array.isArray(payload) ? payload : text) as string | Message[];
      const n = tokens.count(countable, model);
      if (n > maxTokens) return new Verdict(action, `${n} tokens exceeds max ${maxTokens}`);
    }
    return null;
  });
}

export interface JsonSchemaOptions {
  stage?: Stage;
  action?: 'block' | 'redact' | 'flag';
  name?: string;
}

/**
 * Validate structured output against a minimal JSON Schema (`type`/`required`/`properties`/`items`,
 * recursively). Trips when the payload is not valid JSON or violates the schema. Pass the model's
 * raw text or an already-parsed object. Not the full spec (no `$ref`/`oneOf`/`pattern`).
 */
export function jsonSchema(
  schema: Record<string, unknown>,
  opts: JsonSchemaOptions = {},
): Guardrail {
  const { stage = 'output', action = 'block', name = 'json_schema' } = opts;
  return mkGuardrail(name, stage, (payload) => {
    let data: unknown;
    if (payload !== null && typeof payload === 'object') {
      data = payload;
    } else {
      try {
        data = JSON.parse(payloadText(payload));
      } catch (e) {
        return new Verdict(action, `output is not valid JSON: ${(e as Error).message}`);
      }
    }
    const error = validate(data, schema, '$');
    return error === null ? null : new Verdict(action, `schema violation: ${error}`);
  });
}

export interface CustomOptions {
  stage?: Stage;
  name?: string;
  /** Per-check wall-clock limit in seconds (async path only). */
  timeout?: number;
  /** Error/timeout policy (default `"fail_closed"`). */
  onError?: OnError;
}

/**
 * Wrap any `fn(payload, ctx) -> Verdict | null` as a `Guardrail` (sync or async). Your `fn` is
 * arbitrary code, so it can throw or hang: `timeout` (seconds, async path) bounds it and `onError`
 * (`"fail_closed"` default / `"fail_open"`) decides what a throw or timeout does — either way the
 * failure is recorded as a decision.
 */
export function custom(fn: Check, opts: CustomOptions = {}): Guardrail {
  return mkGuardrail(opts.name ?? (fn.name || 'custom'), opts.stage ?? 'input', fn, {
    timeout: opts.timeout,
    onError: opts.onError ?? 'fail_closed',
  });
}

export interface LlmJudgeOptions {
  stage?: Stage;
  action?: 'block' | 'redact' | 'flag';
  name?: string;
  /** Per-check wall-clock limit in seconds (async path only). */
  timeout?: number;
  /** Error/timeout policy; defaults from `action` (flag → `fail_open`, else `fail_closed`). */
  onError?: OnError;
}

/**
 * Adapter **contract** for a bring-your-own model judge — not a built-in classifier. `judge` is
 * *your* (sync or async) callable that makes whatever model call you want and returns a `Verdict`,
 * `true` to trip with the default `action`, a reason string, or `null`/`false` to pass. cendor ships
 * no model here: the extra call costs real tokens and latency — measure it. See "Honest limits".
 */
export function llmJudge(
  judge: (
    payload: unknown,
    ctx: Context,
  ) => Verdict | boolean | string | null | Promise<Verdict | boolean | string | null>,
  opts: LlmJudgeOptions = {},
): Guardrail {
  const { stage = 'output', action = 'block', name = 'llm_judge' } = opts;
  const check: Check = async (payload, ctx) => coerce(await judge(payload, ctx), action);
  return mkGuardrail(name, stage, check, {
    timeout: opts.timeout,
    onError: resolveOnError(action, opts.onError),
  });
}

function coerce(
  result: Verdict | boolean | string | null,
  action: 'block' | 'redact' | 'flag',
): Verdict | null {
  if (result === null || result === false) return null;
  if (result instanceof Verdict) return result;
  if (result === true) return new Verdict(action, 'llmJudge tripped');
  if (typeof result === 'string') return new Verdict(action, result);
  return new Verdict(action, 'llmJudge tripped');
}

// --------------------------------------------------------------------------- minimal JSON Schema

const TYPE_CHECK: Record<string, (d: unknown) => boolean> = {
  object: (d) => d !== null && typeof d === 'object' && !Array.isArray(d),
  array: (d) => Array.isArray(d),
  string: (d) => typeof d === 'string',
  number: (d) => typeof d === 'number',
  integer: (d) => typeof d === 'number' && Number.isInteger(d),
  boolean: (d) => typeof d === 'boolean',
  null: (d) => d === null,
};

function validate(data: unknown, schema: Record<string, unknown>, path: string): string | null {
  const expected = schema.type as string | undefined;
  if (expected !== undefined) {
    const checker = TYPE_CHECK[expected];
    if (checker && !checker(data)) return `${path}: expected ${expected}, got ${typeName(data)}`;
  }
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    for (const key of (schema.required as string[]) ?? []) {
      if (!(key in obj)) return `${path}: missing required key ${JSON.stringify(key)}`;
    }
    const props = (schema.properties as Record<string, unknown>) ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj && sub && typeof sub === 'object') {
        const err = validate(obj[key], sub as Record<string, unknown>, `${path}.${key}`);
        if (err !== null) return err;
      }
    }
  }
  if (Array.isArray(data) && schema.items && typeof schema.items === 'object') {
    for (let i = 0; i < data.length; i++) {
      const err = validate(data[i], schema.items as Record<string, unknown>, `${path}[${i}]`);
      if (err !== null) return err;
    }
  }
  return null;
}

function typeName(d: unknown): string {
  if (d === null) return 'null';
  if (Array.isArray(d)) return 'array';
  return typeof d;
}

// --------------------------------------------------------------------------- detection-tier adapters
//
// The opt-in detection tier (local ML classifier / language detector / hosted moderation + the three
// hosted rails) lives in `./adapters`, and the similarity checks (groundedness / deniedTopics) in
// `./semantic` — each reuses `payloadText` above. Re-exported here so they read as `rules.classifier`
// / `rules.bedrockGuardrail` / `rules.groundedness` etc. as one surface (like Python's `rules`). Both
// import only `./decision` + `payloadText` (a hoisted function), so the cycle is runtime-safe.
export {
  classifier,
  language,
  openaiModeration,
  bedrockGuardrail,
  azureContentSafety,
  modelArmor,
} from './adapters.js';
export { groundedness, deniedTopics, customCategory } from './semantic.js';
export { intent } from './intent.js';
