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
import { ambientAttrs, applyAmbient } from './ambient.js';
import { emit, subscribe, unsubscribe } from './bus.js';
import { streamText } from './instrument.js';
import { estimate } from './prices.js';
import { currentTraceId } from './trace.js';
import { LLMCall, type Message, ToolCall, Usage } from './types.js';

/** Minimal shape of the bits of the OTel span we touch (typed defensively — OTel is optional). */
interface OTelSpan {
  setAttribute(key: string, value: unknown): void;
  end(): void;
}

/** The `@opentelemetry/api` module, loaded **once**.
 *
 * `createRequire()` + `require()` costs ~90 µs, so doing it per call made the provider predicate far
 * too expensive to run per bus event (measured). The module identity can never change within a
 * process, and a package cannot appear mid-run, so both the hit and the miss are cached forever.
 * `undefined` = not tried yet, `null` = not installed. */
type OTelApi = {
  trace: {
    getTracer(name: string): OTelTracer & RichTracer;
    getTracerProvider(): { getDelegate?: () => unknown };
  };
};
let apiCache: OTelApi | null | undefined;

function loadOTelApi(): OTelApi | null {
  if (apiCache !== undefined) return apiCache;
  try {
    // Loaded synchronously (mirrors Python's `from opentelemetry import trace`); no-op if absent.
    apiCache = createRequire(import.meta.url)('@opentelemetry/api') as OTelApi;
  } catch {
    apiCache = null; // OpenTelemetry not installed — stay in no-op mode
  }
  return apiCache;
}

/** @internal Test helper: forget the memoized `@opentelemetry/api` handle. */
export function _resetOTelApiCache(): void {
  apiCache = undefined;
}

/** A tracer that can run a callback with the new span installed as the active context span. */
interface OTelTracer {
  startActiveSpan<T>(name: string, fn: (span: OTelSpan) => T): T;
}

