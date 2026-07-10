/**
 * Config-as-data — build a guardrail list from a versioned JSON/YAML policy. The TS port of
 * `cendor.guardrails.policy`.
 *
 * `loadPolicy` reads a policy **document or text** (there is no filesystem in an all-runtime package —
 * read the file yourself and pass the text/object) and builds the `Guardrail[]` you hand to
 * `Agent({ guardrails })` / `install()`. The point is **evidence**: the document's content hash and
 * declared version are stamped into every decision's `metadata` (`policy_hash` / `policy_version`), so
 * the audit chain proves *which* policy was active. Only the deterministic built-ins are constructible
 * from data. JSON is built in; for YAML pass a `parse` (e.g. `yaml`'s `parse`).
 *
 * ```ts
 * import { loadPolicy } from '@cendor/guardrails';
 * const policy = loadPolicy(jsonText);            // or loadPolicy(text, { parse: YAML.parse })
 * agent = new Agent({ guardrails: policy });
 * policy.policyHash;    // "sha256:…"   policy.policyVersion; // "2026-07-09"
 * ```
 */
import { type Guardrail, normalizeStages } from './decision.js';
import {
  jsonSchema,
  keywordDeny,
  lengthBounds,
  regexRule,
  urlAllowlist,
  urlDeny,
} from './rules.js';

type Action = 'block' | 'redact' | 'flag';
type Common = { stage?: string | string[]; action?: Action; name?: string };
type Args = Record<string, unknown>;

/** A `Guardrail[]` with provenance — pass it straight to `Agent({ guardrails })` / `install()`. */
export interface LoadedPolicy extends Array<Guardrail> {
  /** `"sha256:<hex>"` of the canonical document — also stamped onto every decision. */
  policyHash: string;
  /** The document's `version` field — also stamped onto every decision. */
  policyVersion: string;
}

export interface LoadPolicyOptions {
  /** Parse `source` when it is a string (default `JSON.parse`); pass e.g. a YAML parser for YAML. */
  parse?: (text: string) => unknown;
  /** When `true`, run a structural check (see {@link policySchema}) before building any rule. */
  validate?: boolean;
}

const STAGE_NAMES = ['input', 'tool_call', 'tool_output', 'output'] as const;
const ACTION_NAMES = ['block', 'redact', 'flag'] as const;

/**
 * The JSON Schema (Draft 2020-12) for a policy document — mirrors the `policy.schema.json` shipped in
 * the Python package (there is no filesystem in an all-runtime package, so it is an inline constant).
 * Reference it from your policy file's `$schema` for editor autocomplete, or use it in your tooling.
 * `loadPolicy(text, { validate: true })` checks a document against this shape.
 */
export function policySchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://cendor.ai/schemas/guardrails-policy.schema.json',
    title: 'cendor-guardrails policy',
    type: 'object',
    required: ['guardrails'],
    additionalProperties: false,
    properties: {
      version: { type: 'string' },
      guardrails: { type: 'array', items: { $ref: '#/$defs/guardrail' } },
    },
    $defs: {
      stage: { enum: [...STAGE_NAMES] },
      guardrail: {
        type: 'object',
        required: ['rule'],
        additionalProperties: false,
        properties: {
          rule: { enum: [...POLICY_RULE_NAMES] },
          args: { type: 'object' },
          stage: {
            oneOf: [
              { $ref: '#/$defs/stage' },
              { type: 'array', items: { $ref: '#/$defs/stage' }, minItems: 1 },
            ],
          },
          action: { enum: [...ACTION_NAMES] },
          name: { type: 'string' },
        },
      },
    },
  };
}

/**
 * A small structural check of a policy document (opt-in via `validate: true`) — clearer, earlier
 * errors than letting a factory throw. Not a full JSON-Schema engine; {@link policySchema} is the
 * reference for tooling.
 */
