/**
 * Single interception point: wrap a provider client (or tool) once; emit normalized events. The TS
 * mirror of `cendor.core.instrument`, scoped in this port to the OpenAI (Chat Completions + Responses)
 * and Anthropic JS SDKs — the fetch-based clients. Detection is structural (the SDKs are never
 * imported, so they stay optional peer deps). Idempotent, async-first, and streaming-aware.
 *
 * Two cooperation hooks (used by `@cendor/cassette`; harmless otherwise):
 *   - **record** — the raw provider response is attached at `call.metadata.response` before emit.
 *   - **replay** — registered interceptors run *before* the real call; one may return a response to
 *     short-circuit it (returning {@link MISS} to decline).
 */
import { applyAmbient } from './ambient.js';
import { emit } from './bus.js';
import { Dec } from './decimal.js';
// otel.ts imports `streamText` from here, so this is a cycle by construction — safe because both
// sides only use the other's exports at call time (function declarations, hoisted), never during
// module evaluation. Mirrors the Python side's deferred import inside `instrument()`.
import { _armAutoTelemetry } from './otel.js';
import { estimate } from './prices.js';
import { count as countTokens } from './tokens.js';
import { currentTraceId } from './trace.js';
import { LLMCall, type Message, Money, ToolCall, Usage } from './types.js';

const WRAPPED = Symbol.for('cendor.wrapped');

/** Sentinel an interceptor returns to decline a call (let it proceed normally). */
export const MISS: unique symbol = Symbol.for('cendor.MISS');
export type Miss = typeof MISS;

/** Returned by an interceptor to modify the outgoing request, then run the real call. */
export class Reroute {
  readonly updates: Record<string, unknown>;
  constructor(updates: Record<string, unknown>) {
    this.updates = updates;
  }
}

type Interceptor = (event: unknown) => unknown;
const interceptors: Interceptor[] = [];

/**
 * Register a pre-call interceptor. Returns a response to short-circuit, or {@link MISS} to proceed.
 * Top-level on `@cendor/core` — **not** on `bus` (`bus` only has `subscribe`/`unsubscribe`/`emit`).
 * Return a {@link Reroute} to rewrite the outgoing request before it is sent.
 *
 * @example
 * ```ts
 * import { addInterceptor, MISS } from '@cendor/core';
 * addInterceptor((call) => MISS);   // inspect every call; MISS lets it proceed unchanged
 * ```
 */
export function addInterceptor(fn: Interceptor): Interceptor {
  if (!interceptors.includes(fn)) interceptors.push(fn);
  return fn;
}

/** Unregister a previously added interceptor (no error if absent). */
export function removeInterceptor(fn: Interceptor): void {
  const i = interceptors.indexOf(fn);
  if (i >= 0) interceptors.splice(i, 1);
}

/**
 * Run the interceptor chain for one outgoing call.
 *
 * **Ordering contract (`@cendor/core` 3.3.0).** Two things an interceptor can return end the chain
 * differently, because they mean different things:
 *
 * - a **response** (`@cendor/cassette`'s replay) genuinely short-circuits: the provider is never
 *   called, so there is nothing left for a later interceptor to rewrite. The chain stops.
 * - a {@link Reroute} does **not**. The call still goes to the provider, so every remaining
 *   interceptor is still consulted — against the **rerouted** call, so it sees the request as it will
 *   actually be sent.
 *
 * Before 3.3.0 a `Reroute` also stopped the chain, and what you lost was silent and in the dangerous
 * direction (measured — `plan/evidence-gapclose-2026-07-31/s6_probe_interceptor_chain.py`): with a
 * tokenguard clamp registered before an `acttrace.guard()`, the clamp fired and the PII went to the
 * provider **unredacted**; the other way round, the guard fired and the token cap **silently never
 * bound**. Which one you lost depended on registration order, which a user cannot see.
 *
 * Reroutes compose in registration order and are applied as they arrive, so the second interceptor's
 * view of `call.messages` / `call.model` is the first one's output; when two rewrite the same field,
 * the later wins. `kwargs` is `undefined` on the tool path — a `ToolCall` has no provider request to
 * rewrite, so a `Reroute` there keeps its old short-circuit meaning rather than being silently dropped.
 */
function intercept(event: unknown, kwargs?: Record<string, unknown>, provider = ''): unknown {
  const snapshot = [...interceptors];
  for (const fn of snapshot) {
    const result = fn(event);
    if (result === MISS) continue;
    if (result instanceof Reroute) {
      if (kwargs === undefined) return result; // tool path: no request to rewrite (see above)
      applyReroute(event as LLMCall, kwargs, result, provider);
      continue;
    }
    return result; // a recorded response — the provider is not called at all
  }
  // Any reroutes are already applied to `kwargs`, so the caller simply makes the real call. Returning
  // MISS (rather than a combined Reroute) keeps the wrapper single-pathed, and
  // `call.metadata.rerouted` still records that it happened.
  return MISS;
}

// --------------------------------------------------------------------------- stream observers

/** A per-chunk stream observer, called `fn(call, deltaText, deltaThinking)` for every streamed
 * chunk. **Throwing aborts the stream** (interceptor discipline). */
export type StreamObserver = (call: LLMCall, deltaText: string, deltaThinking: string) => void;
const streamObservers: StreamObserver[] = [];

/**
 * Register a per-chunk stream observer, called `fn(call, deltaText, deltaThinking)` for every chunk
 * of every instrumented stream. **Throwing aborts the stream** (interceptor discipline): the
 * underlying provider stream is closed, the `LLMCall` is finalized once with the partial (estimated)
 * usage, and the error propagates to the consumer's `for await`. Idempotent.
 *
 * This is the generic core seam `@cendor/tokenguard`'s mid-stream budget breaker
 * (`budget({ onExceed: 'break' })`) registers on; core itself learns no budget vocabulary (mirrors
 * the ambient-provider discipline). `deltaText` is the visible text of this chunk; `deltaThinking`
 * is any *visible* reasoning/thinking text (Anthropic `thinking_delta`, Ollama `message.thinking`,
 * OpenAI-compat `reasoning_content`, Bedrock `reasoningContent`) — both extracted by core so an
 * observer never parses a provider shape. Zero observers ⇒ one length check per chunk (hot path
 * untouched when nothing is armed).
 *
 * @example
 * ```ts
 * import { addStreamObserver } from '@cendor/core';
 * addStreamObserver((call, text, thinking) => {}); // inert; a throwing observer cuts the stream
 * ```
 */
export function addStreamObserver(fn: StreamObserver): StreamObserver {
  if (!streamObservers.includes(fn)) streamObservers.push(fn);
  return fn;
}

/** Unregister a previously added stream observer (no error if absent). */
export function removeStreamObserver(fn: StreamObserver): void {
  const i = streamObservers.indexOf(fn);
  if (i >= 0) streamObservers.splice(i, 1);
}

function uuidHex(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '');
}

function get(obj: unknown, name: string, dflt: unknown = null): unknown {
  if (obj == null || typeof obj !== 'object') return dflt;
  const v = (obj as Record<string, unknown>)[name];
  return v === undefined ? dflt : v;
}

function toInt(x: unknown): number {
  return Math.trunc(Number(x));
}

// --------------------------------------------------------------------------- detection

type Target = [owner: Record<string, unknown>, attr: string, provider: string];

