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
import { emit } from './bus.js';
import { estimate } from './prices.js';
import { LLMCall, type Message, Usage } from './types.js';

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
