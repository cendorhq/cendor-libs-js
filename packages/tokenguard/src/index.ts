/**
 * `@cendor/tokenguard` — pre-flight cost caps + free per-tag spend attribution for LLM calls. The
 * TypeScript port of `cendor.tokenguard`.
 *
 * It **subscribes** to `@cendor/core`'s event bus and registers a pre-flight interceptor; it never
 * patches a client itself (the locked architecture: one `instrument()`, many subscribers). Once a
 * client is instrumented, `budget(...)` enforces a cap and `track(...)` attributes spend by tags —
 * with zero per-call wiring.
 *
 * Parity notes vs. the Python original:
 * - Python `contextvars` become two `node:async_hooks` `AsyncLocalStorage` scopes (`_tags`,
 *   `_budgets`) — they propagate across `await` in the same async task, but NOT across worker
 *   threads (same caveat as Python's contextvars vs. OS threads).
 * - Python `with budget(...) as b:` / `@budget(...)` become {@link withBudget} (async-callback
 *   scope) and {@link budget} (decorator: `budget(cfg)(fn)`); `with track(...)` becomes
 *   {@link track} (async-callback scope). `track.report` is attached as an ergonomic alias.
 * - `warnings.warn(UnpricedModelWarning)` becomes a capturable/escalatable warning channel:
 *   register a listener via {@link onUnpricedWarning}; with no listener it falls back to
 *   `console.warn`. Deduped once-per-model (cleared by {@link reset}).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  Dec,
  LLMCall,
  MISS,
  Money,
  Reroute,
  UnknownModelError,
  addInterceptor,
  bus,
  prices,
  tokens,
} from '@cendor/core';
import type { Decimal, Message, Sink } from '@cendor/core';

// --------------------------------------------------------------------------- constants

/** Output tokens are unknown pre-flight; reserve this many for the projection unless the request
 * carries an explicit `max_tokens` / `max_completion_tokens`. */
const DEFAULT_OUTPUT_RESERVE = 256;

/** Valid string values for `budget({ onExceed })` (a callable is also accepted). */
const ON_EXCEED = ['raise', 'block', 'truncate', 'downgrade', 'clamp'] as const;

/** Per-provider request kwarg that caps generated (reasoning + visible) output tokens, used by
 * `onExceed: 'clamp'`. Providers absent here can't have the cap injected safely (clamp falls back
 * to a hard block). */
const CLAMP_KWARG: Record<string, string> = {
  openai: 'max_completion_tokens',
  anthropic: 'max_tokens',
};

const DEFAULT_MAX_RECORDS = 100_000;
const DEFAULT_ON_UNPRICED = 'warn';

// --------------------------------------------------------------------------- errors + warnings

/** Raised when a call pushes an active budget over its cap (post-flight `raise`, or pre-flight
 * `block` / `clamp`-fallback). */
export class BudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceeded';
  }
}

/** Warned (once per model) when a USD budget is active but the call's model has no price — an
 * unpriced model records `$0` toward USD spend, so a USD-only cap can't enforce against it. */
export class UnpricedModelWarning extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnpricedModelWarning';
  }
}

/**
 * A pre-flight budget action, emitted on the `@cendor/core` bus so `@cendor/acttrace` chains it as a
 * `budget_event` and an OpenTelemetry mirror can surface it in your APM/SIEM. A blocked call never
 * reaches the bus as an `LLMCall` (it's refused pre-flight), so this event is the *only* signal that
 * the breaker fired — exactly the governance action you want to alert on. `action` is `'blocked'` |
 * `'downgraded'` | `'clamped'`. Money fields are the Decimal rendered as a string; token fields are
 * numbers. Duck-typed by `acttrace` (no import), like `guardrails`' `GuardrailDecision`.
 */
export class BudgetEvent {
  readonly action: string;
  readonly reason: string;
  readonly model: string;
  readonly toModel: string | null;
  readonly scope: string | null;
  readonly projectedUsd: string | null;
  readonly capUsd: string | null;
  readonly projectedTokens: number | null;
  readonly capTokens: number | null;
  readonly tags: Record<string, unknown>;
  readonly ts: Date;