function findTargets(client: unknown): Target[] {
  if (client == null || typeof client !== 'object') return [];
  const c = client as Record<string, unknown>;
  // Hugging Face InferenceClient exposes chatCompletion(...) on the client itself (it also has an
  // OpenAI-compatible chat.completions.create). Bind chatCompletion FIRST — before the OpenAI check
  // matches that compat namespace — so the LLMCall is attributed to "huggingface". The response is
  // OpenAI-shaped, so usage/parse/stream reuse the OpenAI path. (JS SDK method is camelCase.)
  if (typeof c.chatCompletion === 'function') return [[c, 'chatCompletion', 'huggingface']];
  const targets: Target[] = [];
  const chat = c.chat as Record<string, unknown> | undefined;
  const completions = chat?.completions as Record<string, unknown> | undefined;
  if (completions && typeof completions.create === 'function') {
    targets.push([completions, 'create', 'openai']);
  }
  const responses = c.responses as Record<string, unknown> | undefined;
  if (responses && typeof responses.create === 'function') {
    targets.push([responses, 'create', 'openai_responses']);
  }
  // `responses.parse` / `chat.completions.parse` are deliberately NOT targets here, and that is
  // parity of *behaviour* with Python rather than of mechanism. In **openai-node** they are helper
  // methods built on `create` (`resources/responses/responses.js`,
  // `resources/chat/completions/completions.js` — both `this._client…create(...)._thenUnwrap(...)`),
  // so the wrapped `create` already captures them, exactly once; adding a second target would
  // double-count the same request. In **Python** the same names POST their own request and
  // therefore do need their own targets (`cendor-core` 1.14.1 / 1.14.2). What these helpers *do*
  // need is for the SDK's own parse step to survive instrumentation — see `memoizeParseResponse`.
  // OpenAI-shaped embeddings endpoint (OpenAI + Azure-via-openai). Wrapping it closes the
  // embeddings capture gap: pre-flight interceptors (budget block/clamp, guard redaction) run, and
  // the emitted LLMCall carries metadata.embedding = true.
  const embeddings = c.embeddings as Record<string, unknown> | undefined;
  if (embeddings && typeof embeddings.create === 'function') {
    targets.push([embeddings, 'create', 'openai_embeddings']);
  }
  if (targets.length > 0) return targets;
  const messages = c.messages as Record<string, unknown> | undefined;
  if (messages && typeof messages.create === 'function') {
    return [[messages, 'create', 'anthropic']];
  }
  // AWS Bedrock Converse, boto-shaped: a client that exposes `converse()` directly (boto3 via a
  // bridge, a hand-written shim, or `@cendor/sdk`'s synthetic wrapper).
  if (typeof c.converse === 'function') {
    const bedrock: Target[] = [[c, 'converse', 'bedrock']];
    // A boto-shaped client also exposes converse_stream: no `stream` flag, and the iterable arrives
    // as the `stream` member of the response object — an always-stream target. Mirrors the Python
    // detection.
    if (typeof c.converse_stream === 'function') {
      bedrock.push([c, 'converse_stream', 'bedrock_stream']);
    }
    return bedrock;
  }
  // AWS Bedrock Converse, **aws-sdk-v3**: every call is `send(new ConverseCommand({...}))`. `send` is
  // shared by every AWS command, so it cannot carry a provider tag on its own — the CLIENT is
  // identified here and the COMMAND is identified per call (see {@link wrapAwsSend}). Until this
  // existed, libs-only TypeScript Bedrock got **zero** capture: no budget, no guard, no audit, no
  // cassette, measured at 0 LLMCalls, and cendor-testsuits recorded it every run as "the most
  // surprising capture gap in the JS port".
  //
  // Identified by `config.serviceId === 'Bedrock Runtime'` — measured on
  // @aws-sdk/client-bedrock-runtime 3.1100.0 to be a plain, synchronously-readable string (most of
  // that config is async resolvers, this one is not), with the constructor name as a fallback. It is
  // deliberately precise rather than "any smithy client": an S3 or DynamoDB client stays genuinely
  // untouched, which is the documented `instrument()` contract, instead of being wrapped-but-
  // pass-through.
  if (typeof c.send === 'function' && isBedrockRuntimeClient(c)) {
    return [[c, 'send', 'bedrock_send']];
  }
  // Legacy @google/generative-ai: `model.generateContent(...)` with the model id bound to the object
  // (read as modelDefault in instrument()).
  if (typeof c.generateContent === 'function') return [[c, 'generateContent', 'google']];
  // @google/genai SDK: sync `client.models.generateContent` + (parity) async
  // `client.aio?.models?.generateContent`. In the JS SDK there is only one async surface (no `aio`),
  // but the `aio` probe is harmless and keeps parity with the Python detection.
  // The SDK streams through a *separate method* (`generateContentStream`) rather than a
  // `stream: true` kwarg, so it needs its own always-stream target — without one a streamed Gemini
  // call emitted nothing at all (measured live 2026-07-31: zero LLMCalls, both languages).
  const google: Target[] = [];
  const models = c.models as Record<string, unknown> | undefined;
  if (models && typeof models.generateContent === 'function') {
    google.push([models, 'generateContent', 'google']);
  }
  if (models && typeof models.generateContentStream === 'function') {
    google.push([models, 'generateContentStream', 'google_stream']);
  }
  const aio = c.aio as Record<string, unknown> | undefined;
  const aioModels = aio?.models as Record<string, unknown> | undefined;
  if (aioModels && typeof aioModels.generateContent === 'function') {
    google.push([aioModels, 'generateContent', 'google']);
  }
  if (aioModels && typeof aioModels.generateContentStream === 'function') {
    google.push([aioModels, 'generateContentStream', 'google_stream']);
  }
  if (google.length > 0) return google;
  // Ollama: `client.chat(...)` is itself callable (vs OpenAI's `chat` namespace). Checked LAST.
  if (typeof c.chat === 'function') return [[c, 'chat', 'ollama']];
  return [];
}

/**
 * Whether `c` is an aws-sdk-v3 **Bedrock Runtime** client (not S3, not DynamoDB).
 *
 * `config.serviceId` is the primary signal because it survives subclassing and bundler mangling;
 * the constructor name is the fallback for a config that never resolved one.
 */
function isBedrockRuntimeClient(c: Record<string, unknown>): boolean {
  if (get(c.config, 'serviceId') === 'Bedrock Runtime') return true;
  return (c as { constructor?: { name?: string } }).constructor?.name === 'BedrockRuntimeClient';
}

/**
 * aws-sdk-v3 command class name → the internal provider tag its request shape belongs to.
 *
 * Only the Converse family is captured. `InvokeModelCommand` is deliberately absent: its request and
 * response bodies are opaque provider-specific JSON blobs (a different shape per model family), so
 * there is nothing core could read as messages or usage without guessing — and a confidently wrong
 * token count is worse than an honest gap. Everything not in this table passes through untouched.
 */
const AWS_COMMAND_PROVIDER: Record<string, string> = {
  ConverseCommand: 'bedrock',
  ConverseStreamCommand: 'bedrock_stream',
};

/**
 * Depth of instrumented calls currently in their **synchronous** prologue.
 *
 * `@cendor/sdk`'s Bedrock provider wraps a v3 client in a synthetic `converse(input)` that calls
 * `client.send(new ConverseCommand(input))`. Once core can capture `send` too, a client that is
 * instrumented on *both* surfaces would emit two `LLMCall`s — and charge two budgets — for one HTTP
 * request. The outer wrapper is the right accountant (it holds the provider's own call shape), so a
 * nested `send` stands down.
 *
 * A plain counter is correct here, and safer than AsyncLocalStorage: `observe()` increments it,
 * synchronously calls the real function, and decrements in a `finally` — with no `await` in between.
 * JavaScript cannot interleave another task inside that window, so concurrent calls can never see
 * each other's depth. (The org rail against `enterWith` is about *scoped* state that must survive an
 * await; this deliberately must not.)
 *
 * **Honest limit:** it only spans the synchronous prologue. A wrapper that awaited something before
 * reaching `send` would fall outside it and be counted twice; `@cendor/sdk`'s synthetic `converse` is
 * a plain arrow that calls `send` directly, which is what makes this exact.
 */
let syncCallDepth = 0;

const PUBLIC_PROVIDER: Record<string, string> = {
  openai_responses: 'openai',
  openai_embeddings: 'openai',
  bedrock_stream: 'bedrock',
  google_stream: 'google',
};

/** Internal tags whose request shape is Gemini's (`contents`, not `messages`). */
const GOOGLE_TAGS = new Set<string>(['google', 'google_stream']);
function publicProvider(provider: string): string {
  return PUBLIC_PROVIDER[provider] ?? provider;
}

