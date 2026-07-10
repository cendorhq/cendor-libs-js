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
import { emit } from './bus.js';
import { Dec } from './decimal.js';
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

/** Register a pre-call interceptor. Returns a response to short-circuit, or {@link MISS} to proceed. */
export function addInterceptor(fn: Interceptor): Interceptor {
  if (!interceptors.includes(fn)) interceptors.push(fn);
  return fn;
}

/** Unregister a previously added interceptor (no error if absent). */
export function removeInterceptor(fn: Interceptor): void {
  const i = interceptors.indexOf(fn);
  if (i >= 0) interceptors.splice(i, 1);
}

function intercept(event: unknown): unknown {
  const snapshot = [...interceptors];
  for (const fn of snapshot) {
    const result = fn(event);
    if (result !== MISS) return result;
  }
  return MISS;
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
  if (targets.length > 0) return targets;
  const messages = c.messages as Record<string, unknown> | undefined;
  if (messages && typeof messages.create === 'function') {
    return [[messages, 'create', 'anthropic']];
  }
  // AWS Bedrock Converse. LIMITATION: aws-sdk v3 uses `client.send(new ConverseCommand(...))` — there
  // is NO duck-typable `client.converse(...)`, and `send` is shared by every AWS command so it can't
  // be cleanly duck-typed. This predicate matches boto-shaped / wrapper clients that DO expose
  // `converse()`; first-class aws-sdk-v3 Bedrock support rides the SDK provider (Phase C), which wraps
  // the client directly. The usage/request/stream bedrock branches below are implemented regardless so
  // Phase C reuses them.
  if (typeof c.converse === 'function') return [[c, 'converse', 'bedrock']];
  // Legacy @google/generative-ai: `model.generateContent(...)` with the model id bound to the object
  // (read as modelDefault in instrument()).
  if (typeof c.generateContent === 'function') return [[c, 'generateContent', 'google']];
  // @google/genai SDK: sync `client.models.generateContent` + (parity) async
  // `client.aio?.models?.generateContent`. In the JS SDK there is only one async surface (no `aio`),
  // but the `aio` probe is harmless and keeps parity with the Python detection.
  const google: Target[] = [];
  const models = c.models as Record<string, unknown> | undefined;
  if (models && typeof models.generateContent === 'function') {
    google.push([models, 'generateContent', 'google']);
  }
  const aio = c.aio as Record<string, unknown> | undefined;
  const aioModels = aio?.models as Record<string, unknown> | undefined;
  if (aioModels && typeof aioModels.generateContent === 'function') {
    google.push([aioModels, 'generateContent', 'google']);
  }
  if (google.length > 0) return google;
  // Ollama: `client.chat(...)` is itself callable (vs OpenAI's `chat` namespace). Checked LAST.
  if (typeof c.chat === 'function') return [[c, 'chat', 'ollama']];
  return [];
}

const PUBLIC_PROVIDER: Record<string, string> = { openai_responses: 'openai' };
function publicProvider(provider: string): string {
  return PUBLIC_PROVIDER[provider] ?? provider;
}

/** Per-provider kwarg carrying request messages (so `Reroute({ messages })` rewrites the right field).
 * Chat Completions / Anthropic / Bedrock / Ollama use `messages`; the Responses API uses `input`;
 * Gemini uses `contents`. */
const MESSAGES_KWARG: Record<string, string> = { openai_responses: 'input', google: 'contents' };

/**
 * Wrap a provider client so each call emits an `LLMCall` on the bus. Detection is structural. Unknown
 * clients are returned untouched; wrapping is idempotent and returns the same client object.
 */