  constructor(init: {
    action: string;
    reason?: string;
    model?: string;
    toModel?: string | null;
    scope?: string | null;
    projectedUsd?: string | null;
    capUsd?: string | null;
    projectedTokens?: number | null;
    capTokens?: number | null;
    tags?: Record<string, unknown>;
  }) {
    this.action = init.action;
    this.reason = init.reason ?? '';
    this.model = init.model ?? '';
    this.toModel = init.toModel ?? null;
    this.scope = init.scope ?? null;
    this.projectedUsd = init.projectedUsd ?? null;
    this.capUsd = init.capUsd ?? null;
    this.projectedTokens = init.projectedTokens ?? null;
    this.capTokens = init.capTokens ?? null;
    this.tags = init.tags ?? {};
    this.ts = new Date();
  }
}

/** Internal graceful-degradation signal for `onExceed: 'truncate'`; never escapes a budget. */
class Truncated extends Error {
  constructor() {
    super('truncated');
    this.name = 'Truncated';
  }
}

/** Internal — mirrors Python's `ValueError` for eager config validation (tests match a substring). */
class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

/** Internal — mirrors Python's `AssertionError` for {@link Report.assertUnder}. */
class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

type UnpricedWarningListener = (warning: UnpricedModelWarning) => void;
const warningListeners = new Set<UnpricedWarningListener>();

/**
 * Register a listener for {@link UnpricedModelWarning}s (the TS analog of a Python warning filter).
 * Returns an unsubscribe function. With at least one listener installed the warning is delivered to
 * the listeners (and NOT to `console.warn`); a listener may re-throw to escalate the warning to an
 * error, exactly like `simplefilter("error", UnpricedModelWarning)`.
 */
export function onUnpricedWarning(listener: UnpricedWarningListener): () => void {
  warningListeners.add(listener);
  return () => {
    warningListeners.delete(listener);
  };
}

// --------------------------------------------------------------------------- frame + record types

/** How a budget treats a call that crosses its cap. `'raise'`/`'truncate'`/callable act
 * post-flight; `'block'`/`'downgrade'`/`'clamp'` act pre-flight. */
export type OnExceedMode = (typeof ON_EXCEED)[number];

/** Context passed to a callable `onExceed` when a budget is breached post-flight. */
export interface ExceedContext {
  frame: Frame;
  call: LLMCall;
  spentUsd: Decimal;
  capUsd: Decimal | null;
}

export type OnExceed = OnExceedMode | ((ctx: ExceedContext) => unknown);

/** One active budget (mutable — the post-flight subscriber accumulates spend into it). */
export class Frame {
  capUsd: Decimal | null;
  capTokens: number | null;
  onExceed: OnExceed;
  scope: string | null;
  downgrade: Record<string, string> | null;
  outputReserve: number;
  reasoningReserve: number;
  spentUsd: Decimal = new Dec(0);
  spentTokens = 0;
  calls = 0;

  constructor(init: {
    capUsd: Decimal | null;
    capTokens: number | null;
    onExceed: OnExceed;
    scope: string | null;
    downgrade: Record<string, string> | null;
    outputReserve: number;
    reasoningReserve: number;
  }) {
    this.capUsd = init.capUsd;
    this.capTokens = init.capTokens;
    this.onExceed = init.onExceed;
    this.scope = init.scope;
    this.downgrade = init.downgrade;
    this.outputReserve = init.outputReserve;
    this.reasoningReserve = init.reasoningReserve;
  }
}

/** One recorded spend row. */
interface SpendRecord {
  tags: Record<string, unknown>;
  usd: Decimal;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  model: string;
  calls: number;
  unpriced: boolean;
}

/** A `report()` row. Keys are byte-identical to the Python original (snake_case, per the spec). */
export interface ReportRow {
  tags: Record<string, unknown>;
  usd: Money;
  tokens: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  calls: number;
  unpriced_calls: number;
}

/** A pre-flight model-downgrade row (`downgrades()`). */
export interface DowngradeRow {
  from: string;
  to: string;
  tags: Record<string, unknown>;
}

/** A pre-flight token-clamp row (`clamps()`). */
export interface ClampRow {
  model: string;
  kwarg: string;
  limit: number;
  tags: Record<string, unknown>;
}

// --------------------------------------------------------------------------- module state

const tagsStore = new AsyncLocalStorage<Record<string, unknown>>();
const budgetsStore = new AsyncLocalStorage<Frame[]>();
const records: SpendRecord[] = [];
const downgradeRows: DowngradeRow[] = [];
const clampRows: ClampRow[] = [];
let sink: Sink | null = null;
let maxRecords: number | null = DEFAULT_MAX_RECORDS;
let droppedCount = 0;
let onUnpriced = DEFAULT_ON_UNPRICED;
const warnedUnpriced = new Set<string>();