/** Detection tags whose target is *always* streaming (there is no `stream: true` kwarg to key off —
 * the iterable arrives from a dedicated method). Bedrock's `converse_stream` and google-genai's
 * `generateContentStream` are the two. */
const ALWAYS_STREAM = new Set<string>(['bedrock_stream', 'google_stream']);

/** Internal tag → the provider the stream extractors (`streamText`/`streamUsage`) should use for a
 * wrapped stream. `bedrock_stream` reuses the plain `bedrock` branches, `google_stream` the
 * `google` ones. */
const STREAM_PROVIDER: Record<string, string> = {
  bedrock_stream: 'bedrock',
  google_stream: 'google',
};
function streamProvider(provider: string): string {
  return STREAM_PROVIDER[provider] ?? provider;
}

/** Per-provider kwarg carrying request messages (so `Reroute({ messages })` rewrites the right field).
 * Chat Completions / Anthropic / Bedrock / Ollama use `messages`; the Responses API uses `input`;
 * Gemini uses `contents` — but it also needs its own value shape, so `applyReroute` routes `google`
 * through {@link geminiContents} rather than this table. */
const MESSAGES_KWARG: Record<string, string> = {
  openai_responses: 'input',
  google: 'contents',
  google_stream: 'contents',
};

/**
 * Per-provider kwarg carrying the **model**, so `Reroute({ model })` (tokenguard's
 * `onExceed: 'downgrade'`) rewrites the field the provider actually reads. Everyone takes `model`
 * except Bedrock's Converse API, which takes `modelId`.
 *
 * Measured 2026-07-31, and the reason this table exists: without it the rewrite landed on a generic
 * `model` member Converse does not have, so the provider received the ORIGINAL (expensive) model
 * while the `LLMCall` — and with it the budget ledger, the audit chain and every span — recorded the
 * cheap one. The Python twin was worse: real boto3 validates its input members, so it raised
 * `Unknown parameter in input: {'model'}` and never made the call. Either way
 * `onExceed: 'downgrade'` did not downgrade on Bedrock, silently and in the expensive direction.
 */
const MODEL_KWARG: Record<string, string> = {
  bedrock: 'modelId',
  bedrock_stream: 'modelId',
};

/**
 * Wrap a provider client so each call emits an `LLMCall` on the bus. Detection is structural. Unknown
 * clients are returned untouched; wrapping is idempotent and returns the same client object.
 *
 * Wrap the client **once**, at construction — not per request.
 *
 * @example
 * ```ts
 * import { instrument } from '@cendor/core';
 * const client = instrument(new OpenAI());   // every call now emits an LLMCall; sync/async/stream
 * ```
 */
