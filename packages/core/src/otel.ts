/**
 * OpenTelemetry GenAI span helpers (optional) + a dependency-free `gen_ai.*` ingest path. The TS
 * mirror of `cendor.core.otel`. Emits/reads `gen_ai.*` following the OpenTelemetry GenAI semantic
 * conventions, so the whole stack speaks the standard everyone is converging on — no proprietary
 * telemetry format.
 *
 * `span()` needs `@opentelemetry/api` (an optional peer dep); it is a **no-op when the package is
 * absent** (never throws). `ingest()` has no OTel dependency at all — it just reads a `gen_ai.*`
 * attribute bag. Neither touches the event bus except `ingest`, which emits the normalized `LLMCall`.
 */
import { createRequire } from 'node:module';
import { emit, subscribe, unsubscribe } from './bus.js';
import { streamText } from './instrument.js';
import { estimate } from './prices.js';
import { LLMCall, type Message, ToolCall, Usage } from './types.js';

/** Minimal shape of the bits of the OTel span we touch (typed defensively — OTel is optional). */
interface OTelSpan {
  setAttribute(key: string, value: unknown): void;
  end(): void;
}

function loadTracer(): { startSpan(name: string): OTelSpan } | null {
  try {
    const req = createRequire(import.meta.url);
    // Loaded synchronously (mirrors Python's `from opentelemetry import trace`); no-op if absent.
    const otel = req('@opentelemetry/api') as {
      trace: { getTracer(name: string): { startSpan(name: string): OTelSpan } };
    };
    return otel.trace.getTracer('cendor.core');
  } catch {
    return null; // OpenTelemetry not installed — stay in no-op mode
  }
}

export interface SpanOptions {
  /** Optional system name, recorded as `gen_ai.system`. */
  provider?: string;
  /** Extra span attributes, set verbatim. */
  [key: string]: unknown;
}

/**
 * Run `fn` inside a `gen_ai` span named `chat {model}`, setting `gen_ai.request.model`,
 * `gen_ai.system` (= provider), and any extra attributes. The span is passed to `fn`, or **`null`
 * when `@opentelemetry/api` is absent** — in which case `fn(null)` still runs and its value is
 * returned (a no-op that never raises). The span is ended when `fn` returns (awaiting a returned
 * promise first). Callback form (a `@contextmanager` in Python); `ingest()` is the bus path.
 */
export function span<T>(model: string, opts: SpanOptions, fn: (span: OTelSpan | null) => T): T {
  const tracer = loadTracer();
  if (tracer === null) return fn(null);
  const { provider, ...attributes } = opts;
  const current = tracer.startSpan(`chat ${model}`);
  let ended = false;
  const end = (): void => {
    if (!ended) {
      ended = true;
      current.end();
    }
  };
  try {
    current.setAttribute('gen_ai.request.model', model);
    if (provider != null) current.setAttribute('gen_ai.system', provider);
    for (const [key, value] of Object.entries(attributes)) current.setAttribute(key, value);
    const result = fn(current);
    if (result != null && typeof (result as { then?: unknown }).then === 'function') {
      return (result as unknown as Promise<unknown>).then(
        (v) => {
          end();
          return v;
        },
        (e) => {
          end();
          throw e;
        },
      ) as unknown as T;
    }
    end();
    return result;
  } catch (e) {
    end();
    throw e;
  }
}

export interface IngestOptions {
  messages?: Message[];
  emit?: boolean;
}

function uuidHex(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '');
}

