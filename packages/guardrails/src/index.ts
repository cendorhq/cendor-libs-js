/**
 * `@cendor/guardrails` — a local-first gate for LLM apps: define a check, attach it to a stage.
 * The TS port of `cendor.guardrails`.
 *
 * The **Gate** in the Cendor pipeline (`contextkit → squeeze → tokenguard → guardrails → cassette →
 * acttrace`). Deterministic checks — keyword/regex/URL/length/JSON-schema — run in microseconds for
 * $0, at four intervention points (`input | tool_call | tool_output | output`). Every trip or flag
 * emits a `GuardrailDecision` on the `@cendor/core` bus, so `@cendor/acttrace` chains it as
 * tamper-evident evidence with no import between the two.
 *
 * Imports ONLY `@cendor/core` (constitution rule 2). See docs/guardrails.md.
 */
import {
  LLMCall,
  MISS,
  Reroute,
  ToolCall,
  addInterceptor,
  bus,
  currentTraceId,
  removeInterceptor,
} from '@cendor/core';
import {
  type Context,
  type Guardrail,
  GuardrailDecision,
  GuardrailTripped,
  type Verdict,
} from './decision.js';

export {
  STAGES,
  ACTIONS,
  Verdict,
  GuardrailDecision,
  GuardrailTripped,
  defineGuardrail,
  normalizeStages,
} from './decision.js';
export type {
  Stage,
  Action,
  Context,
  Check,
  Guardrail,
  DefineGuardrailOptions,
} from './decision.js';
export * as rules from './rules.js';

/** The result of evaluating a stage: the (possibly redacted) payload plus the recorded decisions. */
export interface EvalResult {
  payload: unknown;
  decisions: GuardrailDecision[];
}

function applicable(guardrails: readonly Guardrail[], stage: string): Guardrail[] {
  return guardrails.filter((g) => g.stages.includes(stage));
}

function emit(g: Guardrail, stage: string, verdict: Verdict, ctx: Context): GuardrailDecision {
  const decision = new GuardrailDecision({
    guardrail: g.name,
    stage,
    action: verdict.action,
    reason: verdict.reason,
    agent: ctx.agent ?? '',
    tool: ctx.tool ?? '',
    traceId: ctx.traceId || currentTraceId(),
    ts: new Date(),
    metadata: { ...(ctx.metadata ?? {}) },
  });
  bus.emit(decision); // acttrace (if attached) chains this as a guardrail_decision entry
  return decision;
}

function handle(
  verdict: Verdict | null,
  g: Guardrail,
  stage: string,
  payload: unknown,
  ctx: Context,
  decisions: GuardrailDecision[],
): unknown {
  if (verdict === null) return payload;
  decisions.push(emit(g, stage, verdict, ctx));
  if (verdict.action === 'block') throw new GuardrailTripped(decisions);
  if (verdict.action === 'redact' && verdict.replacement != null) return verdict.replacement;
  return payload;
}

function isPromise(x: unknown): x is Promise<unknown> {
  return x != null && typeof (x as { then?: unknown }).then === 'function';
}

/**
 * Run the `stage` guardrails over `payload` **synchronously**. Returns `{ payload, decisions }`
 * with any redactions applied in order; throws `GuardrailTripped` on the first block. An `async`
 * check throws here — use {@link evaluateAsync}.
 */
export function evaluate(
  guardrails: readonly Guardrail[],
  stage: string,
  payload: unknown,
  ctx?: Context,
): EvalResult {
  const context: Context = ctx ?? { stage };
  const decisions: GuardrailDecision[] = [];
  let current = payload;
  for (const g of applicable(guardrails, stage)) {
    const verdict = g.check(current, context);
    if (isPromise(verdict)) {
      void verdict.catch(() => {}); // swallow the rejection of the discarded promise
      throw new TypeError(`guardrail ${JSON.stringify(g.name)} is async; use evaluateAsync`);
    }
    current = handle(verdict, g, stage, current, context, decisions);
  }
  return { payload: current, decisions };
}

/** Async counterpart of {@link evaluate}: awaits `async` checks, calls sync ones directly. */
export async function evaluateAsync(
  guardrails: readonly Guardrail[],
  stage: string,
  payload: unknown,
  ctx?: Context,
): Promise<EvalResult> {
  const context: Context = ctx ?? { stage };
  const decisions: GuardrailDecision[] = [];
  let current = payload;
  for (const g of applicable(guardrails, stage)) {
    const verdict = await g.check(current, context);
    current = handle(verdict, g, stage, current, context, decisions);
  }
  return { payload: current, decisions };
}