function validateDocument(doc: Record<string, unknown>): void {
  if ('version' in doc && typeof doc.version !== 'string') {
    throw new Error("policy 'version' must be a string");
  }
  const entries = doc.guardrails;
  if (!Array.isArray(entries)) throw new Error("policy document must have a 'guardrails' array");
  entries.forEach((entry, i) => {
    const where = `guardrails[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${where} must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (!POLICY_RULE_NAMES.includes(String(e.rule))) {
      throw new Error(
        `${where}: unknown or non-declarative rule ${JSON.stringify(e.rule)}; policy documents support ${POLICY_RULE_NAMES.join(', ')}`,
      );
    }
    if ('args' in e && (e.args === null || typeof e.args !== 'object' || Array.isArray(e.args))) {
      throw new Error(`${where}.args must be an object`);
    }
    if ('action' in e && !(ACTION_NAMES as readonly string[]).includes(String(e.action))) {
      throw new Error(
        `${where}.action ${JSON.stringify(e.action)} must be one of ${ACTION_NAMES.join(', ')}`,
      );
    }
    if ('stage' in e) {
      const stages = Array.isArray(e.stage) ? e.stage : [e.stage];
      for (const s of stages) {
        if (!(STAGE_NAMES as readonly string[]).includes(String(s))) {
          throw new Error(
            `${where}.stage ${JSON.stringify(s)} must be one of ${STAGE_NAMES.join(', ')}`,
          );
        }
      }
    }
  });
}

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const bool = (v: unknown): boolean | undefined => (v === undefined ? undefined : Boolean(v));

/** The rules constructible from data alone (deterministic; no callable / client / embedding fn). */
const POLICY_RULES: Record<string, (a: Args, c: Common) => Guardrail> = {
  keyword_deny: (a, c) =>
    keywordDeny(arr(a.words), {
      stage: c.stage,
      action: c.action,
      name: c.name,
      ignoreCase: bool(a.ignore_case ?? a.ignoreCase),
    }),
  regex_rule: (a, c) =>
    regexRule(String(a.pattern ?? ''), {
      stage: c.stage,
      action: c.action,
      name: c.name,
      replacement: a.replacement === undefined ? undefined : String(a.replacement),
    }),
  url_allowlist: (a, c) =>
    urlAllowlist(arr(a.domains), { stage: c.stage, action: c.action, name: c.name }),
  url_deny: (a, c) => urlDeny(arr(a.domains), { stage: c.stage, action: c.action, name: c.name }),
  length_bounds: (a, c) =>
    lengthBounds({
      stage: c.stage,
      action: c.action,
      name: c.name,
      maxChars: (a.max_chars ?? a.maxChars) as number | undefined,
      maxTokens: (a.max_tokens ?? a.maxTokens) as number | undefined,
      model: a.model as string | undefined,
    }),
  json_schema: (a, c) =>
    jsonSchema((a.schema ?? {}) as Record<string, unknown>, {
      stage: c.stage,
      action: c.action,
      name: c.name,
    }),
};

/** The rule names a policy document may use (deterministic built-ins only). */
export const POLICY_RULE_NAMES: readonly string[] = Object.keys(POLICY_RULES);

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

function coerceStage(stage: unknown): string | string[] | undefined {
  if (Array.isArray(stage)) return stage.map(String);
  if (typeof stage === 'string') return stage;
  return undefined;
}

/**
 * Build a {@link LoadedPolicy} from a JSON/YAML document (a parsed object, or text parsed with
 * `JSON.parse` / your `opts.parse`). Every guardrail is stamped with `policy_hash` / `policy_version`
 * in its metadata, so each decision records which policy was active.
 *
 * @throws if the document is malformed or names an unknown / non-declarative rule.
 */
export function loadPolicy(
  source: string | Record<string, unknown>,
  opts: LoadPolicyOptions = {},
): LoadedPolicy {
  const config: unknown = typeof source === 'string' ? (opts.parse ?? JSON.parse)(source) : source;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('policy document must be an object');
  }
  const doc = config as Record<string, unknown>;
  if (opts.validate) validateDocument(doc);
  const entries = doc.guardrails;
  if (!Array.isArray(entries)) throw new Error("policy document must have a 'guardrails' array");

  const policyHash = `sha256:${sha256Hex(canonical(doc))}`;
  const policyVersion = String(doc.version ?? '');
  const stamp = { policy_hash: policyHash, policy_version: policyVersion };

  const guardrails: Guardrail[] = entries.map((entry, i) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`guardrails[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const rule = String(e.rule);
    const build = POLICY_RULES[rule];
    if (build === undefined) {
      throw new Error(
        `guardrails[${i}]: unknown or non-declarative rule ${JSON.stringify(rule)}; policy documents support ${POLICY_RULE_NAMES.join(', ')} (rules needing a callable or a client are wired in code)`,
      );
    }
    const common: Common = {
      stage: coerceStage(e.stage),
      action: e.action as Action | undefined,
      name: e.name as string | undefined,
    };
    let g: Guardrail;
    try {
      g = build((e.args as Args) ?? {}, common);
    } catch (err) {
      throw new Error(`guardrails[${i}] (${rule}): bad arguments — ${(err as Error).message}`);
    }
    // touch normalizeStages defensively so an explicit bad stage array fails here with the index
    if (common.stage !== undefined) normalizeStages(common.stage);
    g.metadata = { ...(g.metadata ?? {}), ...stamp };
    return g;
  });

  const policy = guardrails as LoadedPolicy;
  policy.policyHash = policyHash;
  policy.policyVersion = policyVersion;
  return policy;
}

// --------------------------------------------------------------------------- SHA-256 (all-runtime)
//
// A compact, dependency-free SHA-256 so `loadPolicy` stays SYNC and all-runtime (no node:crypto, no
// async crypto.subtle). Verified against the standard "" / "abc" vectors in the tests. The hash is
// canonical-per-language (over TS's canonical JSON); it is not promised byte-identical to Python's.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const l = bytes.length;
  const withOne = l + 1;
  const pad = (56 - (withOne % 64) + 64) % 64;
  const total = withOne + pad + 8;
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[l] = 0x80;
  const dv = new DataView(msg.buffer);
  // 64-bit big-endian bit length; inputs here are well under 2^32 bits, so the high word is 0.
  dv.setUint32(total - 4, (l * 8) >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let i = 0; i < total; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const w15 = w[t - 15]!;
      const w2 = w[t - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let t = 0; t < 64; t++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + K[t]! + w[t]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => (x >>> 0).toString(16).padStart(8, '0'))
    .join('');
}