function attr(bag: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = bag[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/**
 * Turn OpenTelemetry GenAI (`gen_ai.*`) span attributes into a normalized `LLMCall`. This is the
 * managed-runtime capture path: when a server-side runtime owns the loop and only emits `gen_ai.*`
 * spans, feed those attributes here and the call joins the same event bus — so `@cendor/tokenguard`
 * and `@cendor/acttrace` consume it exactly as if it had been instrumented locally. No OTel dependency.
 *
 * Reads `gen_ai.request.model` (or `response.model`), `gen_ai.system`, and the usage attributes;
 * prices it via `@cendor/core` `prices` (missing price → `cost = null`); emits on the bus unless
 * `emit: false`. Returns the call.
 */
export function ingest(attributes: Record<string, unknown>, opts: IngestOptions = {}): LLMCall {
  const { messages, emit: doEmit = true } = opts;
  const model = String(attr(attributes, 'gen_ai.request.model', 'gen_ai.response.model') ?? '');
  const provider = String(attributes['gen_ai.system'] ?? '');
  const inp = attr(attributes, 'gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens');
  const out = attr(attributes, 'gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens') ?? 0;
  // Cached / reasoning breakdowns, if the runtime reports them (a couple of common spellings).
  const cached =
    attr(attributes, 'gen_ai.usage.cached_tokens', 'gen_ai.usage.cache_read_input_tokens') ?? 0;
  const reasoning = attributes['gen_ai.usage.reasoning_tokens'] ?? 0;
  const usage =
    inp != null
      ? new Usage({
          inputTokens: Math.trunc(Number(inp)),
          outputTokens: Math.trunc(Number(out)),
          cachedTokens: Math.trunc(Number(cached)),
          reasoningTokens: Math.trunc(Number(reasoning)),
        })
      : null;
  const call = new LLMCall({
    id: uuidHex(),
    provider,
    model,
    messages: messages ?? [],
    usage,
    ts: new Date(),
  });
  call.metadata.source = 'otel';
  if (usage !== null) {
    try {
      call.cost = estimate(call.model, usage.inputTokens, {
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
      });
    } catch {
      call.cost = null;
    }
  }
  if (doEmit) emit(call);
  return call;
}

// =================================================================================================
// Content capture (G17) — opt-in, OFF by default. Prompts/responses/thinking/tool values ride the
// OpenTelemetry GenAI content span attributes. Nothing here touches the acttrace chain (rule 6).
// =================================================================================================

/** Semconv content attribute keys (JSON-string values). */
export const GENAI_INPUT_MESSAGES = 'gen_ai.input.messages';
export const GENAI_OUTPUT_MESSAGES = 'gen_ai.output.messages';
export const GENAI_SYSTEM_INSTRUCTIONS = 'gen_ai.system_instructions';
/** Cendor tool-content lane on `execute_tool` spans (semconv has none for arg/result *values*). */
export const CENDOR_TOOL_ARGUMENTS = 'cendor.tool.arguments';
export const CENDOR_TOOL_RESULT = 'cendor.tool.result';

const CAPTURE_ENV = 'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT';
const ENABLING = new Set(['true', 'span_only', 'span_and_event']);
/** Appended to a content string when the per-attribute byte cap truncates it. */
export const TRUNCATION_MARKER = '…[cendor: content truncated]';

export type CaptureMode = 'off' | 'span';
export interface CaptureConfig {
  mode: CaptureMode;
  mask?: ((messages: Message[]) => Message[]) | null;
  maxBytes: number;
}

let captureCfg: CaptureConfig = { mode: 'off', mask: null, maxBytes: 8192 };

export interface CaptureOptions {
  mode?: CaptureMode;
  mask?: (messages: Message[]) => Message[];
  maxBytes?: number;
}

/**
 * Enable opt-in content capture on `gen_ai.*` span attributes (OFF by default).
 *
 * Content — system prompts, user/assistant messages, thinking text, tool arg/result values — then
 * rides the standard semconv span attributes and lands wherever your OTLP goes (Cendor Monitor,
 * Langfuse, Braintrust — same wire). It is **never** written to the acttrace evidence chain or its
 * mirror (rule 6). Pair with a `mask` to scrub before export and `maxBytes` to cap each attribute (a
 * truncation marker is appended when hit). A mask that throws fails closed (content withheld).
 *
 * @example
 * import { otel } from '@cendor/core';
 * otel.captureContent({ maxBytes: 4096 }); // opt in; then your spans carry masked content
 */
export function captureContent(opts: CaptureOptions = {}): void {
  const mode = opts.mode ?? 'span';
  if (mode !== 'off' && mode !== 'span') throw new Error(`mode must be 'off' or 'span'`);
  captureCfg = { mode, mask: opts.mask ?? null, maxBytes: opts.maxBytes ?? 8192 };
}

/** The effective capture config: explicit code config wins; else the standard env var may enable it. */
export function contentCapture(): CaptureConfig {
  if (captureCfg.mode !== 'off') return captureCfg;
  const env = String(process.env[CAPTURE_ENV] ?? '')
    .trim()
    .toLowerCase();
  if (ENABLING.has(env)) return { ...captureCfg, mode: 'span' };
  return captureCfg;
}

/** Test helper: restore the default (off) capture config. */
export function resetCapture(): void {
  captureCfg = { mode: 'off', mask: null, maxBytes: 8192 };
}

function encode(cfg: CaptureConfig, messages: Message[]): string | null {
  if (!messages || messages.length === 0) return null;
  let msgs: unknown = messages;
  if (cfg.mask) {
    try {
      const safe = messages.map((m) => ({ ...m }));
      const masked = cfg.mask(safe);
      msgs = masked ?? messages;
    } catch {
      return JSON.stringify('[cendor: mask raised; content withheld]');
    }
  }
  let text: string;
  try {
    text = JSON.stringify(msgs);
  } catch {
    text = JSON.stringify(String(msgs));
  }
  const raw = Buffer.from(text, 'utf-8');
  if (raw.length > cfg.maxBytes) {
    text = raw.subarray(0, cfg.maxBytes).toString('utf-8') + TRUNCATION_MARKER;
  }
  return text;
}

export interface ContentAttrsInput {
  system?: unknown;
  inputMessages?: Message[] | null;
  outputMessages?: Message[] | null;
}

/**
 * Build the `gen_ai.*` content span attributes for the active capture config, or `{}` when capture
 * is off. `system` may be a string (from an agent's instructions) or a message list.
 */
export function contentAttrs(input: ContentAttrsInput): Record<string, string> {
  const cfg = contentCapture();
  if (cfg.mode === 'off') return {};
  const out: Record<string, string> = {};
  if (input.system) {
    const sysMsgs = Array.isArray(input.system)
      ? (input.system as Message[])
      : [{ role: 'system', content: String(input.system) }];
    const v = encode(cfg, sysMsgs);
    if (v !== null) out[GENAI_SYSTEM_INSTRUCTIONS] = v;
  }
  if (input.inputMessages?.length) {
    const v = encode(cfg, input.inputMessages);
    if (v !== null) out[GENAI_INPUT_MESSAGES] = v;
  }
  if (input.outputMessages?.length) {
    const v = encode(cfg, input.outputMessages);
    if (v !== null) out[GENAI_OUTPUT_MESSAGES] = v;
  }
  return out;
}

/** Content span attributes for an `execute_tool` span (arg/result values), or `{}` when off. */
export function toolContentAttrs(args?: unknown, result?: unknown): Record<string, string> {
  const cfg = contentCapture();
  if (cfg.mode === 'off') return {};
  const out: Record<string, string> = {};
  if (args !== undefined && args !== null) {
    const v = encode(cfg, [{ role: 'tool', content: args }]);
    if (v !== null) out[CENDOR_TOOL_ARGUMENTS] = v;
  }
  if (result !== undefined && result !== null) {
    const v = encode(cfg, [{ role: 'tool', content: result }]);
    if (v !== null) out[CENDOR_TOOL_RESULT] = v;
  }
  return out;
}

function g(obj: unknown, key: string): unknown {
  return obj == null ? undefined : (obj as Record<string, unknown>)[key];
}

function flattenText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => String(g(p, 'text') ?? '')).join('');
  return content == null ? '' : String(content);
}