export function instrument<T>(client: T): T {
  // Telemetry (DR-1): adopting a capture path arms the automatic span emitter — it stays dormant until
  // the app's OpenTelemetry provider exists, and does nothing at all when `@opentelemetry/api` isn't
  // installed or `CENDOR_TELEMETRY=off`. Cheap + idempotent; see otel.ts.
  _armAutoTelemetry();
  // Overrides for targets that live on the client itself but can't be patched in place (see below).
  // When any exist we return a thin Proxy serving the wrapped fns; otherwise the client is patched in
  // place and returned unchanged (identity preserved for every normal SDK).
  const overrides = new Map<string | symbol, unknown>();
  for (const [owner, attr, provider] of findTargets(client)) {
    const fn = owner[attr] as ((...args: unknown[]) => unknown) & { [WRAPPED]?: boolean };
    if (fn[WRAPPED]) continue;
    let modelDefault = '';
    if (GOOGLE_TAGS.has(provider)) {
      // The legacy @google/generative-ai GenerativeModel binds the model id to the object (`.model`,
      // e.g. "models/gemini-1.5-pro"), not the call args — read it so the LLMCall carries a real,
      // priceable model id (strip the "models/" prefix). The @google/genai Client has no such field;
      // its model rides the `model` arg instead. (`modelName`/`_modelName` covered for parity.)
      const c = client as Record<string, unknown>;
      const name = (get(c, 'model') ?? get(c, 'modelName') ?? get(c, '_modelName') ?? '') as string;
      modelDefault = String(name).replace(/^models\//, '');
    }
    const bound = fn.bind(owner) as (...args: unknown[]) => Promise<unknown>;
    // `send` resolves its provider per call from the command class, so it gets its own wrapper.
    const wrapped =
      provider === 'bedrock_send' ? wrapAwsSend(bound) : wrap(bound, provider, modelDefault);
    // Patch in place when the property is a writable/configurable own or prototype slot. Some SDKs —
    // notably @huggingface/inference (InferenceClient defines every task method in its constructor via
    // `Object.defineProperty(this, name, { value })`, i.e. non-writable AND non-configurable own
    // properties) — expose a target that no assignment or redefinition can replace. For those we record
    // the wrapper and serve it from a Proxy; every other client keeps in-place patching + identity, and
    // a working client is never crashed by a failed patch.
    const ownsTarget = owner === (client as unknown as Record<string, unknown>);
    const desc = ownsTarget ? Object.getOwnPropertyDescriptor(owner, attr) : undefined;
    if (desc && desc.configurable === false && !('value' in desc && desc.writable)) {
      overrides.set(attr, wrapped);
      continue;
    }
    try {
      owner[attr] = wrapped;
    } catch {
      if (ownsTarget) overrides.set(attr, wrapped);
      // A read-only slot on a sub-object is unexpected; leave it untouched rather than throw.
    }
  }
  if (overrides.size > 0) {
    // A Proxy can't override a non-configurable, non-writable own data property on its *target* (the
    // get trap must return the real value). So proxy over a fresh object carrying the client's
    // prototype — it has none of those frozen own props — and forward every non-overridden read to the
    // real client (binding methods to it). instanceof still works (same prototype).
    const real = client as unknown as Record<string | symbol, unknown>;
    const target = Object.create(Object.getPrototypeOf(real) as object | null);
    return new Proxy(target, {
      get(_t, prop) {
        if (overrides.has(prop)) return overrides.get(prop);
        const v = Reflect.get(real, prop, real);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(real) : v;
      },
      has(_t, prop) {
        return overrides.has(prop) || Reflect.has(real, prop);
      },
    }) as T;
  }
  return client;
}

// --------------------------------------------------------------------------- model clients

function wrap(orig: (...args: unknown[]) => unknown, provider: string, modelDefault = '') {
  // Deliberately NOT an `async` arrow. An async function's return value is always a *native* Promise,
  // which strips whatever the SDK put on its own return: openai-node and anthropic-node hand back an
  // `APIPromise` (a Promise subclass) whose `asResponse()` / `withResponse()` are the documented way
  // to read response headers, and `instrument<T>(client: T): T` keeps the type saying so — it
  // type-checked and threw at runtime. The body below still runs entirely in the caller's synchronous
  // frame, exactly as an async body does up to its first `await`, so pre()/intercept() timing (and
  // with it the ambient stamp) is unchanged. Every exit path returns a promise.
  const wrapper = (...args: unknown[]): unknown => {
    // The JS SDKs mostly take a single options object (`create({...})`); the legacy Gemini surface
    // also accepts a positional string/array (`generateContent("hi")`). Only spread args[0] into
    // `kwargs` when it is a plain options object — otherwise keep the original positional args intact.
    const first = args[0];
    const hasOptions = first != null && typeof first === 'object' && !Array.isArray(first);
    const kwargs: Record<string, unknown> = hasOptions
      ? { ...(first as Record<string, unknown>) }
      : {};
    const rest = args.slice(1);
    const { call, start } = pre(provider, kwargs, args, modelDefault);
    ensureStreamUsageOptions(provider, kwargs);
    const streaming = Boolean(kwargs.stream) || ALWAYS_STREAM.has(provider);
    // `hasOptions` is false for the legacy Gemini positional form (`generateContent("hi")`), whose
    // request must switch to the options-object form once anything rewrote it — otherwise a reroute
    // would be applied to `kwargs` and then not sent.
    const runReal = (): unknown =>
      hasOptions || call.metadata.rerouted ? orig(kwargs, ...rest) : orig(...args);
    // A pre-flight refusal (tokenguard's budget block, acttrace's guard) threw out of an async
    // function before, i.e. it *rejected*. Keep it a rejection now that the wrapper is sync.
    // `intercept` applies any Reroute to `kwargs` itself and keeps running the chain — only a
    // recorded response short-circuits. See its docstring for the ordering contract.
    let directive: unknown;
    try {
      directive = intercept(call, kwargs, provider);
    } catch (err) {
      return Promise.reject(err);
    }
    if (directive !== MISS) {
      call.metadata.replayed = true;
      if (streaming) return Promise.resolve(replayStream(call, directive, provider, start));
      try {
        post(call, directive, provider, start);
      } catch (err) {
        return Promise.reject(err); // a post-flight subscriber block still reaches the caller
      }
      return Promise.resolve(directive);
    }
    return observe(runReal, call, provider, start, streaming);
  };
  (wrapper as { [WRAPPED]?: boolean })[WRAPPED] = true;
  return wrapper;
}

/**
 * Wrap an aws-sdk-v3 client's `send` — the polymorphic entrypoint every AWS command goes through.
 *
 * Deliberately its own function rather than a generalisation of {@link wrap}. `send` differs in three
 * ways that would each need a hook in `wrap`'s per-request hot path: the provider tag is resolved
 * **per call** from the command's class, the request fields live on `command.input` rather than in the
 * call arguments, and a non-Converse command must be handed through completely untouched. Keeping it
 * separate means every other provider's path is byte-for-byte unchanged — worth more here than
 * removing the ~20 duplicated lines.
 */
function wrapAwsSend(orig: (...args: unknown[]) => unknown) {
  const wrapper = (...args: unknown[]): unknown => {
    const command = args[0] as
      | { constructor?: { name?: string }; input?: unknown }
      | null
      | undefined;
    const provider = AWS_COMMAND_PROVIDER[command?.constructor?.name ?? ''];
    const input = command?.input;
    // NEGATIVE-CONTROL PATH, and the reason this wrapper is safe to install on a shared `send`:
    // anything that is not a Converse command with an input object — `InvokeModelCommand`,
    // `ListFoundationModelsCommand`, a future command, a bare object — goes straight through with the
    // original arguments, emitting nothing and allocating nothing. Ditto a `send` reached from inside
    // another instrumented call, which is the same request counted by its outer wrapper.
    if (provider === undefined || input == null || typeof input !== 'object' || syncCallDepth > 0) {
      return orig(...args);
    }
    const kwargs: Record<string, unknown> = { ...(input as Record<string, unknown>) };
    const rest = args.slice(1);
    const { call, start } = pre(provider, kwargs, args, '');
    const streaming = ALWAYS_STREAM.has(provider);
    let directive: unknown;
    try {
      directive = intercept(call, kwargs, provider);
    } catch (err) {
      return Promise.reject(err); // a pre-flight refusal (budget block, guard) rejects the caller
    }
    if (directive === MISS && call.metadata.rerouted) {
      // Something rewrote the request — put it back on the command. `command.input` is both writable
      // and replaceable (measured on @aws-sdk/client-bedrock-runtime 3.1100.0), which is what lets a
      // guard's redact-before-send and a budget's clamp/downgrade reach the wire without core ever
      // importing the command class.
      (command as { input: unknown }).input = kwargs;
      return observe(() => orig(command, ...rest), call, provider, start, streaming);
    }
    if (directive !== MISS) {
      call.metadata.replayed = true;
      if (streaming) return Promise.resolve(replayStream(call, directive, provider, start));
      try {
        post(call, directive, provider, start);
      } catch (err) {
        return Promise.reject(err); // a post-flight subscriber block still reaches the caller
      }
      return Promise.resolve(directive);
    }
    // Nothing rewrote the request, so hand the SDK its own command object untouched.
    return observe(() => orig(...args), call, provider, start, streaming);
  };
  (wrapper as { [WRAPPED]?: boolean })[WRAPPED] = true;
  return wrapper;
}

/** Promise members that must stay on **our** chain, so post-flight throws reach the caller. */
const PROMISE_CHAIN = new Set<PropertyKey>(['then', 'catch', 'finally']);

/**
 * Run the real call, capture it, and hand the caller back something that behaves like what the SDK
 * returned.
 *
 * The chain is always ours — `post()` emits on the bus, and a subscriber may raise there (guardrails'
 * output stage blocks *after* the call), which has to reject the caller's promise. So the SDK's own
 * promise cannot simply be returned with capture on a detached side branch: the block would vanish.
 * Instead, when the SDK returned a Promise **subclass** (openai/anthropic `APIPromise`), the caller
 * gets a proxy whose `then/catch/finally` are ours and whose other methods — `asResponse`,
 * `withResponse`, anything else the SDK added — are forwarded to the SDK's own object.
 *
 * Plain-promise SDKs (Gemini, Ollama, Hugging Face) get no proxy at all: nothing to preserve, no cost.
 * A **streamed** call also gets the plain chain, because it must hand back a wrapped stream rather
 * than the SDK's value — a documented limit, along with a replayed call, which has no HTTP response.
 */
function observe(
  runReal: () => unknown,
  call: LLMCall,
  provider: string,
  start: number,
  streaming: boolean,
): unknown {
  let returned: unknown;
  syncCallDepth++;
  try {
    returned = runReal();
  } catch (err) {
    return Promise.reject(err); // a client that throws synchronously must still reject
  } finally {
    // Decremented as soon as the real call returns its promise — the window is exactly the
    // synchronous prologue, which is all a nested `send` needs to see. See `syncCallDepth`.
    syncCallDepth--;
  }
  const settled = Promise.resolve(returned).then((response) => {
    if (streaming) return proxyStream(call, response, provider, start);
    post(call, response, provider, start); // may throw ⇒ `settled` rejects ⇒ the caller sees it
    return response;
  });
  if (!isPromiseSubclass(returned)) return settled;
  memoizeParseResponse(returned);
  // The caller may consume only `withResponse()` and never await the proxy, which would leave our
  // chain's rejection unobserved and noisy. Mark it handled — the proxy's `then` still surfaces it.
  void settled.catch(() => {});
  return new Proxy(settled, {
    get(target, prop, _receiver) {
      // A **streamed** call must still hand back cendor's counting stream, so `withResponse()`
      // cannot simply be forwarded — the SDK's own `data` is the raw stream, and iterating that
      // counts nothing. Take the SDK's `response`/`request_id` and swap in our wrapper.
      // anthropic-node's `messages.stream()` helper is built on exactly this call
      // (`lib/MessageStream.mjs`: `create({...,stream:true}).withResponse()`), so without it an
      // instrumented Anthropic client made the SDK's own streaming helper throw.
      if (streaming && prop === 'withResponse') {
        return async (): Promise<unknown> => {
          const sdk = (await (returned as { withResponse(): Promise<unknown> }).withResponse()) as
            | Record<string, unknown>
            | undefined;
          return { ...sdk, data: await settled };
        };
      }
      // `_thenUnwrap` is how openai-node builds `responses.parse` / `chat.completions.parse` /
      // `runTools`: it derives a NEW promise from the SDK's own object. Forwarded blindly (as every
      // other extra is), that derived promise never touches our chain — so a post-flight block
      // reached the wrong promise and the caller resolved anyway.
      //
      // Measured (`plan/evidence-gapclose-2026-07-31/s3_probe_output_gate_helper.mjs`): on the helper
      // path the output gate *did* run and *did* decide `block` — a `GuardrailDecision`
      // `keyword_deny:block` was on the bus — and its exception rejected `settled`, which line 562
      // deliberately marks handled so a `withResponse()`-only caller gets no noisy warning. The gate
      // was never the problem; the promise the caller awaited was. (This is why an earlier
      // `parseResponse` takeover did not close it: parsing was never the mechanism.)
      //
      // So the derived promise is gated on ours: the SDK's transform still produces the value, and a
      // post-flight rejection still reaches whoever awaits it.
      if (prop === '_thenUnwrap') {
        const sdkThenUnwrap = (returned as Record<PropertyKey, unknown>)._thenUnwrap;
        if (typeof sdkThenUnwrap === 'function') {
          return (transform: AnyFn): unknown => {
            const derived = (sdkThenUnwrap as AnyFn).call(returned, transform);
            // `settled` first: a block must reject even if the transform would have succeeded.
            const gated = settled.then(() => derived);
            // Keep the SDK's extras (`asResponse`, a further `_thenUnwrap`) reachable on the result,
            // recursively gated — `parse()` results are chained again in the wild.
            return gateDerived(gated, derived);
          };
        }
      }
      if (!PROMISE_CHAIN.has(prop)) {
        const extra = (returned as Record<PropertyKey, unknown>)[prop];
        if (typeof extra === 'function') return (extra as AnyFn).bind(returned);
      }
      const own = Reflect.get(target, prop, target);
      return typeof own === 'function' ? (own as AnyFn).bind(target) : own;
    },
  });
}

/**
 * Hand back a promise that resolves like `derived` but rejects if our capture chain rejected, while
 * still exposing whatever the SDK put on `derived` (`asResponse`, a nested `_thenUnwrap`, …).
 *
 * Same shape as the proxy in {@link observe}: `then/catch/finally` are ours, everything else is the
 * SDK's. Recursive, because openai-node chains `_thenUnwrap` on a `_thenUnwrap` result.
 */
function gateDerived(gated: Promise<unknown>, derived: unknown): unknown {
  if (!isPromiseSubclass(derived)) return gated;
  void gated.catch(() => {}); // the caller may only reach for asResponse(); don't go noisy
  return new Proxy(gated, {
    get(target, prop, _receiver) {
      if (prop === '_thenUnwrap') {
        const inner = (derived as Record<PropertyKey, unknown>)._thenUnwrap;
        if (typeof inner === 'function') {
          return (transform: AnyFn): unknown => {
            const next = (inner as AnyFn).call(derived, transform);
            return gateDerived(
              gated.then(() => next),
              next,
            );
          };
        }
      }
      if (!PROMISE_CHAIN.has(prop)) {
        const extra = (derived as Record<PropertyKey, unknown>)[prop];
        if (typeof extra === 'function') return (extra as AnyFn).bind(derived);
      }
      const own = Reflect.get(target, prop, target);
      return typeof own === 'function' ? (own as AnyFn).bind(target) : own;
    },
  });
}

/** Whether the SDK handed back a Promise **subclass** — i.e. a promise carrying its own extras. */
function isPromiseSubclass(value: unknown): boolean {
  return value instanceof Promise && Object.getPrototypeOf(value) !== Promise.prototype;
}

/** Parse steps we have already memoized, so wrapping twice cannot nest. */
const MEMOIZED = new WeakSet<object>();

/**
 * Let the SDK's own helper methods survive instrumentation.
 *
 * openai-node builds `responses.parse`, `chat.completions.parse` and `runTools` on
 * `APIPromise._thenUnwrap`, which derives a **new** promise sharing the same fetch `Response` and
 * calls the *original's* `parseResponse` a second time. A fetch body can only be read once — and
 * cendor's capture chain parses too — so the caller got
 * `TypeError: Body is unusable: Body has already been read` and no event at all. (Before the
 * accessors were preserved it failed earlier still, with `_thenUnwrap is not a function`.)
 *
 * Memoizing that one step makes every consumer — ours and any derived promise — share a single
 * read. Duck-typed, no SDK import, and inert on a promise that has no `parseResponse`.
 */
function memoizeParseResponse(promise: unknown): void {
  const target = promise as { parseResponse?: (...args: unknown[]) => unknown };
  const original = target.parseResponse;
  if (typeof original !== 'function' || MEMOIZED.has(original)) return;
  let cached: { value: unknown } | undefined;
  const memo = (...args: unknown[]): unknown => {
    if (cached === undefined) cached = { value: original.apply(promise, args) };
    return cached.value;
  };
  MEMOIZED.add(memo);
  try {
    target.parseResponse = memo;
  } catch {
    // a frozen/immutable promise object — leave the SDK exactly as it was
  }
}

const MISSING = Symbol('missing');

/** Keys that mark a value as already Gemini-native — a `Content` (`parts`) or a `Part`. */
const GEMINI_SHAPE_KEYS = ['parts', 'text', 'inlineData', 'inline_data', 'fileData', 'file_data'];

/**
 * Back-map rerouted messages onto Gemini's `contents` shape.
 *
 * `extractRequest` normalizes a **non-array** `contents` — the very common
 * `generateContent({ contents: 'summarize…' })` — into one canonical `{role, content}` message so every
 * interceptor sees every provider the same way. Writing that message object straight back onto
 * `contents` is what `@google/genai` rejects: it takes a string, a `Content` (`{role, parts}`) or a
 * `Part`, never `{role, content}`. So a guard's redact-before-send scrubbed the payload correctly and
 * then made the call impossible to send.
 *
 * The map mirrors the `openai_embeddings` one — the original request's shape is what goes back:
 * a `Content`/`Part` (an array input, whose shape the scrub preserved) passes through untouched, a
 * canonical message becomes `{role, parts: [{text}]}`, and a string input that produced a single
 * text message goes back as a **string**.
 */
function geminiContents(messages: unknown, original: unknown): unknown {
  const list = Array.isArray(messages) ? messages : [messages];
  const mapped = list.map((m) => {
    if (m === null || typeof m !== 'object') return m; // a bare string part stays one
    const rec = m as Record<string, unknown>;
    if (GEMINI_SHAPE_KEYS.some((k) => k in rec)) return m; // already a Content / Part
    if (!('content' in rec)) return m; // unknown shape — leave it to the SDK
    const role = rec.role === 'assistant' || rec.role === 'model' ? 'model' : 'user';
    return { role, parts: [{ text: String(rec.content ?? '') }] };
  });
  if (typeof original === 'string' && mapped.length === 1) {
    const parts = (mapped[0] as Record<string, unknown> | undefined)?.parts;
    if (Array.isArray(parts) && parts.length === 1) {
      const text = (parts[0] as Record<string, unknown> | undefined)?.text;
      if (typeof text === 'string') return text; // string in, string out
    }
  }
  return Array.isArray(messages) ? mapped : mapped[0];
}

function applyReroute(
  call: LLMCall,
  kwargs: Record<string, unknown>,
  directive: Reroute,
  provider: string,
): void {
  const { messages: messagesUpdate, ...updates } = directive.updates as {
    messages?: unknown;
    [key: string]: unknown;
  };
  const messages = 'messages' in directive.updates ? messagesUpdate : MISSING;
  // `model` is mapped to the provider's own kwarg rather than assigned generically — see
  // MODEL_KWARG for what a generic assignment did to Bedrock.
  const { model: modelUpdate, ...rest } = updates;
  Object.assign(kwargs, rest);
  if ('model' in updates) {
    kwargs[MODEL_KWARG[provider] ?? 'model'] = modelUpdate;
    call.model = modelUpdate as string;
  }
  if (messages !== MISSING) {
    if (provider === 'openai_embeddings') {
      // The embeddings endpoint takes raw text(s) on `input`, not message dicts — map the rerouted
      // messages back to the original input shape (string stays string, list stays list) so e.g. a
      // guard's redact-before-send sends the provider cleaned text.
      const msgs = Array.isArray(messages) ? (messages as Message[]) : [];
      const contents = msgs.map((m) => String(m.content ?? ''));
      const original = kwargs.input;
      kwargs.input = typeof original === 'string' && contents.length > 0 ? contents[0] : contents;
    } else if (GOOGLE_TAGS.has(provider)) {
      // Gemini takes a string / Content / Part on `contents`, never a message dict — back-map it.
      kwargs.contents = geminiContents(messages, kwargs.contents);
    } else {
      kwargs[MESSAGES_KWARG[provider] ?? 'messages'] = messages;
    }
    call.messages = messages as Message[];
  }
  call.metadata.rerouted = true;
}

function pre(
  provider: string,
  kwargs: Record<string, unknown>,
  args: unknown[],
  modelDefault: string,
): { call: LLMCall; start: number } {
  const { model, messages } = extractRequest(provider, kwargs, args, modelDefault);
  const call = new LLMCall({
    id: uuidHex(),
    provider: publicProvider(provider),
    model,
    messages,
    traceId: currentTraceId(),
    ts: new Date(),
  });
  call.metadata.request_kwargs = kwargs;
  if (provider === 'openai_embeddings') {
    call.metadata.embedding = true; // so subscribers can tell embedding calls apart
  }
  // Stamp ambient run context (agent, conversation id, budget frames, …) at the one
  // guaranteed-correct moment — this synchronous frame — before interceptors run (§ ambient seam).
  applyAmbient(call);
  return { call, start: performance.now() };
}

function extractRequest(
  provider: string,
  kwargs: Record<string, unknown>,
  args: unknown[],
  modelDefault: string,
): { model: string; messages: Message[] } {
  if (provider === 'openai_responses') {
    const inp = kwargs.input ?? kwargs.messages;
    let messages: Message[];
    if (typeof inp === 'string') messages = [{ role: 'user', content: inp }];
    else if (Array.isArray(inp)) messages = inp as Message[];
    else messages = [];
    return { model: (kwargs.model as string) ?? '', messages };
  }
  if (provider === 'openai_embeddings') {
    // Embeddings API: embeddings.create({ model, input }) — input is a string or a list of
    // strings. Normalize each text to a message dict so interceptors (guard redaction, budget
    // projection) see the payload the same way they see chat messages.
    const inp = kwargs.input;
    let texts: unknown[];
    if (typeof inp === 'string') texts = [inp];
    else if (Array.isArray(inp)) texts = inp;
    else texts = [];
    return {
      model: (kwargs.model as string) ?? '',
      messages: texts.map((t) => ({ role: 'user', content: t })),
    };
  }
  if (provider === 'bedrock' || provider === 'bedrock_stream') {
    // Converse / ConverseStream: modelId= (not model=) carries the model; messages= carries the turns.
    const messages = Array.isArray(kwargs.messages) ? (kwargs.messages as Message[]) : [];
    return { model: (kwargs.modelId as string) ?? '', messages };
  }
  if (GOOGLE_TAGS.has(provider)) {
    // Gemini messages ride `contents` (or the first positional arg on the legacy surface); the model
    // id rides `model` on the new client, else the object-bound modelDefault on the legacy one.
    let contents: unknown = kwargs.contents;
    if (contents == null && args.length > 0) contents = args[0];
    let messages: Message[];
    if (Array.isArray(contents)) messages = contents as Message[];
    else if (contents) messages = [{ role: 'user', content: String(contents) }];
    else messages = [];
    return { model: (kwargs.model as string) || modelDefault, messages };
  }
  // openai / anthropic / ollama / huggingface all take model= + messages=
  const messages = Array.isArray(kwargs.messages) ? (kwargs.messages as Message[]) : [];
  return { model: (kwargs.model as string) ?? '', messages };
}

function post(call: LLMCall, response: unknown, provider: string, start: number): void {
  call.latencyMs = performance.now() - start;
  const usage = extractUsage(response, provider);
  call.usage = usage;
  setCost(call, usage, extractReportedCost(response));
  call.metadata.response = response;
  emit(call);
}

function setCost(call: LLMCall, usage: Usage | null, reported: Money | null): void {
  if (reported !== null) {
    call.cost = reported;
    call.metadata.cost_reported = true;
    return;
  }
  if (usage !== null) {
    try {
      call.cost = estimate(call.model, usage.inputTokens, {
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
        cacheWriteTokens: usage.cacheWrite,
      });
      call.metadata.cost_estimated = true;
    } catch {
      call.cost = null;
    }
  }
}

function extractReportedCost(response: unknown): Money | null {
  const u = get(response, 'usage');
  const candidates: unknown[] = [];
  if (u !== null) candidates.push(get(u, 'cost'), get(u, 'total_cost'));
  candidates.push(get(response, 'cost'), get(response, 'total_cost'));
  for (const c of candidates) {
    if (c == null) continue;
    let amount: InstanceType<typeof Dec>;
    try {
      amount = new Dec(String(c));
    } catch {
      continue;
    }
    if (amount.greaterThanOrEqualTo(0)) return new Money(amount);
  }
  return null;
}

function ensureStreamUsageOptions(provider: string, kwargs: Record<string, unknown>): void {
  if (provider === 'openai' && kwargs.stream && !('stream_options' in kwargs)) {
    kwargs.stream_options = { include_usage: true };
  }
}

// --------------------------------------------------------------------------- streaming

async function* fromArray(items: unknown[]): AsyncGenerator<unknown> {
  for (const item of items) yield item;
}

/** `Symbol.asyncDispose` if the runtime defines it (Node ≥ 20 / TS `using`); typed defensively
 * because the compile target is ES2022, whose lib does not yet declare it. */
const ASYNC_DISPOSE: symbol | undefined = (Symbol as { asyncDispose?: symbol }).asyncDispose;

/**
 * State + behaviour for one wrapped streaming response. Chunks pass through unchanged and usage is
 * accumulated, so the `LLMCall` is emitted **exactly once** (guarded by {@link finalized}) when the
 * stream completes, or when the consumer stops early via `close()`/`Symbol.asyncDispose`. The public
 * value handed back to callers is a `Proxy` (see {@link wrapStream}) that keeps this iteration
 * behaviour while forwarding every other member (`.tee()`, `.controller`, `.response`,
 * `.finalMessage()`, …) to the underlying SDK stream. Mirrors Python's `_AProxyStream`.
 */
class StreamState {
  finalized = false;
  readonly chunks: unknown[] = [];
  constructor(
    readonly call: LLMCall,
    readonly stream: AsyncIterable<unknown>,
    readonly provider: string,
    readonly start: number,
    readonly replayChunks: unknown[] | null = null,
  ) {}

  finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    const finalChunks = this.replayChunks ?? this.chunks;
    finalizeStream(this.call, finalChunks, this.provider, this.start);
  }

  async *iterate(): AsyncGenerator<unknown> {
    try {
      for await (const chunk of this.stream) {
        if (this.chunks.length === 0 && this.replayChunks === null) {
          this.call.metadata.ttft_ms = performance.now() - this.start; // first live chunk (G23)
        }
        this.chunks.push(chunk);
        if (streamObservers.length > 0) {
          // Mid-stream observers (tokenguard breaker); zero ⇒ one length check. A throwing observer
          // (a crossed budget cap) breaks out of the loop: `for await` calls the source iterator's
          // `return()` (ES IteratorClose → the SDK stream aborts its controller), the `finally` below
          // finalizes once (partial usage, flagged estimated — the crossing chunk is withheld from
          // the consumer but kept for the settle), and the error propagates to the consumer.
          this.observeChunk(chunk);
        }
        yield chunk;
      }
    } finally {
      this.finalize();
    }
  }

  private observeChunk(chunk: unknown): void {
    const deltaText = streamText(chunk, this.provider);
    const deltaThinking = streamThinkingText(chunk, this.provider);
    for (const fn of streamObservers) fn(this.call, deltaText, deltaThinking);
  }

  private async closeUnderlying(): Promise<void> {
    const s = this.stream as unknown as Record<PropertyKey, unknown>;
    // Belt for the explicit close()/aclose()/Symbol.asyncDispose path: abort the underlying fetch
    // controller if the SDK stream exposes one (throwing-in-loop already aborts via IteratorClose).
    const controller = s.controller as { abort?: () => void } | undefined;
    if (controller != null && typeof controller.abort === 'function') {
      try {
        controller.abort();
      } catch {
        /* best-effort */
      }
    }
    const close = (s.close ?? s.aclose) as ((...a: unknown[]) => unknown) | undefined;
    if (typeof close === 'function') {
      const result = close.call(this.stream);
      if (result != null && typeof (result as { then?: unknown }).then === 'function') {
        await result;
      }
    }
  }

  async aclose(): Promise<void> {
    try {
      await this.closeUnderlying();
    } finally {
      this.finalize();
    }
  }
}