export function instrument<T>(client: T): T {
  for (const [owner, attr, provider] of findTargets(client)) {
    const fn = owner[attr] as ((...args: unknown[]) => unknown) & { [WRAPPED]?: boolean };
    if (fn[WRAPPED]) continue;
    let modelDefault = '';
    if (provider === 'google') {
      // The legacy @google/generative-ai GenerativeModel binds the model id to the object (`.model`,
      // e.g. "models/gemini-1.5-pro"), not the call args — read it so the LLMCall carries a real,
      // priceable model id (strip the "models/" prefix). The @google/genai Client has no such field;
      // its model rides the `model` arg instead. (`modelName`/`_modelName` covered for parity.)
      const c = client as Record<string, unknown>;
      const name = (get(c, 'model') ?? get(c, 'modelName') ?? get(c, '_modelName') ?? '') as string;
      modelDefault = String(name).replace(/^models\//, '');
    }
    owner[attr] = wrap(
      fn.bind(owner) as (...args: unknown[]) => Promise<unknown>,
      provider,
      modelDefault,
    );
  }
  return client;
}

// --------------------------------------------------------------------------- model clients

function wrap(orig: (...args: unknown[]) => Promise<unknown>, provider: string, modelDefault = '') {
  const wrapper = async (...args: unknown[]): Promise<unknown> => {
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
    const streaming = Boolean(kwargs.stream);
    const runReal = (): Promise<unknown> => (hasOptions ? orig(kwargs, ...rest) : orig(...args));
    const directive = intercept(call);
    if (directive instanceof Reroute) {
      applyReroute(call, kwargs, directive, provider);
      const response = await orig(kwargs, ...rest);
      if (streaming) return proxyStream(call, response, provider, start);
      post(call, response, provider, start);
      return response;
    }
    if (directive !== MISS) {
      call.metadata.replayed = true;
      if (streaming) return replayStream(call, directive, provider, start);
      post(call, directive, provider, start);
      return directive;
    }
    const response = await runReal();
    if (streaming) return proxyStream(call, response, provider, start);
    post(call, response, provider, start);
    return response;
  };
  (wrapper as { [WRAPPED]?: boolean })[WRAPPED] = true;
  return wrapper;
}

const MISSING = Symbol('missing');

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
  Object.assign(kwargs, updates);
  if ('model' in updates) call.model = updates.model as string;
  if (messages !== MISSING) {
    kwargs[MESSAGES_KWARG[provider] ?? 'messages'] = messages;
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
  if (provider === 'bedrock') {
    // Converse: modelId= (not model=) carries the model; messages= carries the turns.
    const messages = Array.isArray(kwargs.messages) ? (kwargs.messages as Message[]) : [];
    return { model: (kwargs.modelId as string) ?? '', messages };
  }
  if (provider === 'google') {
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
        this.chunks.push(chunk);
        yield chunk;
      }
    } finally {
      this.finalize();
    }
  }

  private async closeUnderlying(): Promise<void> {
    const s = this.stream as unknown as Record<PropertyKey, unknown>;
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

function proxyStream(
  call: LLMCall,
  stream: unknown,
  provider: string,
  start: number,
): AsyncIterable<unknown> {
  return wrapStream(new StreamState(call, stream as AsyncIterable<unknown>, provider, start));
}

function replayStream(
  call: LLMCall,
  recorded: unknown,
  provider: string,
  start: number,
): AsyncIterable<unknown> {
  const chunks = Array.isArray(recorded) ? [...recorded] : recorded == null ? [] : [recorded];
  return wrapStream(new StreamState(call, fromArray(chunks), provider, start, chunks));
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
  // openai / huggingface / ollama / google: usage rides one (final) chunk, full-response shaped.
  for (const ch of chunks) {
    const u = extractUsage(ch, provider);
    if (u !== null) return u;
  }
  return null;
}

function estimateStreamUsage(call: LLMCall, chunks: unknown[], provider: string): Usage | null {
  const text = chunks.map((ch) => streamText(ch, provider)).join('');
  if (!text && call.messages.length === 0) return null;
  const inp = call.messages.length > 0 ? countTokens(call.messages, call.model) : 0;
  const out = text ? countTokens(text, call.model) : 0;
  call.metadata.usage_estimated = true;
  return new Usage({ inputTokens: inp, outputTokens: out });
}

function streamText(chunk: unknown, provider: string): string {
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
    if (provider === 'openai' || provider === 'openai_responses' || provider === 'huggingface') {
      // Dual-shape: Chat Completions uses prompt_tokens/completion_tokens (+ details); the Responses
      // API uses input_tokens/output_tokens (+ *_tokens_details). HF's chatCompletion returns the
      // Chat Completions shape. Read whichever the response carries so one branch covers all three.
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