function loadTracer(): OTelTracer | null {
  return loadOTelApi()?.trace.getTracer('cendor.core') ?? null;
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
 *
 * The span is made the **active context span** for the duration of `fn` (via `startActiveSpan`,
 * parity with Python's `start_as_current_span`), so downstream reads of the active span — e.g.
 * `@cendor/acttrace`'s audit-entry correlation — see it and can stamp its trace id. This needs a
 * registered OTel context manager (installed by `NodeSDK` / `NodeTracerProvider.register()`); when
 * none is registered the callback still runs and the span is simply not propagated (today's
 * behavior), never an error.
 */
export function span<T>(model: string, opts: SpanOptions, fn: (span: OTelSpan | null) => T): T {
  const tracer = loadTracer();
  if (tracer === null) return fn(null);
  const { provider, ...attributes } = opts;
  return tracer.startActiveSpan(`chat ${model}`, (current: OTelSpan): T => {
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
  });
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
  _armAutoTelemetry(); // a managed-runtime app never calls instrument() — this is its adoption point
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
    // GLR-8: stamp the ambient trace id at construction so an ingested call joins the run it
    // belongs to (previously left '' → orphaned from every run downstream).
    traceId: currentTraceId(),
    ts: new Date(),
  });
  call.metadata.source = 'otel';
  applyAmbient(call);
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

// ---------------------------------------------------------------- live-spans latch (P1 / W0.5)
// Two mechanisms, because the public API has two shapes:
//
//  * `enterLiveSpans()` / `exitLiveSpans()` are callback-LESS (a `liveSpans()` handle is closed by
//    hand), so they move a module counter: while a manual scope is open the emitter stands down
//    process-wide. That is the historical behaviour, and the shape of the API forces it.
//  * `_withLiveSpansDepth(fn)` is the SCOPED form the SDK's automatic run scope uses. It raises the
//    depth inside an `AsyncLocalStorage.run()`, which is correctly scoped on **every** supported Node:
//    concurrent automatic runs never suppress each other's flat spans, and no depth survives a run.
//
// Why not `enterWith` for both: measured 2026-07-25 on node 20.20 / 22.23 (legacy AsyncLocalStorage),
// an `enterWith` LEAKS into concurrent flows and is NOT restored by the matching exit — a scope that
// closed would leave the emitter suppressed for the rest of the process. Only node >= 24
// (AsyncContextFrame) scopes `enterWith` the way this code would need. `run()` is correct on all of
// them, so the scoped path uses only that.
interface DepthStore {
  getStore(): number | undefined;
  run<T>(value: number, fn: () => T): T;
}

const liveSpanStore: DepthStore | null = (() => {
  try {
    const req = createRequire(import.meta.url);
    const { AsyncLocalStorage } = req('node:async_hooks') as {
      AsyncLocalStorage: new () => DepthStore;
    };
    return new AsyncLocalStorage();
  } catch {
    return null; // non-Node runtime — the module counter is then the only mechanism
  }
})();
let liveSpanDepthCounter = 0;

function liveSpanDepth(): number {
  return liveSpanDepthCounter + (liveSpanStore?.getStore() ?? 0);
}

/**
 * Run `fn` with the live-spans depth raised for `fn` and everything it starts — and nothing else.
 *
 * The scoped counterpart of {@link enterLiveSpans}, used by the SDK's automatic run scope. Correct on
 * every supported Node (it uses `AsyncLocalStorage.run`, never `enterWith`), so two concurrent
 * automatic runs cannot suppress each other's flat spans and no depth survives the run.
 *
 * @internal
 */
export function _withLiveSpansDepth<T>(fn: () => T): T {
  if (!liveSpanStore) {
    liveSpanDepthCounter += 1;
    try {
      return fn();
    } finally {
      liveSpanDepthCounter = Math.max(0, liveSpanDepthCounter - 1);
    }
  }
  return liveSpanStore.run((liveSpanStore.getStore() ?? 0) + 1, fn);
}

/**
 * Called by the SDK when a `liveSpans` context opens, so the G20 emitter stands down.
 *
 * **Process-wide while the handle is open** — a hand-closed handle has no scope to bind to. The SDK's
 * automatic run scope uses the scoped form instead, so prefer that; with a manual handle, keep its
 * lifetime short and always `close()` it in a `finally`.
 */
export function enterLiveSpans(): void {
  liveSpanDepthCounter += 1;
}

/** Called by the SDK when a `liveSpans` context closes. */
export function exitLiveSpans(): void {
  liveSpanDepthCounter = Math.max(0, liveSpanDepthCounter - 1);
}

/**
 * True while a `liveSpans` scope is open — a manual one anywhere in the process, or an automatic one
 * in this async context.
 *
 * The SDK reads it to decide whether to open its **automatic** run scope: an explicit `liveSpans()`
 * the user opened always wins, so a run is never wrapped twice.
 *
 * @example
 * import { otel } from '@cendor/core';
 * otel.liveSpansActive(); // false
 */
export function liveSpansActive(): boolean {
  return liveSpanDepth() > 0;
}

/**
 * Run `fn` with the ambient live-spans depth pinned, so a nested scope cannot leak past `fn`.
 *
 * @internal **No caller today.** It was added in 0.14.1 for the SDK's automatic run scope, which now
 * uses {@link _withLiveSpansDepth} instead (`@cendor/sdk` ≥ 0.23.2 also drives its stream generator
 * inside that store, so the stream path does not need this either). Kept because it is exported —
 * removing it would be a breaking change for no gain — but do not reach for it: prefer
 * `_withLiveSpansDepth`, which RAISES the depth for `fn` rather than merely pinning it.
 */
export function _isolateLiveSpans<T>(fn: () => T): T {
  if (!liveSpanStore) return fn();
  return liveSpanStore.run(liveSpanStore.getStore() ?? 0, fn);
}

interface RichSpan {
  setAttribute(key: string, value: unknown): void;
  end(endTime?: number): void;
}
interface RichTracer {
  startSpan(name: string, options?: { startTime?: number }): RichSpan;
}

function loadRichTracer(): RichTracer | null {
  // The tracer itself is a ProxyTracer that upgrades when the app registers its provider (probed), so
  // holding one is safe — unlike the metrics API, which has no proxy (see @cendor/tokenguard's sink).
  return loadOTelApi()?.trace.getTracer('cendor.core') ?? null;
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
  const onEvent = (ev: unknown): void => renderBusEvent(tr, ev);
  manualEmitters += 1;
  detachAutoEmitter(); // manual wins — exactly one emitter, ever
  subscribe(onEvent);
  debugNote('span emitter attached (manual)');
  return () => {
    unsubscribe(onEvent);
    manualEmitters = Math.max(0, manualEmitters - 1);
  };
}

/** Render one bus event as a span (the shared body of the manual + automatic emitters). */
function renderBusEvent(tr: RichTracer, ev: unknown): void {
  if (liveSpanDepth() > 0) return;
  if (ev instanceof LLMCall) emitLlmSpan(tr, ev);
  else if (ev instanceof ToolCall) emitToolSpan(tr, ev);
  else emitGovernanceSpan(tr, ev);
}

// =================================================================================================
// `trace()` as a REAL span (@cendor/core 0.16.0).
//
// `trace('id', fn)` used to stamp an ambient id onto every emitted `LLMCall`/`ToolCall` and nothing
// more. Every call inside therefore arrived as its **own root span**, i.e. its own trace: a scope
// around a chat call and a tool call produced TWO traces sharing one `cendor.traceId`. In a monitor
// that meant one logical unit of work rendered as two unrelated rows, its governance fanned out to
// both, and per-run governance counts doubled — while the console told users to reach for `trace()`
// for a hierarchy it could not produce.
//
// The scope now brackets its calls with a real span, so one scope is one trace. Boundaries, all
// deliberate: nothing is emitted with no OpenTelemetry / no configured provider / `CENDOR_TELEMETRY=off`;
// **no span inside an SDK run** (that run owns the trace, and a `cendor.core`-scoped span inside a
// `cendor.sdk` trace is a door leak for any consumer routing by scope — the calls attach either way);
// re-entrance is a no-op (one root per scope family); and `CENDOR_TRACE_SPAN=off` /
// `trace(id, fn, { span: false })` restores the pre-0.16 shape.
//
// Scope mechanics: `startActiveSpan` installs the span through `context.with`, which is
// `AsyncLocalStorage.run()`-based — **never** `enterWith`, which leaks into concurrent flows and is
// not restored on exit on node 20/22 (measured 2026-07-25).
// =================================================================================================

/** Turn the `trace()` parent span off without touching code. Default ON — the correct behaviour. */
export const TRACE_SPAN_ENV = 'CENDOR_TRACE_SPAN';

/** One open `trace()` scope's mutable state. Bound by `run()`, so concurrent scopes never share it. */
interface TraceScope {
  steps: number;
}
interface ScopeStore {
  getStore(): TraceScope | undefined;
  run<T>(value: TraceScope, fn: () => T): T;
}
const traceScopeStore: ScopeStore | null = (() => {
  try {
    const req = createRequire(import.meta.url);
    const { AsyncLocalStorage } = req('node:async_hooks') as {
      AsyncLocalStorage: new () => ScopeStore;
    };
    return new AsyncLocalStorage();
  } catch {
    return null; // non-Node runtime — no scope span, and the ambient id path is unaffected
  }
})();

/**
 * Whether {@link trace} opens a real parent span (default **true**).
 *
 * `CENDOR_TRACE_SPAN=off` restores the pre-0.16.0 shape (an ambient id, no parent span) for an app
 * whose backend groups by trace id today. `CENDOR_TELEMETRY=off` disables it too, like every other
 * Cendor emitter.
 *
 * @example
 * import { otel } from '@cendor/core';
 * otel.traceSpanEnabled(); // true unless CENDOR_TRACE_SPAN=off / CENDOR_TELEMETRY=off
 */
export function traceSpanEnabled(): boolean {
  const raw = env(TRACE_SPAN_ENV).toLowerCase();
  if (['off', '0', 'false', 'no'].includes(raw)) return false;
  if (!['', 'on', '1', 'true', 'yes', 'auto'].includes(raw)) {
    debugNote(
      `CENDOR_TRACE_SPAN=${JSON.stringify(raw)} is not 'on' or 'off' — treating it as 'on'`,
    );
  }
  return telemetryMode() !== 'off';
}

/** The next 1-based step ordinal inside the open `trace()` scope, or null when none is open. */
export function nextTraceStep(): number | null {
  const scope = traceScopeStore?.getStore();
  if (!scope) return null;
  scope.steps += 1;
  return scope.steps;
}

/**
 * Run `fn` inside the parent span of a {@link trace} scope. A plain `fn()` when there is nobody to
 * emit to, when an SDK `liveSpans` scope already owns the run's trace, or when a scope span is
 * already open in this context.
 *
 * @internal Called by `trace()`; not part of the app-facing surface.
 */
export function _withTraceSpan<T>(traceId: string, fn: () => T, span?: boolean): T {
  const want = span ?? traceSpanEnabled();
  if (!want || liveSpansActive() || traceScopeStore?.getStore() || !providerConfigured())
    return fn();
  const tracer = loadTracer();
  if (tracer === null || traceScopeStore === null) return fn();
  return traceScopeStore.run({ steps: 0 }, () =>
    tracer.startActiveSpan(`cendor.trace ${traceId}`, (parent) => {
      // `cendor.run.id` is the id the app chose; `cendor.scope` names what this span IS, so a consumer
      // can tell a grouped call scope from an SDK agent run without guessing.
      parent.setAttribute('cendor.run.id', String(traceId));
      parent.setAttribute('cendor.scope', 'trace');
      parent.setAttribute('cendor.operation.name', 'trace');
      const done = (): void => parent.end();
      let out: T;
      try {
        out = fn();
      } catch (err) {
        done();
        throw err;
      }
      if (out instanceof Promise) return out.finally(done) as unknown as T;
      done();
      return out;
    }),
  );
}

// =================================================================================================
// Option C (DR-2c) — governance ENFORCEMENT as ordinary telemetry.
//
// A telemetry user wants to see the decisions their stack made: a budget that blocked a call, a
// guardrail that tripped. Until now the only wire path for those was the *audit mirror*, so seeing
// them meant adopting the evidence library. Option C renders them as plain monitoring spans:
//
//   governance.budget_event · governance.guardrail_decision   (scope cendor.core / cendor.sdk)
//
// Deliberately **no `audit.*` vocabulary and no AuditLog involved** (rule 6): these are operational
// signals, and "audit" keeps meaning the hash-chained evidence file. While a real audit mirror is on
// the wire the ops renderings stand down, so nothing renders twice.
//
// Content: metadata only. The events' `reason` strings are NOT emitted — a guardrail's reason comes
// from the rule, and for `rules.llmJudge` from a judge *model* (free text that can paraphrase the
// payload; the URL rules embed the matched host), so it can carry input-derived text. The audit chain
// — an artifact the user explicitly declared — keeps carrying it; these default-on spans do not.
// =================================================================================================

/** How many live audit mirrors are on the wire (refcounted by `@cendor/acttrace`). */
let govMirrors = 0;

/**
 * Tell core that an audit mirror is (or is no longer) putting governance on the wire.
 *
 * Called by `@cendor/acttrace` when an `AuditLog` attaches or detaches a mirror that emits
 * OpenTelemetry spans. Refcounted, so several logs compose. While the count is above zero the Option C
 * `governance.*` spans stand down — the mirror is richer (chained, hashed, sequenced) and must win,
 * and an event must never render twice.
 */
export function governanceMirrored(on: boolean): void {
  govMirrors = Math.max(0, govMirrors + (on ? 1 : -1));
}

/** True while at least one audit mirror is putting governance on the wire. */
export function governanceMirrorActive(): boolean {
  return govMirrors > 0;
}

/** @internal Test helper: forget the mirror refcount. */
export function _resetGovernanceMirrors(): void {
  govMirrors = 0;
}

/**
 * Map an enforcement event to `[span name, cendor.gov.* attrs]`, or `null` if it isn't one.
 *
 * Duck-typed exactly like `@cendor/acttrace`'s chaining (core imports no tool — rule 2). Only the
 * factual fields: what acted, at which stage, with which numbers — plus **who** acted (S4).
 *
 * The actor comes from the event's own field when it has one (a guardrail decision does), and
 * otherwise from core's ambient registry — which is how a budget block, an event with no agent field
 * at all, stops being an anonymous row. Measured 2026-07-26: 13 of 386 governance rows named their
 * agent, so "which agent was blocked" could only be inferred from step ordering.
 *
 * Why this does not breach the Option-C rule that a default-on span carries no input-derived text: an
 * agent NAME is app-supplied configuration — the string passed to `new Agent({ name })` or stamped by
 * an ambient provider. It cannot paraphrase a payload the way a guardrail `reason` can, which is why
 * `reason` stays off these spans and a name does not.
 *
 * @internal also used by `@cendor/sdk` to render the same decision as a child of its run root.
 */
export function _govAttrs(ev: unknown): [string, Record<string, unknown>] | null {
  if (ev == null || typeof ev !== 'object') return null;
  const e = ev as Record<string, unknown>;
  const has = (k: string): boolean => k in e;
  const amb = ambientAttrs();
  const actor = (): Record<string, unknown> => ({
    'cendor.gov.agent': e.agent || amb.agent || null,
    'cendor.gov.agent_id': amb.agent_id || null,
  });
  // tokenguard BudgetEvent
  if (has('action') && has('projectedUsd') && has('capUsd')) {
    return [
      'governance.budget_event',
      {
        'cendor.gov.type': 'budget_event',
        'cendor.gov.action': String(e.action ?? ''),
        'cendor.gov.budget': e.name ?? null,
        'cendor.gov.scope': e.scope ?? null,
        'cendor.gov.model': e.model || null,
        'cendor.gov.to_model': e.toModel ?? null,
        'cendor.gov.projected_usd': e.projectedUsd == null ? null : String(e.projectedUsd),
        'cendor.gov.cap_usd': e.capUsd == null ? null : String(e.capUsd),
        'cendor.gov.projected_tokens': e.projectedTokens ?? null,
        'cendor.gov.cap_tokens': e.capTokens ?? null,
        ...actor(),
      },
    ];
  }
  // guardrails GuardrailDecision
  if (has('guardrail') && has('stage') && has('action')) {
    return [
      'governance.guardrail_decision',
      {
        'cendor.gov.type': 'guardrail_decision',
        'cendor.gov.guardrail': String(e.guardrail ?? ''),
        'cendor.gov.stage': String(e.stage ?? ''),
        'cendor.gov.action': String(e.action ?? ''),
        'cendor.gov.tool': e.tool || null,
        ...actor(),
      },
    ];
  }
  return null;
}

/** Render an enforcement event as a `governance.*` span (Option C). Zero-duration: a decision is a
 * point in time, not an operation with a span of work. */
function emitGovernanceSpan(tr: RichTracer, ev: unknown): void {
  if (governanceMirrorActive()) return; // the audit mirror is on the wire — it wins
  const mapped = _govAttrs(ev);
  if (mapped === null) return;
  const [name, attrs] = mapped;
  const now = Date.now();
  const span = tr.startSpan(name, { startTime: now });
  try {
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== null && value !== undefined) span.setAttribute(key, value);
    }
    const traceId = (ev as { traceId?: string }).traceId;
    // The monitor joins this to the run row exactly like a chat span's cendor.trace_id.
    if (traceId) span.setAttribute('cendor.trace_id', traceId);
  } finally {
    span.end(now);
  }
}