function currentTags(): Record<string, unknown> {
  return tagsStore.getStore() ?? {};
}

function currentFrames(): Frame[] {
  return budgetsStore.getStore() ?? [];
}

function warnUnpriced(model: string, mode: string): void {
  if (warnedUnpriced.has(model)) return;
  warnedUnpriced.add(model);
  const warning = new UnpricedModelWarning(
    `tokenguard: no price for model '${model}', so the active USD budget (on_exceed='${mode}') counts its calls as $0 and cannot enforce a USD cap on it. Add a rate (cendor.core.prices), use a tokens= cap instead, or configure(on_unpriced='raise') to reject unpriced calls under on_exceed='block'.`,
  );
  if (warningListeners.size === 0) {
    console.warn(warning.message);
    return;
  }
  for (const listener of warningListeners) listener(warning);
}

function ensureSubscribed(): void {
  bus.subscribe(onCall); // idempotent on the bus side
  addInterceptor(_preflightInterceptor); // idempotent; pre-flight downgrade/clamp/block routing
}

// --------------------------------------------------------------------------- projection helpers

/**
 * Output tokens to assume pre-flight. Prefers the request's explicit output cap
 * (`max_completion_tokens`, else `max_tokens`) using `!= null` checks so `max_tokens: 0` is honored
 * (project 0 output), NOT treated as unset. Otherwise assumes `reserve + reasoningReserve`.
 *
 * Internal, but exported for parity with the Python test that asserts its behavior directly.
 */
export function _projectedOutput(call: LLMCall, reserve: number, reasoningReserve = 0): number {
  const kwargs = (call.metadata.request_kwargs as Record<string, unknown> | undefined) ?? {};
  let explicit = kwargs.max_completion_tokens;
  if (explicit == null) explicit = kwargs.max_tokens;
  if (explicit != null) return Math.trunc(Number(explicit));
  return reserve + reasoningReserve;
}

/** Project a call's cost pre-flight from its model + messages (+ an output reserve). May throw
 * `UnknownModelError` (the KeyError-equivalent) for an unpriced model. */
function estimateEvent(call: LLMCall, reserve: number, reasoningReserve = 0): Decimal {
  const inputTokens = tokens.count(call.messages, call.model);
  const projected = _projectedOutput(call, reserve, reasoningReserve);
  return prices.estimate(call.model, inputTokens, { outputTokens: projected }).amount;
}

/** Pre-flight token projection: input tokens + the output reserve (max_tokens or default). */
function projectTokens(call: LLMCall, reserve: number, reasoningReserve = 0): number {
  return (
    tokens.count(call.messages, call.model) + _projectedOutput(call, reserve, reasoningReserve)
  );
}

// --------------------------------------------------------------------------- pre-flight interceptor

/**
 * Pre-flight enforcement, before the call runs: reroute (`downgrade`), clamp (`clamp`), or block
 * (`block`). `raise`/`truncate`/callable are ignored here (post-flight only). Iterates frames
 * innermost-first.
 *
 * Internal, but exported so tests can drive it directly on a synthesized `LLMCall` (the TS core's
 * `instrument()` only structurally detects openai/anthropic clients, so an "ollama-shaped" client
 * isn't wrapped — this exercises the same clamp-fallback code path).
 */
/**
 * Publish a {@link BudgetEvent} on the bus for a pre-flight budget action, so `acttrace` records it
 * and an OTel mirror can alert on it. Best-effort observability — never gates the action itself.
 */
function emitBudgetEvent(
  action: string,
  args: {
    call: LLMCall;
    frame: Frame;
    reason: string;
    projectedUsd?: Decimal;
    projectedTokens?: number;
    toModel?: string;
  },
): void {
  bus.emit(
    new BudgetEvent({
      action,
      reason: args.reason,
      model: args.call.model,
      toModel: args.toModel ?? null,
      scope: args.frame.scope,
      projectedUsd: args.projectedUsd != null ? args.projectedUsd.toString() : null,
      capUsd: args.frame.capUsd !== null ? args.frame.capUsd.toString() : null,
      projectedTokens: args.projectedTokens ?? null,
      capTokens: args.frame.capTokens,
      tags: { ...currentTags() },
    }),
  );
}