function assistantMsg(texts: string[], thinks: string[]): Message[] {
  const parts: Array<Record<string, unknown>> = [];
  for (const t of thinks) if (t) parts.push({ type: 'thinking', content: t });
  for (const t of texts) if (t) parts.push({ type: 'text', content: t });
  return parts.length ? [{ role: 'assistant', parts }] : [];
}

/**
 * Best-effort assistant output messages (text + thinking parts, G18) parsed from a completed call's
 * raw provider response, per provider. Content only — returns `[]` if unavailable. Thinking is
 * surfaced as a `{ type: 'thinking' }` part (the semconv part shape for reasoning is Development).
 */
export function responseMessages(call: LLMCall): Message[] {
  const meta = call.metadata ?? {};
  const resp = meta.response;
  if (resp == null) return [];
  const provider = call.provider ?? '';
  try {
    if (meta.streamed && Array.isArray(resp)) {
      const text = resp.map((ch) => streamText(ch, internalProvider(call, provider))).join('');
      return assistantMsg([text], []);
    }
    const texts: string[] = [];
    const thinks: string[] = [];
    if (provider === 'anthropic') {
      for (const b of (g(resp, 'content') as unknown[]) ?? []) {
        const bt = g(b, 'type');
        if (bt === 'text') texts.push(String(g(b, 'text') ?? ''));
        else if (bt === 'thinking') thinks.push(String(g(b, 'thinking') ?? ''));
      }
    } else if (provider === 'google') {
      const cands = (g(resp, 'candidates') as unknown[]) ?? [];
      for (const c of cands.slice(0, 1)) {
        for (const p of (g(g(c, 'content'), 'parts') as unknown[]) ?? []) {
          const txt = g(p, 'text');
          if (!txt) continue;
          (g(p, 'thought') ? thinks : texts).push(String(txt));
        }
      }
    } else if (provider === 'ollama') {
      const m = g(resp, 'message');
      const c = g(m, 'content');
      if (c) texts.push(String(c));
      const th = g(m, 'thinking');
      if (th) thinks.push(String(th));
    } else if (provider === 'bedrock') {
      const content = (g(g(g(resp, 'output'), 'message'), 'content') as unknown[]) ?? [];
      for (const b of content) {
        if (g(b, 'text')) texts.push(String(g(b, 'text')));
        const rc = g(b, 'reasoningContent');
        if (rc) {
          const rt = g(g(rc, 'reasoningText'), 'text');
          if (rt) thinks.push(String(rt));
        }
      }
    } else {
      const choices = g(resp, 'choices') as unknown[] | undefined;
      if (choices?.length) {
        const msg = g(choices[0], 'message');
        texts.push(flattenText(g(msg, 'content')));
        const rc = g(msg, 'reasoning_content');
        if (rc) thinks.push(String(rc));
      } else {
        const ot = g(resp, 'output_text');
        if (ot) texts.push(String(ot));
        for (const item of (g(resp, 'output') as unknown[]) ?? []) {
          const itype = g(item, 'type');
          if (itype === 'reasoning') {
            for (const s of (g(item, 'summary') as unknown[]) ?? []) {
              const st = g(s, 'text');
              if (st) thinks.push(String(st));
            }
          } else if (itype === 'message' && !ot) {
            for (const part of (g(item, 'content') as unknown[]) ?? []) {
              const pt = g(part, 'text');
              if (pt) texts.push(String(pt));
            }
          }
        }
      }
    }
    return assistantMsg(texts, thinks);
  } catch {
    return [];
  }
}

