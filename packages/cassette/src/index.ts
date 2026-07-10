import { AsyncLocalStorage } from 'node:async_hooks';
/**
 * `@cendor/cassette` — record an agent run once, replay it forever. Offline, deterministic, free.
 * The byte-conformant TypeScript port of `cendor.cassette`.
 *
 * The `vcrpy` of the agent era, except it captures the *whole* run: every LLM call and tool call,
 * in order. It cooperates through `@cendor/core` — it never patches a client itself:
 *
 *   - **record** — subscribes to the bus, capturing each `LLMCall`/`ToolCall` (request + the raw
 *     response core attaches) keyed by a normalized request hash, then writes a JSON cassette.
 *   - **replay** — registers a core *interceptor* that returns the recorded response by hash before
 *     the real call runs. Unknown call -> clear failure.
 *
 * Secrets/PII are redacted on record (cassettes get committed). `semanticMatch` asserts *meaning*
 * for output that won't be byte-identical: a lexical default (offline, zero-dep), or a bring-your-own
 * `embedFn` (`embeddingScorer`) that wraps any provider's embeddings.
 *
 * Cross-language conformance rules (mirrors the Python package byte-for-byte):
 *   - the hash is `sha256Hex(canonical(request))` over the **un-redacted** normalized request;
 *   - wire keys are snake_case (`request_hash`, `response_type`, `input_tokens`, ...);
 *   - the file is `json.dumps(indent=2, ensure_ascii=False)` (via {@link dumpsIndent2}) with no
 *     trailing newline, insertion-order keys, and the 6-field entry order.
 */
import { LLMCall, MISS, ToolCall, addInterceptor, bus, removeInterceptor } from '@cendor/core';
import { sha256Hex } from './hash.js';
import { PyFloat, type PyValue, canonical, dumpsIndent2, parsePreserving } from './pyjson.js';
import { type CassetteStorage, resolveStorage } from './storage.js';

export type { CassetteStorage } from './storage.js';

// --------------------------------------------------------------------------- version + globals

/** Current cassette format. v2 folds `stream` into the request hash and records a `response_type`
 * marker; v1 (no `stream` in the hash, no marker) is still readable on replay. */
const FORMAT_VERSION = 2;
const SUPPORTED_VERSIONS = [1, 2] as const;

/** Divergences found by the most recent `mode: 'rerecord'` run. Mutated in place (never reassigned)
 * so external references (and {@link drift}) stay live — mirrors Python's module-global `_drift`. */
export const _drift: Array<Record<string, unknown>> = [];

/** Marks which record/replay context an event belongs to, so concurrent `using()` blocks on the
 * process-global bus don't capture each other's events (Python's `_active_session` ContextVar). */
const activeSession = new AsyncLocalStorage<string>();

function uuidHex(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '');
}

/** Raised on replay when a call has no matching recorded entry, or on an unreadable cassette. */
export class CassetteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CassetteError';
  }
}

/** One recorded interaction in a run. Field order is load-bearing — it is the on-disk key order. */
export class CassetteEntry {
  constructor(
    public seq: number,
    public kind: string,
    public request_hash: string,
    public request: PyValue,
    public response: PyValue,
    public response_type = 'object',
  ) {}
}

function entryToJson(e: CassetteEntry): PyValue {
  // Explicit insertion order = the six-field on-disk order (seq, kind, request_hash, request,
  // response, response_type). dumpsIndent2 preserves it.
  return {
    seq: e.seq,
    kind: e.kind,
    request_hash: e.request_hash,
    request: e.request,
    response: e.response,
    response_type: e.response_type,
  };
}

// --------------------------------------------------------------------------- redaction

/** Ordered redaction patterns. Ported verbatim from Python's `_REDACTIONS`; each `sub()` runs on
 * the prior result. `g` = replace-all (Python `re.sub`); NO `u` flag so `\b`/`\w` keep ASCII
 * semantics matching Python's on these patterns. `[Bb]earer` only (all-caps BEARER survives). */
const REDACTIONS: RegExp[] = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // email
  /\bsk-[A-Za-z0-9_-]{8,}/g, // openai keys: sk-, sk-ant-…, sk-proj-…, legacy
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // bare JWT
  /\b[Bb]earer\s+[A-Za-z0-9._-]+\b/g, // bearer tokens
  /\b[A-Za-z0-9_-]{32,}\b/g, // long opaque tokens
];