export function _preflightInterceptor(call: unknown): unknown {
  if (!(call instanceof LLMCall)) return MISS;
  const frames = currentFrames();
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i]!;
    if (frame.onExceed === 'downgrade' && frame.downgrade && frame.capUsd !== null) {
      const cheaper = frame.downgrade[call.model];
      if (!cheaper) continue;
      let projected: Decimal;
      try {
        projected = estimateEvent(call, frame.outputReserve, frame.reasoningReserve);
      } catch (err) {
        if (err instanceof UnknownModelError) {
          warnUnpriced(call.model, 'downgrade'); // can't project — no longer silent
          continue; // unknown model price — leave the call as-is
        }
        throw err;
      }
      if (frame.spentUsd.plus(projected).greaterThan(frame.capUsd)) {
        downgradeRows.push({ from: call.model, to: cheaper, tags: { ...currentTags() } });
        emitBudgetEvent('downgraded', {
          call,
          frame,
          reason: `projected $${frame.spentUsd.plus(projected)} > cap $${frame.capUsd}; rerouted ${call.model} -> ${cheaper}`,
          projectedUsd: frame.spentUsd.plus(projected),
          toModel: cheaper,
        });
        return new Reroute({ model: cheaper });
      }
    } else if (frame.onExceed === 'clamp') {
      const reroute = clamp(call, frame);
      if (reroute !== null) return reroute;
    } else if (frame.onExceed === 'block') {
      const projTokens = projectTokens(call, frame.outputReserve, frame.reasoningReserve);
      if (frame.capTokens !== null && frame.spentTokens + projTokens > frame.capTokens) {
        const reason = `pre-flight block: ~${frame.spentTokens + projTokens} tokens would exceed cap ${frame.capTokens} (model=${call.model})`;
        emitBudgetEvent('blocked', {
          call,
          frame,
          reason,
          projectedTokens: frame.spentTokens + projTokens,
        });
        throw new BudgetExceeded(reason);
      }
      if (frame.capUsd !== null) {
        let projected: Decimal;
        try {
          projected = estimateEvent(call, frame.outputReserve, frame.reasoningReserve);
        } catch (err) {
          if (err instanceof UnknownModelError) {
            if (onUnpriced === 'raise') {
              const reason = `pre-flight block: model=${call.model} has no price, so a USD cap cannot be projected; configure(on_unpriced='raise') rejects unpriced calls (set on_unpriced='warn' to let them through as $0).`;
              emitBudgetEvent('blocked', { call, frame, reason });
              throw new BudgetExceeded(reason);
            }
            warnUnpriced(call.model, 'block');
            continue;
          }
          throw err;
        }
        if (frame.spentUsd.plus(projected).greaterThan(frame.capUsd)) {
          const reason = `pre-flight block: projected $${frame.spentUsd.plus(projected)} would exceed cap $${frame.capUsd} (model=${call.model})`;
          emitBudgetEvent('blocked', {
            call,
            frame,
            reason,
            projectedUsd: frame.spentUsd.plus(projected),
          });
          throw new BudgetExceeded(reason);
        }
      }
    }
  }
  return MISS;
}

/**
 * Inject a provider output ceiling so a single call can't exceed the remaining token budget.
 * Requires a `tokens=` cap. It **always** injects the ceiling — set to the tokens left in the
 * budget after the projected input — so even a call that looks small pre-flight can't overshoot on
 * a surprise-long completion (the reserve heuristic guards only `block`/`downgrade`, never `clamp`).
 * A caller's own tighter cap is respected; the only fall-back to a hard block is when the input
 * alone already exceeds the budget (no output room) or the provider can't take an injected ceiling.
 */
function clamp(call: LLMCall, frame: Frame): Reroute | null {
  if (frame.capTokens === null) return null;
  const projectedInput = tokens.count(call.messages, call.model);
  const allowance = frame.capTokens - frame.spentTokens - projectedInput;
  const kwarg = CLAMP_KWARG[call.provider];
  if (kwarg === undefined || allowance <= 0) {
    const reason = `pre-flight clamp: cannot fit call within the remaining token budget (~${frame.capTokens - frame.spentTokens} left, ~${projectedInput} input; provider='${call.provider}', model=${call.model}) — use on_exceed='block' to reject, or raise the cap`;
    emitBudgetEvent('blocked', { call, frame, reason, projectedTokens: projectedInput });
    throw new BudgetExceeded(reason);
  }
  const existingRaw = (call.metadata.request_kwargs as Record<string, unknown> | undefined)?.[
    kwarg
  ];
  const existing = existingRaw == null ? null : Math.trunc(Number(existingRaw));
  if (existing !== null && existing <= allowance) return null; // caller's own cap already fits
  const target = existing === null ? allowance : Math.min(existing, allowance);
  clampRows.push({ model: call.model, kwarg, limit: target, tags: { ...currentTags() } });
  emitBudgetEvent('clamped', {
    call,
    frame,
    reason: `injected ${kwarg}=${target} to bound output within the remaining token budget`,
    projectedTokens: frame.spentTokens + projectedInput + target,
  });
  return new Reroute({ [kwarg]: target });
}