/**
 * Wrap a {@link StreamState} in a `Proxy`: `Symbol.asyncIterator` runs the usage-capturing generator,
 * `close`/`aclose`/`Symbol.asyncDispose` close the underlying stream and finalize once, and every
 * other member is forwarded to the underlying SDK stream (functions bound so `this` is the stream).
 */
function wrapStream(state: StreamState): AsyncIterable<unknown> {
  const handler: ProxyHandler<Record<PropertyKey, unknown>> = {
    get(_target, prop) {
      if (prop === Symbol.asyncIterator) return () => state.iterate();
      if (prop === 'close' || prop === 'aclose') return () => state.aclose();
      if (ASYNC_DISPOSE !== undefined && prop === ASYNC_DISPOSE) return () => state.aclose();
      const value = (state.stream as unknown as Record<PropertyKey, unknown>)[prop];
      if (typeof value === 'function') {
        return (value as (...a: unknown[]) => unknown).bind(state.stream);
      }
      return value;
    },
    has(_target, prop) {
      if (prop === Symbol.asyncIterator || prop === 'close' || prop === 'aclose') return true;
      if (ASYNC_DISPOSE !== undefined && prop === ASYNC_DISPOSE) return true;
      return prop in (state.stream as unknown as Record<PropertyKey, unknown>);
    },
  };
  return new Proxy(
    {} as Record<PropertyKey, unknown>,
    handler,
  ) as unknown as AsyncIterable<unknown>;
}