// =================================================================================================
// The telemetry switch (DR-1 / DR-6) — "it just flows".
//
// Cendor emits into the OpenTelemetry provider **your app configured**; it has no endpoint, no
// exporter and no collector of its own. So when OTel is installed AND a real (non-default) global
// provider exists, emitting is the useful default — the posture every OTel instrumentation library
// takes. `CENDOR_TELEMETRY=off` turns all of it off, process-wide, with no code change.
//
// Nothing here is identity: the app name stays the OTel resource's `service.name`
// (`OTEL_SERVICE_NAME`), and there is no Cendor identity env var.
// =================================================================================================

/** The one switch: `off` disables every Cendor-side emitter; unset/`auto` means "emit when a provider
 * is configured". */
export const TELEMETRY_ENV = 'CENDOR_TELEMETRY';
/** Set to `1` for a one-shot stderr line describing what was detected and wired. */
export const DEBUG_ENV = 'CENDOR_DEBUG_TELEMETRY';

const debugSaid = new Set<string>();

function env(name: string): string {
  // `process` may not exist on some edge runtimes — the switch simply reads as unset there.
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
      name
    ]?.trim() ?? ''
  );
}

/**
 * The effective telemetry mode from `CENDOR_TELEMETRY`: `'auto'` (default) or `'off'`.
 *
 * `auto` means *emit when the app has configured an OpenTelemetry provider* (see
 * {@link providerConfigured}). `off` disables every Cendor-side emitter — the span emitter, the spend
 * tap, and the audit mirror's auto-attach — without touching your code. An unrecognised value is
 * treated as `auto` (noted once under `CENDOR_DEBUG_TELEMETRY=1`), because a typo must never silently
 * disable telemetry.
 *
 * @example
 * import { otel } from '@cendor/core';
 * otel.telemetryMode(); // 'auto' unless CENDOR_TELEMETRY=off
 */