// --------------------------------------------------------------------------- post-flight subscriber

/** Bus subscriber: record spend by active tags and enforce active budgets (post-flight). */
function onCall(call: unknown): void {
  if (!(call instanceof LLMCall)) return; // tokenguard only accounts for model calls
  const unpriced = call.cost === null; // no cost -> unknown/unpriced model, a USD blind spot
  const usd = call.cost !== null ? call.cost.amount : new Dec(0);
  const inp = call.usage !== null ? call.usage.inputTokens : 0;
  const out = call.usage !== null ? call.usage.outputTokens : 0;
  const rsn = call.usage !== null ? call.usage.reasoningTokens : 0;

  const frames = currentFrames();
  if (unpriced) {
    // A USD-cap budget can't enforce against a $0-recorded call. Warn once per model, naming the
    // innermost USD-cap frame's mode. (block/downgrade already warned pre-flight; this covers the
    // post-flight modes: raise/truncate/callable.)
    let usdFrame: Frame | null = null;
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i]!.capUsd !== null) {
        usdFrame = frames[i]!;
        break;
      }
    }
    if (usdFrame !== null) {
      const mode = usdFrame.onExceed;
      warnUnpriced(call.model, typeof mode === 'string' ? mode : 'callable');
    }
  }

  const tags = { ...currentTags() };
  records.push({
    tags,
    usd,
    inputTokens: inp,
    outputTokens: out,
    reasoningTokens: rsn,
    model: call.model,
    calls: 1,
    unpriced,
  });
  // append + FIFO eviction — a read-modify-write on shared state. JS is single-threaded so no lock
  // is needed; append/evict is atomic within a single emit.
  if (maxRecords !== null && records.length > maxRecords) {
    const overflow = records.length - maxRecords;
    records.splice(0, overflow); // evict oldest (FIFO); counted, never silently
    droppedCount += overflow;
  }
  if (sink !== null) {
    sink.write({
      tags,
      usd: usd.toString(),
      input_tokens: inp,
      output_tokens: out,
      reasoning_tokens: rsn,
      model: call.model,
    });
  }

  for (const frame of frames) {
    frame.spentUsd = frame.spentUsd.plus(usd);
    frame.spentTokens += inp + out;
    frame.calls += 1;
  }

  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i]!; // enforce the tightest (innermost) breached cap first
    if (over(frame)) {
      if (frame.onExceed === 'downgrade' || frame.onExceed === 'clamp') {
        continue; // handled pre-flight; a no-op here must not mask an outer cap's action
      }
      enforce(frame, call);
      break;
    }
  }
}

function over(frame: Frame): boolean {
  if (frame.capUsd !== null && frame.spentUsd.greaterThan(frame.capUsd)) return true;
  if (frame.capTokens !== null && frame.spentTokens > frame.capTokens) return true;
  return false;
}

function enforce(frame: Frame, call: LLMCall): void {
  const mode = frame.onExceed;
  if (typeof mode === 'function') {
    mode({ frame, call, spentUsd: frame.spentUsd, capUsd: frame.capUsd });
    return;
  }
  if (mode === 'truncate') throw new Truncated();
  if (mode === 'downgrade' || mode === 'clamp') return; // already handled pre-flight
  throw new BudgetExceeded(
    `budget exceeded: spent $${frame.spentUsd} > cap $${frame.capUsd} after ${frame.calls} call(s); last model=${call.model}. on_exceed='raise' is post-flight, so the cap is crossed by this one in-flight call — use on_exceed='block' for a pre-flight hard cap that never overspends.`,
  );
}

// --------------------------------------------------------------------------- budget