/** Gate `payload` and return the recorded decisions (throws `GuardrailTripped` on a block). */
export function apply(
  guardrails: readonly Guardrail[],
  stage: string,
  payload: unknown,
  ctx?: Context,
): GuardrailDecision[] {
  return evaluate(guardrails, stage, payload, ctx).decisions;
}

/** Async counterpart of {@link apply}. */
export async function applyAsync(
  guardrails: readonly Guardrail[],
  stage: string,
  payload: unknown,
  ctx?: Context,
): Promise<GuardrailDecision[]> {
  return (await evaluateAsync(guardrails, stage, payload, ctx)).decisions;
}

// --------------------------------------------------------------------------- standalone wiring

let installedInterceptor: ((event: unknown) => unknown) | null = null;
let installedSubscriber: ((event: unknown) => void) | null = null;

/**
 * Gate every instrumented call by registering ONE `@cendor/core` interceptor (+ an output
 * subscriber). Framework-independent. Input: a block raises (nothing spends), a redact reroutes the
 * cleaned messages, a pass declines. tool_call: a block raises; else record + proceed (tools have
 * no message-rewrite seam). Output: a bus subscriber raises **post-flight** on a block (same
 * overshoot semantics as tokenguard's `onExceed:"raise"`). Runs sync checks only. Call
 * {@link uninstall} to remove.
 */
export function install(guardrails: readonly Guardrail[]): void {
  uninstall();
  const gl = [...guardrails];

  const interceptor = (event: unknown): unknown => {
    if (event instanceof LLMCall) {
      const ctx: Context = { stage: 'input', traceId: event.traceId };
      const { payload, decisions } = evaluate(gl, 'input', event.messages, ctx);
      if (decisions.some((d) => d.action === 'redact')) return new Reroute({ messages: payload });
      return MISS;
    }
    if (event instanceof ToolCall) {
      const ctx: Context = {
        stage: 'tool_call',
        tool: event.name,
        toolArgs: event.arguments,
        traceId: event.traceId,
      };
      evaluate(gl, 'tool_call', event.arguments, ctx); // block throws; else record + proceed
      return MISS;
    }
    return MISS;
  };

  const subscriber = (event: unknown): void => {
    if (!(event instanceof LLMCall)) return;
    const text = responseText(event);
    if (text === null) return;
    const ctx: Context = { stage: 'output', traceId: event.traceId };
    evaluate(gl, 'output', text, ctx); // block throws post-flight
  };

  addInterceptor(interceptor);
  bus.subscribe(subscriber);
  installedInterceptor = interceptor;
  installedSubscriber = subscriber;
}

/** Remove the interceptor + output subscriber registered by {@link install} (idempotent). */
export function uninstall(): void {
  if (installedInterceptor) removeInterceptor(installedInterceptor);
  if (installedSubscriber) bus.unsubscribe(installedSubscriber);
  installedInterceptor = null;
  installedSubscriber = null;
}

function get(obj: unknown, name: string): unknown {
  return obj != null && typeof obj === 'object'
    ? (obj as Record<string, unknown>)[name]
    : undefined;
}

/** Best-effort assistant text off a completed LLMCall for the standalone output stage. */
export function responseText(call: LLMCall): string | null {
  const response = call.metadata?.response;
  if (response == null) return null;
  try {
    return extractText(response);
  } catch {
    return null; // extraction must never break the passthrough
  }
}

function extractText(response: unknown): string | null {
  const outputText = get(response, 'output_text'); // OpenAI Responses convenience field
  if (typeof outputText === 'string' && outputText) return outputText;
  const choices = get(response, 'choices'); // OpenAI/HF Chat Completions
  if (Array.isArray(choices) && choices.length > 0) {
    const content = get(get(choices[0], 'message'), 'content');
    if (typeof content === 'string') return content;
  }
  const content = get(response, 'content'); // Anthropic content blocks
  if (Array.isArray(content)) {
    const parts = content.map((b) => get(b, 'text')).filter((t) => t != null);
    if (parts.length > 0) return parts.map(String).join('');
  }
  const message = get(response, 'message'); // Ollama
  if (message != null) {
    const text = get(message, 'content');
    if (typeof text === 'string') return text;
  }
  const text = get(response, 'text'); // Gemini
  if (typeof text === 'string' && text) return text;
  const outMessage = get(get(response, 'output'), 'message'); // Bedrock Converse
  const outContent = get(outMessage, 'content');
  if (Array.isArray(outContent)) {
    const parts = outContent.map((b) => get(b, 'text')).filter((t) => t != null);
    if (parts.length > 0) return parts.map(String).join('');
  }
  return null;
}