function proxyStream(call: LLMCall, stream: unknown, provider: string, start: number): unknown {
  const sp = streamProvider(provider);
  // Bedrock converse_stream returns the iterable as the `stream` member of a response object — wrap
  // that member and hand the object back unchanged, so `for await (const e of response.stream)` still
  // works. Every other provider returns the iterable directly. (Mirrors Python's _proxy_stream.)
  if (provider === 'bedrock_stream') {
    const resp = (stream ?? {}) as Record<string, unknown>;
    const proxy = wrapStream(
      new StreamState(call, resp.stream as AsyncIterable<unknown>, sp, start),
    );
    return { ...resp, stream: proxy };
  }
  return wrapStream(new StreamState(call, stream as AsyncIterable<unknown>, sp, start));
}

function replayStream(call: LLMCall, recorded: unknown, provider: string, start: number): unknown {
  const chunks = Array.isArray(recorded) ? [...recorded] : recorded == null ? [] : [recorded];
  const proxy = wrapStream(
    new StreamState(call, fromArray(chunks), streamProvider(provider), start, chunks),
  );
  return provider === 'bedrock_stream' ? { stream: proxy } : proxy;
}

function finalizeStream(call: LLMCall, chunks: unknown[], provider: string, start: number): void {
  call.latencyMs = performance.now() - start;
  let usage = streamUsage(chunks, provider);
  if (usage === null) usage = estimateStreamUsage(call, chunks, provider);
  call.usage = usage;
  let reported: Money | null = null;
  for (const ch of chunks) {
    reported = extractReportedCost(ch);
    if (reported !== null) break;
  }
  setCost(call, usage, reported);
  call.metadata.streamed = true;
  call.metadata.response = chunks;
  emit(call);
}