/** The built-in scrubber. Strings run through every pattern in order; dict *keys* are never
 * scrubbed (only values); lists recurse; all other leaves (numbers/bool/null) pass through. */
function builtinRedact(obj: unknown): unknown {
  if (typeof obj === 'string') {
    let out = obj;
    for (const pat of REDACTIONS) out = out.replace(pat, '<redacted>');
    return out;
  }
  if (Array.isArray(obj)) return obj.map(builtinRedact);
  if (obj !== null && typeof obj === 'object' && !(obj instanceof PyFloat)) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) o[k] = builtinRedact(v);
    return o;
  }
  return obj;
}

/** A custom scrubber, or the boolean shorthands. `True` = built-in, `False` = verbatim identity. */
export type Redact = boolean | ((obj: unknown) => unknown);
type Redactor = (obj: unknown) => unknown;

function resolveRedactor(redact: Redact): Redactor {
  if (redact === true) return builtinRedact;
  if (redact === false) return (obj) => obj;
  if (typeof redact === 'function') return redact;
  throw new TypeError('redact must be true, false, or a callable (obj -> obj)');
}

/** The built-in scrubber (Python's `_redact`), exported for conformance vectors. */
export function _redact(obj: unknown): unknown {
  return builtinRedact(obj);
}

// --------------------------------------------------------------------------- serialization

function pyStrKey(k: unknown): string {
  if (typeof k === 'string') return k;
  if (typeof k === 'boolean') return k ? 'True' : 'False';
  if (k === null || k === undefined) return 'None';
  if (typeof k === 'bigint') return k.toString();
  if (k instanceof PyFloat) return String(k.value);
  if (typeof k === 'number') return Number.isInteger(k) ? String(k) : String(k);
  return String(k);
}

function isPlainObject(obj: object): boolean {
  const proto = Object.getPrototypeOf(obj);
  return proto === Object.prototype || proto === null;
}

/** Coerce any value to a JSON-serializable {@link PyValue}, mirroring Python's `_to_jsonable`:
 * None/bool/number/str pass through; dict-like (plain object / Map) recurses with stringified keys;
 * arrays recurse; SDK-like objects try `model_dump`/`dict`/`to_dict` then own properties; else str. */
function toJsonable(obj: unknown): PyValue {
  if (obj === null || obj === undefined) return null;
  const t = typeof obj;
  if (t === 'boolean' || t === 'string' || t === 'number' || t === 'bigint') return obj as PyValue;
  if (obj instanceof PyFloat) return obj;
  if (Array.isArray(obj)) return obj.map(toJsonable);
  if (obj instanceof Map) {
    const o: Record<string, PyValue> = {};
    for (const [k, v] of obj) o[pyStrKey(k)] = toJsonable(v);
    return o;
  }
  if (t === 'object') {
    // dict-like (plain object) — keys already strings, recurse values (Python's `dict` branch).
    if (isPlainObject(obj as object)) {
      const o: Record<string, PyValue> = {};
      for (const [k, v] of Object.entries(obj)) o[k] = toJsonable(v);
      return o;
    }
    // SDK-like object: try dump methods in order, swallowing failures, then own enumerable props.
    for (const attr of ['model_dump', 'dict', 'to_dict']) {
      const method = (obj as Record<string, unknown>)[attr];
      if (typeof method === 'function') {
        try {
          return toJsonable((method as () => unknown).call(obj));
        } catch {
          // best-effort serialization; fall through to the next candidate
        }
      }
    }
    const o: Record<string, PyValue> = {};
    for (const [k, v] of Object.entries(obj)) o[k] = toJsonable(v);
    return o;
  }
  return pyStr(obj);
}

function pyStr(obj: unknown): string {
  return String(obj);
}

/** Convert a parsed {@link PyValue} back into plain JS (bigint/PyFloat -> number) for hand-off to
 * the caller on replay. In JS a plain object is both attribute- and index-accessible, so the
 * `object`/`mapping` reconstruction distinction is a no-op (JS3 brief rule 4); the marker is still
 * recorded for fidelity. */
function fromPyValue(v: PyValue): unknown {
  if (v === null) return null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof PyFloat) return v.value;
  if (Array.isArray(v)) return v.map(fromPyValue);
  if (typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) o[k] = fromPyValue(val);
    return o;
  }
  return v;
}