/** Configuration for {@link budget} / {@link withBudget}. Mirrors the Python `budget(...)` kwargs. */
export interface BudgetConfig {
  usd?: number | string | Decimal | null;
  tokens?: number | null;
  onExceed?: OnExceed;
  scope?: string | null;
  downgrade?: Record<string, string> | null;
  outputReserve?: number;
  reasoningReserve?: number;
}

function validateBudgetConfig(cfg: BudgetConfig): void {
  const onExceedValue = cfg.onExceed ?? 'raise';
  if (
    typeof onExceedValue !== 'function' &&
    !(ON_EXCEED as readonly string[]).includes(onExceedValue)
  ) {
    throw new ValueError(
      `on_exceed must be a callable or one of ${ON_EXCEED.join(',')}, got '${String(onExceedValue)}'`,
    );
  }
  if (cfg.usd == null && cfg.tokens == null) {
    throw new ValueError('budget requires a cap: pass usd= and/or tokens=');
  }
  if (onExceedValue === 'downgrade') {
    if (!cfg.downgrade || Object.keys(cfg.downgrade).length === 0) {
      throw new ValueError("on_exceed='downgrade' requires a downgrade={model: cheaper} map");
    }
    if (cfg.usd == null) {
      throw new ValueError(
        "on_exceed='downgrade' requires a usd= cap (the projection is USD-based)",
      );
    }
  }
  if (onExceedValue === 'clamp' && cfg.tokens == null) {
    throw new ValueError(
      "on_exceed='clamp' requires a tokens= cap (it injects a provider token ceiling)",
    );
  }
}

function makeFrame(cfg: BudgetConfig): Frame {
  return new Frame({
    capUsd: cfg.usd == null ? null : new Dec(String(cfg.usd)),
    capTokens: cfg.tokens ?? null,
    onExceed: cfg.onExceed ?? 'raise',
    scope: cfg.scope ?? null,
    downgrade: cfg.downgrade ?? null,
    outputReserve: cfg.outputReserve ?? DEFAULT_OUTPUT_RESERVE,
    reasoningReserve: cfg.reasoningReserve ?? 0,
  });
}

/** A handle to an open budget scope, passed to the {@link withBudget} callback. */
export class BudgetHandle {
  constructor(private readonly frame: Frame) {}

  /** Spend recorded against this budget so far. Meaningful inside the `withBudget` callback. */
  get spent(): Money {
    return new Money(this.frame.spentUsd);
  }
}

/**
 * @deprecated `budget` is curried — write `budget(cfg)(fn)`, or use `withBudget(cfg, cb)` for a
 * callback scope. This two-argument overload exists only to make the wrong shape a compile error.
 */
export function budget(cfg: BudgetConfig, fn: never): never;
/**
 * Cap spend on a decorated function (the parity of Python's `@budget(...)`). Validates its
 * configuration eagerly (throws on a missing cap / unknown `onExceed` / bad `downgrade` or
 * `clamp`), then returns a wrapper that opens a fresh budget frame per invocation.
 *
 * **Curried:** `budget(cfg)(fn)` — never `budget(cfg, fn)`. For a callback scope use
 * `withBudget(cfg, cb)`. The TS core is async-first, so the returned wrapper is always async (model
 * calls are async); on `onExceed: 'truncate'` it resolves to `undefined` (graceful degradation).
 *
 * @example
 * ```ts
 * import { budget } from '@cendor/tokenguard';
 * const answer = budget({ usd: 0.5, onExceed: 'raise' })(async (q: string) => respond(q));
 * ```
 */
export function budget(
  cfg: BudgetConfig,
): <A extends unknown[], R>(
  fn: (...args: A) => R | Promise<R>,
) => (...args: A) => Promise<R | undefined>;
export function budget(cfg: BudgetConfig, _fn?: never) {
  validateBudgetConfig(cfg);
  return <A extends unknown[], R>(fn: (...args: A) => R | Promise<R>) =>
    async (...args: A): Promise<R | undefined> => {
      ensureSubscribed();
      const frame = makeFrame(cfg);
      const frames = [...currentFrames(), frame];
      try {
        return await budgetsStore.run(frames, () => fn(...args));
      } catch (err) {
        if (err instanceof Truncated) return undefined; // degraded gracefully instead of crashing
        throw err;
      }
    };
}

