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
  return [];
}

const PUBLIC_PROVIDER: Record<string, string> = { openai_responses: 'openai' };
function publicProvider(provider: string): string {
  return PUBLIC_PROVIDER[provider] ?? provider;
}

/** Per-provider kwarg carrying request messages (so `Reroute({ messages })` rewrites the right field). */
const MESSAGES_KWARG: Record<string, string> = { openai_responses: 'input' };

/**
 * Wrap a provider client so each call emits an `LLMCall` on the bus. Detection is structural. Unknown
 * clients are returned untouched; wrapping is idempotent and returns the same client object.
 */
export function instrument<T>(client: T): T {
  for (const [owner, attr, provider] of findTargets(client)) {
    const fn = owner[attr] as ((...args: unknown[]) => unknown) & { [WRAPPED]?: boolean };
    if (fn[WRAPPED]) continue;
    owner[attr] = wrap(fn.bind(owner) as (...args: unknown[]) => Promise<unknown>, provider);
  }
  return client;
}

// --------------------------------------------------------------------------- model clients

function wrap(orig: (...args: unknown[]) => Promise<unknown>, provider: string) {
  const wrapper = async (...args: unknown[]): Promise<unknown> => {
    const kwargs: Record<string, unknown> = {
      ...((args[0] as Record<string, unknown> | undefined) ?? {}),
    };
    const rest = args.slice(1);
    const { call, start } = pre(provider, kwargs);
    ensureStreamUsageOptions(provider, kwargs);
    const streaming = Boolean(kwargs.stream);
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
    const response = await orig(kwargs, ...rest);
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

function pre(provider: string, kwargs: Record<string, unknown>): { call: LLMCall; start: number } {
  const { model, messages } = extractRequest(provider, kwargs);
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
): { model: string; messages: Message[] } {
  if (provider === 'openai_responses') {
    const inp = kwargs.input ?? kwargs.messages;
    let messages: Message[];
    if (typeof inp === 'string') messages = [{ role: 'user', content: inp }];
    else if (Array.isArray(inp)) messages = inp as Message[];
    else messages = [];
    return { model: (kwargs.model as string) ?? '', messages };
  }
  // openai / anthropic both take model= + messages=
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

/**
 * Wraps a streaming response: chunks pass through unchanged and usage is accumulated, so the
 * `LLMCall` is emitted once with usage/cost/latency when the stream completes (or the consumer stops
 * early). The result is an async-iterable — the contract callers rely on (`for await (const chunk)`).
 */
class AsyncStreamProxy implements AsyncIterable<unknown> {
  constructor(
    private readonly call: LLMCall,
    private readonly stream: AsyncIterable<unknown>,
    private readonly provider: string,
    private readonly start: number,
    private readonly replayChunks: unknown[] | null = null,
  ) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    const chunks: unknown[] = [];
    try {
      for await (const chunk of this.stream) {
        chunks.push(chunk);
        yield chunk;
      }
    } finally {
      const finalChunks = this.replayChunks ?? chunks;
      finalizeStream(this.call, finalChunks, this.provider, this.start);
    }
  }
}

function proxyStream(
  call: LLMCall,
  stream: unknown,
  provider: string,
  start: number,
): AsyncStreamProxy {
  return new AsyncStreamProxy(call, stream as AsyncIterable<unknown>, provider, start);
}

function replayStream(
  call: LLMCall,
  recorded: unknown,
  provider: string,
  start: number,
): AsyncStreamProxy {
  const chunks = Array.isArray(recorded) ? [...recorded] : recorded == null ? [] : [recorded];
  return new AsyncStreamProxy(call, fromArray(chunks), provider, start, chunks);
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
  if (provider === 'openai_responses') {
    for (const ch of chunks) {
      const resp = get(ch, 'response');
      if (resp !== null && get(resp, 'usage') !== null)
        return extractUsage(resp, 'openai_responses');
    }
    return null;
  }
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
    if (provider === 'openai') {
      const choices = (get(chunk, 'choices') as unknown[]) ?? [];
      return choices.map((c) => String(get(get(c, 'delta'), 'content', '') ?? '')).join('');
    }
    if (provider === 'anthropic') {
      if (get(chunk, 'type') === 'content_block_delta')
        return String(get(get(chunk, 'delta'), 'text', '') ?? '');
      return '';
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
  const u = get(response, 'usage');
  if (u === null) return null;
  let inp: unknown;
  let out: unknown;
  if (provider === 'openai' || provider === 'openai_responses') {
    inp = get(u, 'prompt_tokens');
    if (inp == null) inp = get(u, 'input_tokens');
    out = get(u, 'completion_tokens');
    if (out == null) out = get(u, 'output_tokens', 0);
    out = out || 0;
    const details = get(u, 'prompt_tokens_details') ?? get(u, 'input_tokens_details');
    cached = details !== null ? (get(details, 'cached_tokens', 0) as number) || 0 : 0;
    const cdetails = get(u, 'completion_tokens_details') ?? get(u, 'output_tokens_details');
    reasoning = cdetails !== null ? (get(cdetails, 'reasoning_tokens', 0) as number) || 0 : 0;
  } else {
    // anthropic — thinking tokens are folded into output_tokens with no separate count
    const baseIn = get(u, 'input_tokens');
    out = (get(u, 'output_tokens', 0) as number) || 0;
    cached = (get(u, 'cache_read_input_tokens', 0) as number) || 0;
    cacheWrite = (get(u, 'cache_creation_input_tokens', 0) as number) || 0;
    inp = baseIn == null ? null : toInt(baseIn) + cached;
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