/** `"mapping"` if the raw response is dict-like (plain object / Map), else `"object"` (SDK object,
 * array/stream, primitive). Inspected on the **raw** object before coercion. */
function responseMarker(raw: unknown): string {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw instanceof Map) return 'mapping';
    if (isPlainObject(raw)) return 'mapping';
  }
  return 'object';
}

// --------------------------------------------------------------------------- hashing

/** Canonicalize tool arguments to the `{args, kwargs}` shape core's tool wrapper produces live, so a
 * promoted/hand-written trace hashes identically to the live call. */
function canonicalToolArguments(args: unknown): PyValue {
  if (
    args !== null &&
    typeof args === 'object' &&
    !Array.isArray(args) &&
    !(args instanceof PyFloat)
  ) {
    const rec = args as Record<string, unknown>;
    if ('args' in rec || 'kwargs' in rec) {
      return {
        args: toJsonable('args' in rec ? rec.args : []),
        kwargs: toJsonable('kwargs' in rec ? rec.kwargs : {}),
      };
    }
    return { args: [], kwargs: toJsonable(rec) };
  }
  if (Array.isArray(args)) return { args: toJsonable(args), kwargs: {} };
  return { args: [toJsonable(args)], kwargs: {} };
}

/** A pluggable `event -> request-dict` that owns the whole matching key. */
export type Normalizer = (event: unknown) => PyValue;

/** Build the normalized request that the hash is taken over. Un-redacted and jsonable so hashing
 * never trips on SDK objects. `includeStream` is v2 behavior (v1 omits `stream`). */
export function _normalizedRequest(event: unknown, includeStream = true): PyValue {
  if (event instanceof LLMCall) {
    const req: Record<string, PyValue> = {
      kind: 'llm',
      provider: event.provider,
      model: event.model,
      messages: toJsonable(event.messages),
    };
    if (includeStream) {
      const kwargs = (event.metadata?.request_kwargs as Record<string, unknown> | undefined) ?? {};
      req.stream = Boolean(kwargs.stream);
    }
    return req;
  }
  if (event instanceof ToolCall) {
    return {
      kind: 'tool',
      name: event.name,
      arguments: canonicalToolArguments(event.arguments),
    };
  }
  // Non LLM/Tool events are filtered before norm() is ever called (record/replay both guard).
  throw new CassetteError('cannot normalize a non-LLM/Tool event');
}

/** `sha256Hex(canonical(request))` — the exact bytes Python hashes. */
export function _hash(request: PyValue): string {
  return sha256Hex(canonical(request));
}

function defaultNormalizer(version: number): Normalizer {
  return (event) => _normalizedRequest(event, version >= 2);
}

// --------------------------------------------------------------------------- load / validate

interface Loaded {
  version: number;
  entries: Array<Record<string, PyValue>>;
}

function loadCassette(storage: CassetteStorage, name: string): Loaded {
  const text = storage.read();
  if (text === null) {
    throw new CassetteError(`cannot read cassette ${name}: not found`);
  }
  let payload: PyValue;
  try {
    payload = parsePreserving(text);
  } catch (e) {
    throw new CassetteError(`cannot read cassette ${name}: ${(e as Error).message}`);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CassetteError(`cannot read cassette ${name}: not a cassette object`);
  }
  const obj = payload as Record<string, PyValue>;
  const version = 'version' in obj ? Number(obj.version) : 1;
  if (version !== 1 && version !== 2) {
    throw new CassetteError(
      `unsupported cassette format version ${version} in ${name}; this cendor-cassette supports ` +
        `versions (${SUPPORTED_VERSIONS.join(', ')}) — upgrade the package or re-record the cassette`,
    );
  }
  const rawEntries = obj.entries;
  const entries = Array.isArray(rawEntries) ? (rawEntries as Array<Record<string, PyValue>>) : [];
  return { version, entries };
}

function buildByHash(
  entries: Array<Record<string, PyValue>>,
): Map<string, Array<Record<string, PyValue>>> {
  const byHash = new Map<string, Array<Record<string, PyValue>>>();
  for (const entry of entries) {
    const h = String(entry.request_hash);
    const bucket = byHash.get(h);
    if (bucket) bucket.push(entry);
    else byHash.set(h, [entry]);
  }
  return byHash;
}

// --------------------------------------------------------------------------- record / replay / rerecord