/**
 * Cap spend within an async-callback scope (the parity of Python's `with budget(...) as b:`).
 * Validates eagerly, opens a fresh frame, runs `cb` inside the budget's `AsyncLocalStorage` scope so
 * enforcement applies to every instrumented call made inside (including across awaits). On
 * `onExceed: 'truncate'` it resolves to `undefined`; all other errors (including `BudgetExceeded`)
 * propagate.
 *
 * @example
 * ```ts
 * import { withBudget } from '@cendor/tokenguard';
 * const spent = await withBudget({ usd: 0.5 }, async (b) => { await answer('hi'); return b.spent; });
 * ```
 */
export async function withBudget<T>(
  cfg: BudgetConfig,
  cb: (b: BudgetHandle) => T | Promise<T>,
): Promise<T | undefined> {
  validateBudgetConfig(cfg);
  ensureSubscribed();
  const frame = makeFrame(cfg);
  const frames = [...currentFrames(), frame];
  const handle = new BudgetHandle(frame);
  try {
    return await budgetsStore.run(frames, () => cb(handle));
  } catch (err) {
    if (err instanceof Truncated) return undefined;
    throw err;
  }
}

// --------------------------------------------------------------------------- track

/** The `track` function object, plus the `track.report` ergonomic alias. */
export interface TrackFunction {
  <T>(tags: Record<string, unknown>, cb: () => T | Promise<T>): Promise<T>;
  report: typeof report;
}

function trackImpl<T>(tags: Record<string, unknown>, cb: () => T | Promise<T>): Promise<T> {
  ensureSubscribed();
  const merged = { ...currentTags(), ...tags };
  return Promise.resolve(tagsStore.run(merged, cb));
}

/**
 * Attribute spend by ambient tags within an async-callback scope (the parity of Python's
 * `with track(**tags):`). Tags merge with any enclosing `track(...)` and apply to every
 * instrumented call made inside — including across nested and async calls. `track.report` is the
 * documented alias for {@link report}.
 *
 * @example
 * ```ts
 * import { track, report } from '@cendor/tokenguard';
 * await track({ feature: 'support', userId: 'alice' }, async () => answer('hi'));
 * report(['feature']);   // spend grouped by tag
 * ```
 */
export const track: TrackFunction = Object.assign(trackImpl, { report }) as TrackFunction;

// --------------------------------------------------------------------------- estimate + report

/**
 * Pre-flight cost projection without making a call (budget "linting"). Prices the input via
 * `core.tokens` × `core.prices`, plus `maxOutputTokens` of output (defaults to 0 — input-only).
 * Throws `UnknownModelError` (the KeyError-equivalent) for an unknown model.
 */
export function estimate(model: string, messages: Message[], maxOutputTokens = 0): Money {
  const inputTokens = tokens.count(messages, model);
  return prices.estimate(model, inputTokens, { outputTokens: maxOutputTokens });
}

/** Aggregated spend rows. Iterable; cost-as-a-test-assertion via {@link assertUnder}. */
export class Report {
  constructor(public rows: ReportRow[] = []) {}

  [Symbol.iterator](): Iterator<ReportRow> {
    return this.rows[Symbol.iterator]();
  }

  get length(): number {
    return this.rows.length;
  }

  total(): Money {
    let sum = new Dec(0);
    for (const row of this.rows) sum = sum.plus(row.usd.amount);
    return new Money(sum);
  }

  /** Assert spend (optionally filtered by tags) is under `usd`, else throw an AssertionError. */
  assertUnder(usd: number | string, tagFilter: Record<string, unknown> = {}): boolean {
    const cap = new Dec(String(usd));
    let spent = new Dec(0);
    const filters = Object.entries(tagFilter);
    for (const row of this.rows) {
      if (filters.every(([k, v]) => row.tags[k] === v)) spent = spent.plus(row.usd.amount);
    }
    if (spent.greaterThan(cap)) {
      const where = filters.length > 0 ? JSON.stringify(tagFilter) : 'all spend';
      throw new AssertionError(`$${spent} exceeds cap $${cap} for ${where}`);
    }
    return true;
  }
}

interface Group {
  tags: Record<string, unknown>;
  usd: Decimal;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  calls: number;
  unpricedCalls: number;
}

/**
 * Aggregate recorded spend, grouped by the given tag keys. Rows carry `usd` as `Money` and
 * `tokens` = `input_tokens + output_tokens` (reasoning is a subset of output, NOT double-counted).
 * Aggregates only the retained window (see {@link dropped}). Row keys stay **snake_case** in both
 * languages (`row.input_tokens`, not `row.inputTokens`).
 *
 * @example
 * ```ts
 * import { report } from '@cendor/tokenguard';
 * for (const row of report(['feature'])) console.log(row.tags, row.usd, row.input_tokens);
 * ```
 */