function streamUsage(chunks: unknown[], provider: string): Usage | null {
  if (provider === 'anthropic') {
    let inp: unknown = null;
    let out: unknown = null;
    let cached = 0;
    let cacheWrite = 0;
    for (const ch of chunks) {
      const etype = get(ch, 'type');
      if (etype === 'message_start') {
        const u = get(get(ch, 'message'), 'usage');
        inp = get(u, 'input_tokens', inp);
        cached = (get(u, 'cache_read_input_tokens', 0) as number) || 0;
        cacheWrite = (get(u, 'cache_creation_input_tokens', 0) as number) || 0;
      } else if (etype === 'message_delta') {
        const u = get(ch, 'usage');
        if (u !== null) out = get(u, 'output_tokens', out);
      }
    }
    if (inp === null) return null;
    return new Usage({
      inputTokens: toInt(inp) + cached,
      outputTokens: toInt(out ?? 0),
      cachedTokens: cached,
      cacheWrite,
    });
  }
  if (provider === 'bedrock') {
    // Bedrock streams usage on a `metadata` event (camelCase token keys).
    for (const ch of chunks) {
      const u = get(get(ch, 'metadata'), 'usage');
      if (u !== null) {
        return new Usage({
          inputTokens: toInt((get(u, 'inputTokens', 0) as number) || 0),
          outputTokens: toInt((get(u, 'outputTokens', 0) as number) || 0),
        });
      }
    }
    return null;
  }
  if (provider === 'openai_responses') {
    for (const ch of chunks) {
      const resp = get(ch, 'response');
      if (resp !== null && get(resp, 'usage') !== null)
        return extractUsage(resp, 'openai_responses');
    }
    return null;
  }
  if (provider === 'google') {
    // Gemini puts `usageMetadata` on EVERY chunk carrying the *running* totals, not just the final
    // one (measured 2026-07-31 on @google/genai: two chunks, both `[4, 7, 11]`). Taking the first
    // usage-bearing chunk — what the generic loop below does — would under-count a longer stream.
    // Take the LAST one: it is the final total.
    let last: Usage | null = null;
    for (const ch of chunks) {
      const u = extractUsage(ch, 'google');
      if (u !== null) last = u;
    }
    return last;
  }
  // openai / huggingface / ollama: usage rides one (final) chunk, full-response shaped.
  for (const ch of chunks) {
    const u = extractUsage(ch, provider);
    if (u !== null) return u;
  }
  return null;
}

function estimateStreamUsage(call: LLMCall, chunks: unknown[], provider: string): Usage | null {
  const text = chunks.map((ch) => streamText(ch, provider)).join('');
  const thinking = chunks.map((ch) => streamThinkingText(ch, provider)).join('');
  if (!text && !thinking && call.messages.length === 0) return null;
  const inp = call.messages.length > 0 ? countTokens(call.messages, call.model) : 0;
  const outVisible = text ? countTokens(text, call.model) : 0;
  // Visible thinking (Anthropic thinking_delta, Ollama message.thinking, reasoning_content, Bedrock
  // reasoningContent) is billed as output — fold it in and surface it as reasoning. Hidden reasoning
  // (OpenAI-native/Gemini) never reaches the wire, so it stays invisible (the documented limit).
  const outThinking = thinking ? countTokens(thinking, call.model) : 0;
  call.metadata.usage_estimated = true;
  return new Usage({
    inputTokens: inp,
    outputTokens: outVisible + outThinking,
    reasoningTokens: outThinking,
  });
}

export function streamText(chunk: unknown, provider: string): string {
  try {
    if (provider === 'openai_responses') {
      if (get(chunk, 'type') === 'response.output_text.delta')
        return String(get(chunk, 'delta', '') ?? '');
      return '';
    }
    if (provider === 'openai' || provider === 'huggingface') {
      // Both stream Chat Completions-shaped chunks (HF's response is OpenAI-shaped).
      const choices = (get(chunk, 'choices') as unknown[]) ?? [];
      return choices.map((c) => String(get(get(c, 'delta'), 'content', '') ?? '')).join('');
    }
    if (provider === 'anthropic') {
      if (get(chunk, 'type') === 'content_block_delta')
        return String(get(get(chunk, 'delta'), 'text', '') ?? '');
      return '';
    }
    if (provider === 'ollama') {
      return String(get(get(chunk, 'message'), 'content', '') ?? '');
    }
    if (provider === 'google') {
      return String(get(chunk, 'text', '') ?? '');
    }
    if (provider === 'bedrock') {
      return String(get(get(get(chunk, 'contentBlockDelta'), 'delta'), 'text', '') ?? '');
    }
  } catch {
    return '';
  }
  return '';
}