async function recording<T>(
  storage: CassetteStorage,
  normalizer: Normalizer | null,
  redactor: Redactor,
  body: () => T | Promise<T>,
): Promise<T> {
  const norm = normalizer ?? ((event: unknown) => _normalizedRequest(event, true));
  const entries: CassetteEntry[] = [];
  const session = uuidHex();

  const recorder = (event: unknown): void => {
    if (activeSession.getStore() !== session) return;
    let response: PyValue;
    let marker: string;
    let kind: string;
    if (event instanceof LLMCall) {
      const raw = event.metadata.response;
      response = redactor(toJsonable(raw)) as PyValue;
      marker = responseMarker(raw);
      kind = 'llm';
    } else if (event instanceof ToolCall) {
      response = redactor(toJsonable(event.result)) as PyValue;
      marker = responseMarker(event.result);
      kind = 'tool';
    } else {
      return;
    }
    const request = norm(event); // un-redacted: this is the matching key
    entries.push(
      new CassetteEntry(
        entries.length,
        kind,
        _hash(request),
        redactor(request) as PyValue,
        response,
        marker,
      ),
    );
  };

  bus.subscribe(recorder);
  try {
    return await activeSession.run(session, body);
  } finally {
    bus.unsubscribe(recorder);
    const payload = { version: FORMAT_VERSION, entries: entries.map(entryToJson) };
    storage.write(dumpsIndent2(payload));
  }
}

async function replaying<T>(
  storage: CassetteStorage,
  normalizer: Normalizer | null,
  name: string,
  body: () => T | Promise<T>,
): Promise<T> {
  const { version, entries } = loadCassette(storage, name);
  const norm = normalizer ?? defaultNormalizer(version);
  const byHash = buildByHash(entries);
  const cursor = new Map<string, number>(); // per-replay context, keyed by hash
  const session = uuidHex();

  const interceptor = (event: unknown): unknown => {
    if (activeSession.getStore() !== session) return MISS; // another replay context — decline
    const request = norm(event);
    const h = _hash(request);
    const queue = byHash.get(h) ?? [];
    const i = cursor.get(h) ?? 0;
    if (i >= queue.length) {
      const kind =
        request !== null && typeof request === 'object' && !Array.isArray(request)
          ? (request as Record<string, PyValue>).kind
          : undefined;
      throw new CassetteError(
        `no recorded response for ${String(kind)} request (hash ${h.slice(0, 12)}…) in ${name}; re-record the cassette`,
      );
    }
    cursor.set(h, i + 1); // FIFO per hash
    const entry = queue[i] as Record<string, PyValue>;
    // In JS a plain object is both attribute- and index-accessible, so LLM ("object"/"mapping") and
    // tool responses all reconstruct to the same deep plain value (JS3 brief rule 4).
    return fromPyValue(entry.response ?? null);
  };

  addInterceptor(interceptor);
  try {
    return await activeSession.run(session, body);
  } finally {
    removeInterceptor(interceptor);
  }
}

async function rerecording<T>(
  storage: CassetteStorage,
  normalizer: Normalizer | null,
  redactor: Redactor,
  name: string,
  body: () => T | Promise<T>,
): Promise<T> {
  _drift.length = 0;
  const loaded = storage.exists()
    ? loadCassette(storage, name)
    : { version: FORMAT_VERSION, entries: [] as Array<Record<string, PyValue>> };
  const norm = normalizer ?? defaultNormalizer(loaded.version);
  const byHash = buildByHash(loaded.entries);
  const cursor = new Map<string, number>();
  const session = uuidHex();

  const recorder = (event: unknown): void => {
    if (activeSession.getStore() !== session) return;
    let live: PyValue;
    let kind: string;
    if (event instanceof LLMCall) {
      live = redactor(toJsonable(event.metadata.response)) as PyValue;
      kind = 'llm';
    } else if (event instanceof ToolCall) {
      live = redactor(toJsonable(event.result)) as PyValue;
      kind = 'tool';
    } else {
      return;
    }
    const h = _hash(norm(event));
    const queue = byHash.get(h) ?? [];
    const i = cursor.get(h) ?? 0;
    cursor.set(h, i + 1);
    const recorded =
      i < queue.length ? fromPyValue((queue[i] as Record<string, PyValue>).response ?? null) : null;
    const livePlain = fromPyValue(live);
    if (!deepEqual(recorded, livePlain)) {
      _drift.push({ request_hash: h, kind, recorded, live: livePlain });
    }
  };

  bus.subscribe(recorder);
  try {
    return await activeSession.run(session, body);
  } finally {
    bus.unsubscribe(recorder);
    // rerecord never overwrites the cassette.
  }
}