export function report(groupBy?: string[]): Report {
  const keys = groupBy ?? [];
  const groups = new Map<string, Group>();
  const snapshot = [...records]; // snapshot so a concurrent emit can't resize mid-iteration
  for (const rec of snapshot) {
    const keyVals = keys.map((k) => (rec.tags[k] === undefined ? null : rec.tags[k]));
    const gk = JSON.stringify(keyVals);
    let group = groups.get(gk);
    if (group === undefined) {
      const tags: Record<string, unknown> = {};
      for (const k of keys) tags[k] = rec.tags[k] === undefined ? null : rec.tags[k];
      group = {
        tags,
        usd: new Dec(0),
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        calls: 0,
        unpricedCalls: 0,
      };
      groups.set(gk, group);
    }
    group.usd = group.usd.plus(rec.usd);
    group.inputTokens += rec.inputTokens;
    group.outputTokens += rec.outputTokens;
    group.reasoningTokens += rec.reasoningTokens;
    group.calls += rec.calls;
    if (rec.unpriced) group.unpricedCalls += rec.calls;
  }
  const rows: ReportRow[] = [];
  for (const g of groups.values()) {
    rows.push({
      tags: g.tags,
      usd: new Money(g.usd),
      tokens: g.inputTokens + g.outputTokens,
      input_tokens: g.inputTokens,
      output_tokens: g.outputTokens,
      reasoning_tokens: g.reasoningTokens,
      calls: g.calls,
      unpriced_calls: g.unpricedCalls,
    });
  }
  return new Report(rows);
}

// --------------------------------------------------------------------------- introspection + config

/** The pre-flight model downgrades performed so far (`{ from, to, tags }` rows). Returns a copy. */
export function downgrades(): DowngradeRow[] {
  return [...downgradeRows];
}

/** The pre-flight token clamps applied so far (`{ model, kwarg, limit, tags }` rows). Returns a copy. */
export function clamps(): ClampRow[] {
  return [...clampRows];
}

/** Attach a spend sink (e.g. `SQLiteSink`/`OTelSink`); returns the previous one. Pass `null` to
 * detach. The in-memory aggregation (`report()`) always runs regardless. */
export function useSink(next: Sink | null): Sink | null {
  const previous = sink;
  sink = next;
  return previous;
}

/** Options for {@link configure}. Omit a key to leave that setting unchanged. */
export interface ConfigureOptions {
  maxRecords?: number | null;
  onUnpriced?: string;
}

/** Tune tokenguard's runtime behavior. Each argument is independent — omit one to leave it as is. */
export function configure(opts: ConfigureOptions = {}): void {
  if (opts.maxRecords !== undefined) maxRecords = opts.maxRecords;
  if (opts.onUnpriced !== undefined) {
    if (opts.onUnpriced !== 'warn' && opts.onUnpriced !== 'raise') {
      throw new ValueError(`on_unpriced must be 'warn' or 'raise', got '${opts.onUnpriced}'`);
    }
    onUnpriced = opts.onUnpriced;
  }
}

/** Spend rows evicted by the {@link configure} cap since the last {@link reset} (0 if none). */
export function dropped(): number {
  return droppedCount;
}

/** Count of recorded calls whose cost was `null` (unpriced/unknown model) in the retained buffer. */
export function unpricedCalls(): number {
  let total = 0;
  for (const rec of records) if (rec.unpriced) total += rec.calls;
  return total;
}

/** Clear recorded spend and config (tags/budgets are `AsyncLocalStorage`-scoped), and re-arm the
 * bus subscription. Useful between tests so spend doesn't leak across cases. */
export function reset(): void {
  records.length = 0;
  droppedCount = 0;
  downgradeRows.length = 0;
  clampRows.length = 0;
  warnedUnpriced.clear();
  sink = null;
  maxRecords = DEFAULT_MAX_RECORDS;
  onUnpriced = DEFAULT_ON_UNPRICED;
  ensureSubscribed();
}

// Subscribe at import so even a bare instrumented call (no budget/track) is aggregated, and arm the
// pre-flight interceptor. Idempotent, and re-armed by reset().
ensureSubscribed();