/**
 * Best-effort *visible* reasoning/thinking text of one chunk, per provider. Kept separate from
 * {@link streamText} (which content capture reuses — folding thinking in would mislabel it): this
 * feeds the offline estimate (output + reasoning) and the stream observers, so a mid-stream budget
 * breaker counts visible thinking too. Hidden reasoning (OpenAI-native, Gemini) never reaches the
 * wire, so it stays `''` here — the documented honest limit.
 */
export function streamThinkingText(chunk: unknown, provider: string): string {
  try {
    if (provider === 'anthropic') {
      if (get(chunk, 'type') === 'content_block_delta') {
        const delta = get(chunk, 'delta');
        if (get(delta, 'type') === 'thinking_delta')
          return String(get(delta, 'thinking', '') ?? '');
      }
      return '';
    }
    if (provider === 'openai' || provider === 'huggingface') {
      // OpenAI-compatible reasoning_content (e.g. DeepSeek via the Chat Completions shape).
      const choices = (get(chunk, 'choices') as unknown[]) ?? [];
      return choices
        .map((c) => String(get(get(c, 'delta'), 'reasoning_content', '') ?? ''))
        .join('');
    }
    if (provider === 'ollama') {
      return String(get(get(chunk, 'message'), 'thinking', '') ?? '');
    }
    if (provider === 'bedrock') {
      const rc = get(get(get(chunk, 'contentBlockDelta'), 'delta'), 'reasoningContent');
      return String(get(rc, 'text', '') ?? '');
    }
  } catch {
    return '';
  }
  return '';
}

function extractUsage(response: unknown, provider: string): Usage | null {
  let cached = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  let inp: unknown;
  let out: unknown;
  if (provider === 'google') {
    // The real `@google/genai` JS SDK returns **camelCase** usage (`usageMetadata.promptTokenCount`
    // /`candidatesTokenCount`/`thoughtsTokenCount`); the Python `google-genai` SDK uses snake_case
    // (`usage_metadata.prompt_token_count`/…). Read camelCase first and fall back to snake_case so
    // both cross-SDK shapes capture (mirrors the bedrock branch's camelCase keys). Gemini reports
    // thinking-model reasoning under `thoughtsTokenCount`, *separate* from `candidatesTokenCount`;
    // both bill as output, so fold thoughts into the output total (else reasoning models
    // under-count) and surface it as reasoning.
    const meta = get(response, 'usageMetadata') ?? get(response, 'usage_metadata');
    inp = get(meta, 'promptTokenCount') ?? get(meta, 'prompt_token_count');
    reasoning =
      ((get(meta, 'thoughtsTokenCount') ?? get(meta, 'thoughts_token_count', 0)) as number) || 0;
    out =
      (((get(meta, 'candidatesTokenCount') ?? get(meta, 'candidates_token_count', 0)) as number) ||
        0) + reasoning;
  } else if (provider === 'ollama') {
    // Token counts are top-level on the response.
    inp = get(response, 'prompt_eval_count');
    out = (get(response, 'eval_count', 0) as number) || 0;
  } else {
    const u = get(response, 'usage');
    if (u === null) return null;
    if (
      provider === 'openai' ||
      provider === 'openai_responses' ||
      provider === 'openai_embeddings' ||
      provider === 'huggingface'
    ) {
      // Dual-shape: Chat Completions uses prompt_tokens/completion_tokens (+ details); the Responses
      // API uses input_tokens/output_tokens (+ *_tokens_details). HF's chatCompletion returns the
      // Chat Completions shape. Read whichever the response carries so one branch covers all three.
      // Embeddings responses carry prompt_tokens/total_tokens only (no completion_tokens -> out 0).
      inp = get(u, 'prompt_tokens');
      if (inp == null) inp = get(u, 'input_tokens');
      out = get(u, 'completion_tokens');
      if (out == null) out = get(u, 'output_tokens', 0);
      out = out || 0;
      const details = get(u, 'prompt_tokens_details') ?? get(u, 'input_tokens_details');
      cached = details !== null ? (get(details, 'cached_tokens', 0) as number) || 0 : 0;
      const cdetails = get(u, 'completion_tokens_details') ?? get(u, 'output_tokens_details');
      reasoning = cdetails !== null ? (get(cdetails, 'reasoning_tokens', 0) as number) || 0 : 0;
    } else if (provider === 'bedrock') {
      // Converse usage uses camelCase token keys.
      inp = get(u, 'inputTokens');
      out = (get(u, 'outputTokens', 0) as number) || 0;
    } else {
      // anthropic — thinking tokens are folded into output_tokens with no separate count
      const baseIn = get(u, 'input_tokens');
      out = (get(u, 'output_tokens', 0) as number) || 0;
      cached = (get(u, 'cache_read_input_tokens', 0) as number) || 0;
      cacheWrite = (get(u, 'cache_creation_input_tokens', 0) as number) || 0;
      inp = baseIn == null ? null : toInt(baseIn) + cached;
    }
  }
  if (inp == null) return null;
  return new Usage({
    inputTokens: toInt(inp),
    outputTokens: toInt(out),
    cachedTokens: toInt(cached),
    reasoningTokens: toInt(reasoning),
    cacheWrite: toInt(cacheWrite),
  });
}

// --------------------------------------------------------------------------- tools

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Wrap a tool/function so each invocation emits a `ToolCall` on the bus. Usable as
 * `instrumentTool(fn)` or `instrumentTool('search')(fn)`. Idempotent, sync + async, replay-aware.
 */
export function instrumentTool(nameOrFn?: string | AnyFn): AnyFn | ((fn: AnyFn) => AnyFn) {
  if (typeof nameOrFn === 'function') return wrapTool(nameOrFn, nameOrFn.name || 'tool');
  return (fn: AnyFn) =>
    wrapTool(fn, (typeof nameOrFn === 'string' && nameOrFn) || fn.name || 'tool');
}

function preTool(name: string, args: unknown[]): { tc: ToolCall; start: number } {
  const tc = new ToolCall({
    id: uuidHex(),
    name,
    arguments: { args: [...args], kwargs: {} },
    traceId: currentTraceId(),
    ts: new Date(),
  });
  applyAmbient(tc);
  return { tc, start: performance.now() };
}

function postTool(tc: ToolCall, result: unknown, start: number): void {
  tc.latencyMs = performance.now() - start;
  tc.result = result;
  emit(tc);
}

function wrapTool(fn: AnyFn, toolName: string): AnyFn {
  if ((fn as { [WRAPPED]?: boolean })[WRAPPED]) return fn;
  const isAsync = fn.constructor?.name === 'AsyncFunction';
  let wrapper: AnyFn;
  if (isAsync) {
    wrapper = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const { tc, start } = preTool(toolName, args);
      const replayed = intercept(tc);
      let result: unknown;
      if (replayed !== MISS) {
        tc.metadata.replayed = true;
        result = replayed;
      } else {
        result = await fn.apply(this, args);
      }
      postTool(tc, result, start);
      return result;
    };
  } else {
    wrapper = function (this: unknown, ...args: unknown[]): unknown {
      const { tc, start } = preTool(toolName, args);
      const replayed = intercept(tc);
      if (replayed !== MISS) {
        tc.metadata.replayed = true;
        postTool(tc, replayed, start);
        return replayed;
      }
      const result = fn.apply(this, args);
      if (result != null && typeof (result as { then?: unknown }).then === 'function') {
        return (result as Promise<unknown>).then((r) => {
          postTool(tc, r, start);
          return r;
        });
      }
      postTool(tc, result, start);
      return result;
    };
  }
  Object.defineProperty(wrapper, WRAPPED, { value: true });
  return wrapper;
}