/** Structural deep-equal on jsonable values (Python's `!=` on the coerced structures). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.hasOwn(b as object, k)) return false;
      if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

// --------------------------------------------------------------------------- public managers

/** Modes: `auto` (record if the cassette is missing, else replay), `record`, `replay`, `rerecord`. */
export type Mode = 'auto' | 'record' | 'replay' | 'rerecord';

export interface UseOptions {
  mode?: Mode;
  normalizer?: Normalizer | null;
  redact?: Redact;
}

function targetName(target: string | CassetteStorage): string {
  return typeof target === 'string' ? target.replace(/^.*[\\/]/, '') : 'cassette';
}

async function runManaged<T>(
  target: string | CassetteStorage,
  options: UseOptions,
  body: () => T | Promise<T>,
): Promise<T> {
  const storage = resolveStorage(target);
  const name = targetName(target);
  const mode = options.mode ?? 'auto';
  let effective: Mode = mode;
  if (mode === 'auto') effective = storage.exists() ? 'replay' : 'record';
  const normalizer = options.normalizer ?? null;
  if (effective === 'replay') return replaying(storage, normalizer, name, body);
  if (effective === 'rerecord') {
    return rerecording(storage, normalizer, resolveRedactor(options.redact ?? true), name, body);
  }
  return recording(storage, normalizer, resolveRedactor(options.redact ?? true), body);
}

/**
 * Context-manager form (async-callback scope): record/replay everything the `body` does. A second
 * overload takes `{ mode: 'record' | 'replay' | 'rerecord' | 'auto' }` between the target and body.
 *
 * @example
 * ```ts
 * import * as cassette from '@cendor/cassette';
 * await cassette.using('tests/x.json', async () => {
 *   await client.chat.completions.create({ model, messages });   // recorded once, replayed offline
 * });
 * ```
 */
export function using<T>(target: string | CassetteStorage, body: () => T | Promise<T>): Promise<T>;
export function using<T>(
  target: string | CassetteStorage,
  options: UseOptions,
  body: () => T | Promise<T>,
): Promise<T>;
export function using<T>(
  target: string | CassetteStorage,
  optionsOrBody: UseOptions | (() => T | Promise<T>),
  maybeBody?: () => T | Promise<T>,
): Promise<T> {
  const options = typeof optionsOrBody === 'function' ? {} : optionsOrBody;
  const body = typeof optionsOrBody === 'function' ? optionsOrBody : maybeBody;
  if (typeof body !== 'function') throw new TypeError('using() requires a body callback');
  return runManaged(target, options, body);
}

/**
 * Decorator form: record the wrapped run on first use, replay it thereafter. The returned wrapper
 * is async (the instrumented client calls are async in TS).
 *
 * @example
 * ```ts
 * import { use } from '@cendor/cassette';
 * const runAgent = use('run.json')(async () => respond('hi'));
 * await runAgent();   // records the first run, replays after
 * ```
 */
export function use(
  target: string | CassetteStorage,
  options: UseOptions = {},
): <A extends unknown[], R>(fn: (...args: A) => R | Promise<R>) => (...args: A) => Promise<R> {
  return <A extends unknown[], R>(fn: (...args: A) => R | Promise<R>) =>
    (...args: A): Promise<R> =>
      runManaged(target, options, () => fn(...args));
}

// --------------------------------------------------------------------------- promote

/** Build the same un-redacted normalized request `_normalizedRequest` derives live — including the
 * v2 `stream` flag and the canonical `{args, kwargs}` tool shape. */
function normalizedRequestFrom(kind: string, request: Record<string, PyValue>): PyValue {
  if (kind === 'llm') {
    return {
      kind: 'llm',
      provider: 'provider' in request ? request.provider : null,
      model: 'model' in request ? request.model : null,
      messages: toJsonable('messages' in request ? request.messages : []),
      stream: pyTruthy('stream' in request ? request.stream : false),
    };
  }
  return {
    kind: 'tool',
    name: 'name' in request ? request.name : null,
    arguments: canonicalToolArguments('arguments' in request ? request.arguments : {}),
  };
}