function internalProvider(call: LLMCall, pub: string): string {
  if (pub === 'openai') {
    const resp = call.metadata?.response;
    if (Array.isArray(resp) && resp.length && g(resp[0], 'type')) return 'openai_responses';
  }
  return pub;
}

// =================================================================================================
// G20 — bus→span emitter. Opt-in subscriber that turns LLMCall/ToolCall bus events into semconv
// spans, so a libs-only app (no SDK) lights up a trace-based monitor. Honors content capture.
// =================================================================================================

/** Nonzero while an SDK `liveSpans` context is open — the emitter defers to it (no double spans). */
let liveSpanDepth = 0;

/** Called by the SDK when a `liveSpans` context opens, so the G20 emitter stands down. */
export function enterLiveSpans(): void {
  liveSpanDepth += 1;
}
/** Called by the SDK when a `liveSpans` context closes. */
export function exitLiveSpans(): void {
  liveSpanDepth = Math.max(0, liveSpanDepth - 1);
}

interface RichSpan {
  setAttribute(key: string, value: unknown): void;
  end(endTime?: number): void;
}
interface RichTracer {
  startSpan(name: string, options?: { startTime?: number }): RichSpan;
}

function loadRichTracer(): RichTracer | null {
  try {
    const req = createRequire(import.meta.url);
    const otel = req('@opentelemetry/api') as {
      trace: { getTracer(name: string): RichTracer };
    };
    return otel.trace.getTracer('cendor.core');
  } catch {
    return null;
  }
}