export function telemetryMode(): 'auto' | 'off' {
  const raw = env(TELEMETRY_ENV).toLowerCase();
  if (raw === 'off') return 'off';
  if (raw !== '' && raw !== 'auto') {
    debugNote(
      `CENDOR_TELEMETRY=${JSON.stringify(raw)} is not 'auto' or 'off' — treating it as 'auto'`,
    );
  }
  return 'auto';
}

function isNoopProvider(x: unknown): boolean {
  const name = (x as { constructor?: { name?: string } })?.constructor?.name ?? '';
  return x == null || /noop/i.test(name);
}

/**
 * True when the app has registered a real (non-default) global OpenTelemetry tracer provider.
 *
 * This is the honest signal that *somebody is listening*: the API always hands back a
 * `ProxyTracerProvider`, whose delegate is a no-op until the app's one-time OTel setup runs. It never
 * inspects exporters or endpoints — Cendor does not care where your spans go. False when
 * `@opentelemetry/api` is not installed.
 *
 * @example
 * import { otel } from '@cendor/core';
 * otel.providerConfigured(); // false until your app configures OTel
 */
export function providerConfigured(): boolean {
  const api = loadOTelApi();
  if (api === null) return false;
  const provider = api.trace.getTracerProvider();
  const delegate = typeof provider.getDelegate === 'function' ? provider.getDelegate() : provider;
  return !isNoopProvider(delegate);
}