function pyTruthy(v: PyValue): boolean {
  if (v === null || v === false) return false;
  if (typeof v === 'bigint') return v !== 0n;
  if (v instanceof PyFloat) return v.value !== 0;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

/**
 * Convert a JSONL call trace into a replayable cassette. Each line is
 * `{kind: 'llm'|'tool', request: {...}, response|result: ...}`; `_meta` and unrecognized lines are
 * skipped. Returns the number of entries written. Always writes v2; `response_type` is `"object"`
 * for every promoted entry (a promote asymmetry vs. live recording — parity with Python).
 *
 * @example
 * ```ts
 * import { promote } from '@cendor/cassette';
 * const n = promote('trace.jsonl', 'tests/run.json');   // JSONL call trace -> replayable cassette
 * ```
 */
export function promote(tracePath: string, to: string, redact: Redact = true): number {
  const redactor = resolveRedactor(redact);
  const src = resolveStorage(tracePath);
  const text = src.read();
  const entries: CassetteEntry[] = [];
  if (text !== null) {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      let row: PyValue;
      try {
        row = parsePreserving(line);
      } catch {
        continue;
      }
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
      const obj = row as Record<string, PyValue>;
      if ('_meta' in obj) continue;
      const kind = obj.kind;
      const request = 'request' in obj ? obj.request : undefined;
      if (
        (kind !== 'llm' && kind !== 'tool') ||
        request === null ||
        request === undefined ||
        typeof request !== 'object' ||
        Array.isArray(request)
      ) {
        continue;
      }
      let response: PyValue;
      if ('response' in obj) response = obj.response;
      else if ('result' in obj) response = obj.result;
      else response = null;
      const norm = normalizedRequestFrom(kind, request as Record<string, PyValue>);
      entries.push(
        new CassetteEntry(
          entries.length,
          kind,
          _hash(norm),
          redactor(norm) as PyValue,
          redactor(response) as PyValue,
        ),
      );
    }
  }
  const payload = { version: FORMAT_VERSION, entries: entries.map(entryToJson) };
  resolveStorage(to).write(dumpsIndent2(payload));
  return entries.length;
}

// --------------------------------------------------------------------------- drift

/** Divergences from the most recent `rerecord` run (a copy). */
export function drift(): Array<Record<string, unknown>> {
  return [..._drift];
}

/** Filter the last `rerecord` run's byte-level {@link drift} to *meaningful* divergences: keep only
 * those scoring **below** `threshold` (strict `<`), attaching the `score`. */
export function semanticDrift(
  threshold = 0.8,
  scorer?: (actual: string, expected: string) => number,
): Array<Record<string, unknown>> {
  const scoreFn = scorer ?? lexicalScore;
  const out: Array<Record<string, unknown>> = [];
  for (const d of _drift) {
    const score = scoreFn(driftText(d.recorded), driftText(d.live));
    if (score < threshold) out.push({ ...d, score });
  }
  return out;
}

function driftText(obj: unknown): string {
  if (obj === null || obj === undefined) return '';
  if (typeof obj === 'string') return obj;
  // Python: json.dumps(_to_jsonable(obj), sort_keys=True, ensure_ascii=False) — DEFAULT separators.
  return dumpsSortedDefault(toJsonable(obj));
}

/** `json.dumps(sort_keys=True, ensure_ascii=False)` — sorted keys, `", "`/`": "` separators. Used
 * only to build the text fed to the scorer (never serialized to disk). */
function dumpsSortedDefault(v: PyValue): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof PyFloat) return String(v.value);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (Array.isArray(v)) return `[${v.map(dumpsSortedDefault).join(', ')}]`;
  const keys = Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}: ${dumpsSortedDefault(v[k] as PyValue)}`).join(', ')}}`;
}

// --------------------------------------------------------------------------- semantic match

