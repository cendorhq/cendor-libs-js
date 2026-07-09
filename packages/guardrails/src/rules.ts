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

// --------------------------------------------------------------------------- rules

export interface KeywordDenyOptions {
  stage?: Stage;
  action?: 'block' | 'redact' | 'flag';
  name?: string;
  ignoreCase?: boolean;
}

/** Trip when any of `words` appears (substring, case-insensitive by default). */
export function keywordDeny(words: Iterable<string>, opts: KeywordDenyOptions = {}): Guardrail {
  const { stage = 'input', action = 'block', name = 'keyword_deny', ignoreCase = true } = opts;
  const terms = [...words].filter(Boolean);
  const pattern =
    terms.length > 0
      ? new RegExp(
          terms.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
          ignoreCase ? 'i' : '',
        )
      : null;
  return mkGuardrail(name, stage, (payload) => {
    if (pattern === null) return null;
    const match = pattern.exec(payloadText(payload));
    if (match === null) return null;
    const reason = `denied keyword: ${JSON.stringify(match[0])}`;
    if (action === 'redact') {
      const g = new RegExp(pattern.source, ignoreCase ? 'gi' : 'g');
      return new Verdict(
        'redact',
        reason,
        redactPayload(payload, (s) => s.replace(g, '[redacted]')),
      );
    }
    return new Verdict(action, reason);
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