/** One-shot stderr note, only under `CENDOR_DEBUG_TELEMETRY=1`. Never warns by default: the silent
 * no-op is load-bearing for local-first (an offline app must not be nagged). */
function debugNote(message: string): void {
  if (!['1', 'true', 'TRUE', 'yes'].includes(env(DEBUG_ENV))) return;
  if (debugSaid.has(message)) return;
  debugSaid.add(message);
  const p = (globalThis as { process?: { stderr?: { write(s: string): void } } }).process;
  p?.stderr?.write(`cendor telemetry: ${message}\n`);
}

function otelImportable(): boolean {
  return loadOTelApi() !== null;
}

// ------------------------------------------------------------------ automatic attach (DR-1 = "auto")
// One subscription, made the first time the app adopts a capture path (`instrument()` / `ingest()`)
// and only when `@opentelemetry/api` is importable. It stays dormant — re-checking the cheap provider
// predicate per event (~30 ns, measured) — until the app's provider appears, then latches and renders.
// So attach order never matters, a provider configured after the first call is still caught, and an app
// that never configures OTel pays a predicate check and nothing else.
let autoEmitter: ((ev: unknown) => void) | null = null;
let autoReady = false; // true once a real provider was seen (the latch)
let autoTracer: RichTracer | null = null; // the ProxyTracer, held after the first render
let manualEmitters = 0; // >0 ⇒ the user wired their own; the auto path stands down