/**
 * Opt-in: emit a `chat`/`execute_tool` semconv span per `LLMCall`/`ToolCall` bus event.
 *
 * A libs-only app (using `instrument()` but not the SDK) can wire this once to light up any
 * trace-based monitor without writing manual spans. Honors content capture (G17). When an SDK
 * `liveSpans` context is active it defers to it (no double spans); otherwise it is mutually
 * exclusive with the SDK's `spanTree`/`liveSpans` — don't wire both for the same run. Returns a
 * disposer that unsubscribes it. No-op if `@opentelemetry/api` is absent.
 */
export function useSpanEmitter(tracer?: RichTracer | null): () => void {
  const tr = tracer ?? loadRichTracer();
  if (tr === null) return () => {};
  const onEvent = (ev: unknown): void => {
    if (liveSpanDepth > 0) return;
    if (ev instanceof LLMCall) emitLlmSpan(tr, ev);
    else if (ev instanceof ToolCall) emitToolSpan(tr, ev);
  };
  subscribe(onEvent);
  return () => unsubscribe(onEvent);
}

function emitLlmSpan(tr: RichTracer, call: LLMCall): void {
  const end = Date.now();
  const span = tr.startSpan(`chat ${call.model}`, { startTime: end - (call.latencyMs ?? 0) });
  try {
    span.setAttribute('gen_ai.operation.name', 'chat');
    if (call.provider) span.setAttribute('gen_ai.system', call.provider);
    span.setAttribute('gen_ai.request.model', call.model);
    const u = call.usage;
    if (u) {
      span.setAttribute('gen_ai.usage.input_tokens', u.inputTokens);
      span.setAttribute('gen_ai.usage.output_tokens', u.outputTokens);
      if (u.reasoningTokens) span.setAttribute('gen_ai.usage.reasoning_tokens', u.reasoningTokens);
    }
    if (call.cost != null) span.setAttribute('gen_ai.usage.cost', String(call.cost.amount));
    if (call.latencyMs != null) span.setAttribute('cendor.latency_ms', call.latencyMs);
    const ttft = call.metadata?.ttft_ms;
    if (ttft != null) span.setAttribute('cendor.ttft_ms', ttft);
    if (call.metadata?.streamed) span.setAttribute('cendor.streamed', true);
    // Truth = the product: mark streamed token counts recovered by offline estimate (not the
    // provider's billed figure) so a monitor renders them "est.". String 'true', only when set.
    if (call.metadata?.usage_estimated) span.setAttribute('cendor.usage_estimated', 'true');
    if (call.metadata?.replayed) span.setAttribute('cendor.replayed', true);
    if (call.traceId) span.setAttribute('cendor.trace_id', call.traceId);
    const attrs = contentAttrs({
      inputMessages: call.messages,
      outputMessages: responseMessages(call),
    });
    for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
  } finally {
    span.end(end);
  }
}

function emitToolSpan(tr: RichTracer, tc: ToolCall): void {
  const end = Date.now();
  const span = tr.startSpan(`execute_tool ${tc.name}`, { startTime: end - (tc.latencyMs ?? 0) });
  try {
    span.setAttribute('gen_ai.operation.name', 'execute_tool');
    span.setAttribute('gen_ai.tool.name', tc.name);
    if (tc.latencyMs != null) span.setAttribute('cendor.latency_ms', tc.latencyMs);
    if (tc.traceId) span.setAttribute('cendor.trace_id', tc.traceId);
    const attrs = toolContentAttrs(tc.arguments, tc.result);
    for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
  } finally {
    span.end(end);
  }
}