const WORD = /[a-z0-9']+/g;

function normText(text: string): string {
  const matches = text.toLowerCase().match(WORD);
  return matches ? matches.join(' ') : '';
}

/** The default offline similarity score in [0, 1]: max(sequence ratio, keyword containment). */
export function lexicalScore(actual: string, expected: string): number {
  const a = normText(actual);
  const e = normText(expected);
  if (!e) return 1.0;
  const ratio = sequenceRatio(a, e);
  const aTokens = new Set(a.split(' ').filter(Boolean));
  const eTokens = new Set(e.split(' ').filter(Boolean));
  let shared = 0;
  for (const tok of eTokens) if (aTokens.has(tok)) shared++;
  const containment = eTokens.size > 0 ? shared / eTokens.size : 1.0;
  return Math.max(ratio, containment);
}

/** Ratcliff/Obershelp similarity `2*M/T` (difflib `SequenceMatcher.ratio()`). Behavioral parity for
 * `semanticMatch` only — never serialized, so byte-exact difflib autojunk parity is not required. */
function sequenceRatio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 1.0;
  return (2 * matchingBlocks(a, b)) / total;
}

function matchingBlocks(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  // Longest common contiguous substring, then recurse on the left and right remainders.
  let bestI = 0;
  let bestJ = 0;
  let bestLen = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const curr = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        const len = (prev[j - 1] as number) + 1;
        curr[j] = len;
        if (len > bestLen) {
          bestLen = len;
          bestI = i - len;
          bestJ = j - len;
        }
      }
    }
    prev = curr;
  }
  if (bestLen === 0) return 0;
  return (
    bestLen +
    matchingBlocks(a.slice(0, bestI), b.slice(0, bestJ)) +
    matchingBlocks(a.slice(bestI + bestLen), b.slice(bestJ + bestLen))
  );
}

/**
 * Assert `actual` means roughly `expected`. Lexical default (offline, deterministic). Inclusive
 * `>=` against `threshold`.
 *
 * @example
 * ```ts
 * import * as cassette from '@cendor/cassette';
 * const out = 'this line explains the charge on your invoice';
 * expect(cassette.semanticMatch(out, 'explains the charge')).toBe(true);
 * ```
 */
export function semanticMatch(
  actual: string,
  expected: string,
  threshold = 0.6,
  scorer?: (actual: string, expected: string) => number,
): boolean {
  const score = (scorer ?? lexicalScore)(actual, expected);
  return score >= threshold;
}

// --------------------------------------------------------------------------- embedding scorers

/** Cosine similarity of two equal-length vectors, in [-1, 1] (0 for empty/degenerate input). */
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0.0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  na = Math.sqrt(na);
  nb = Math.sqrt(nb);
  if (na === 0.0 || nb === 0.0) return 0.0;
  return dot / (na * nb);
}

/** Build a {@link semanticMatch} scorer from any embedder — the bring-your-own-model path. */
export function embeddingScorer(
  embedFn: (texts: string[]) => number[][],
): (actual: string, expected: string) => number {
  return (actual: string, expected: string): number => {
    const vecs = embedFn([actual, expected]);
    if (!vecs || vecs.length < 2) return 0.0;
    return Math.max(0.0, cosine([...(vecs[0] as number[])], [...(vecs[1] as number[])]));
  };
}

/**
 * **Python-only — not implemented in JS; always throws.** Python's `local_embedding_scorer` is
 * backed by model2vec static embeddings, for which there is no maintained pure-JS package. This
 * symbol exists only so the name is discoverable and the failure is a clear, immediate error rather
 * than a missing export; it is **not** a working scorer. In TS, wire your own embedder via
 * {@link embeddingScorer} (or {@link openaiEmbeddingScorer}). See the parity matrix.
 *
 * @throws {Error} always — pass an `embedFn` to {@link embeddingScorer} instead.
 */
export function localEmbeddingScorer(_model = 'minishlab/potion-base-8M'): never {
  throw new Error(
    'localEmbeddingScorer needs a static-embedding model that is not bundled in JS. ' +
      'Pass your own embedFn to embeddingScorer() (e.g. wrapping a local or hosted model).',
  );
}

/** An embedding scorer over an already-constructed OpenAI-shaped `client` (no SDK import). */
export function openaiEmbeddingScorer(
  client: {
    embeddings: {
      create: (opts: { model: string; input: string[] }) => {
        data: Array<{ embedding: number[] }>;
      };
    };
  },
  model = 'text-embedding-3-small',
): (actual: string, expected: string) => number {
  const embedFn = (texts: string[]): number[][] => {
    const resp = client.embeddings.create({ model, input: [...texts] });
    return resp.data.map((item) => [...item.embedding]);
  };
  return embeddingScorer(embedFn);
}