function autoOnEvent(ev: unknown): void {
  if (manualEmitters) return;
  if (telemetryMode() === 'off') return; // read per event: `off` applies even if exported late
  if (!autoReady) {
    if (!providerConfigured()) return;
    autoReady = true;
    debugNote('mode=auto, provider=detected, emitter=attached');
  }
  if (autoTracer === null) autoTracer = loadRichTracer();
  if (autoTracer !== null) renderBusEvent(autoTracer, ev);
}

/** @internal Called from the capture entry points (`instrument()`, `ingest()`). Idempotent + cheap. */
export function _armAutoTelemetry(): void {
  if (autoEmitter !== null || manualEmitters) return;
  if (telemetryMode() === 'off') return;
  // Local-first rail: with `@opentelemetry/api` absent nothing is subscribed at all — the bus keeps
  // exactly the subscribers it had, and behaviour is byte-identical to a pre-switch release.
  if (!otelImportable()) return;
  autoEmitter = autoOnEvent;
  subscribe(autoOnEvent);
  debugNote(providerConfigured() ? 'armed' : 'armed (mode=auto); waiting for a provider');
}

function detachAutoEmitter(): void {
  if (autoEmitter === null) return;
  unsubscribe(autoEmitter);
  autoEmitter = null;
}

/** @internal Test helper: forget the automatic subscription + its latch. */
export function _resetAutoTelemetry(): void {
  detachAutoEmitter();
  autoReady = false;
  autoTracer = null;
  manualEmitters = 0;
  debugSaid.clear();
}

/**
 * What the automatic path currently thinks — for diagnostics (`doctor`) and tests.
 *
 * @example
 * import { otel } from '@cendor/core';
 * otel.autoTelemetryState(); // { mode: 'auto', otel: true, provider: true, armed: true, … }
 */
export function autoTelemetryState(): {
  mode: 'auto' | 'off';
  otel: boolean;
  provider: boolean;
  armed: boolean;
  emitting: boolean;
  manual: number;
} {
  return {
    mode: telemetryMode(),
    otel: otelImportable(),
    provider: providerConfigured(),
    armed: autoEmitter !== null,
    emitting: autoReady && !manualEmitters,
    manual: manualEmitters,
  };
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
    // 0.16.0: inside a `trace()` scope this span is a CHILD step of the scope's parent span, so it
    // carries a 1-based ordinal exactly like an SDK run's steps do — a grouped scope reads in order
    // instead of by timestamp luck.
    const step = nextTraceStep();
    if (step !== null) span.setAttribute('cendor.step', step);
    // GLR-10 (D2=YES): a libs-only app can self-identify an agent via an ambient provider (or the
    // LangChain handler stamps a node/chain name — GLR-11a). Surface it on the standard semconv
    // attribute so a trace-based monitor shows it; core invents nothing — only what was stamped.
    const agent = call.metadata?.agent;
    if (typeof agent === 'string' && agent) span.setAttribute('gen_ai.agent.name', agent);
    // W4/§6.1: the semconv sibling — an agent's stable IDENTITY, not its label. A name collides
    // across apps and a rename loses history; an id does neither. Emitted ONLY when something stamped
    // one (a framework adapter that owns a real id, or `new Agent({ id })` in the SDK). Absent, the
    // attribute is omitted — never hashed, never placeholdered: no invented identity.
    const agentId = call.metadata?.agent_id;
    if (typeof agentId === 'string' && agentId) span.setAttribute('gen_ai.agent.id', agentId);
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
    const toolStep = nextTraceStep();
    if (toolStep !== null) span.setAttribute('cendor.step', toolStep);
    const attrs = toolContentAttrs(tc.arguments, tc.result);
    for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
  } finally {
    span.end(end);
  }
}
