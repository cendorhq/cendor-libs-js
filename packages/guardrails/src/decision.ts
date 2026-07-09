/**
 * The guardrail abstraction and its evidence type. The TS port of `cendor.guardrails.decision`.
 *
 * Leaf module: the *types* (`Verdict`, `Context`, `Guardrail`, `defineGuardrail`) plus the
 * *evidence* (`GuardrailDecision` — the bus event acttrace chains — and `GuardrailTripped` — the
 * fail-closed error). Imports nothing else in the package, so `rules` and the engine build on it.
 */

/** The four intervention points, in agent-loop order. */
export const STAGES = ['input', 'tool_call', 'tool_output', 'output'] as const;
export type Stage = (typeof STAGES)[number];

/** What a tripped check does (mirrors acttrace's action vocabulary). */
export const ACTIONS = ['block', 'redact', 'flag'] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * What to do when a check *itself* errors or times out (as opposed to returning a verdict).
 * `fail_closed` treats the error as a block (fail-safe — the default for a gate you rely on);
 * `fail_open` records the failure as a `flag` and lets the call proceed (so a flaky tier-3/4 judge
 * outage degrades to advisory rather than silently disabling the agent). Either way the failure is
 * emitted as a `GuardrailDecision`, so the audit chain records that the check could not run —
 * evidence, not a swallowed exception.
 */
export const ON_ERROR = ['fail_closed', 'fail_open'] as const;
export type OnError = (typeof ON_ERROR)[number];

/** Coerce a stage spec (a single stage or a collection) to a validated array. */
export function normalizeStages(stage: string | readonly string[]): string[] {
  const stages = typeof stage === 'string' ? [stage] : [...stage];
  if (stages.length === 0) throw new Error('a guardrail must apply to at least one stage');
  for (const s of stages) {
    if (!(STAGES as readonly string[]).includes(s)) {
      throw new Error(`unknown stage ${JSON.stringify(s)}; must be one of ${STAGES.join(', ')}`);
    }
  }
  return stages;
}

/**
 * What a check returns to *trip* a guardrail. Return `null` to pass.
 * `action`: `"block"` (fail-closed), `"redact"` (replace the payload with `replacement`), or
 * `"flag"` (record + continue). Keep `reason` free of raw secret values.
 *
 * `metadata` is a per-result annotation dict merged into this decision's
 * {@link GuardrailDecision.metadata} — the channel a check uses to attach the **reserved annotation
 * keys** (`severity` / `detected` / `filtered` / `redacted` / `citation` / `license`, documented in
 * docs/specs/bus-events.md). Unlike the static `Guardrail.metadata` (constant per guardrail — e.g.
 * `loadPolicy`'s `policy_hash`), this is computed per verdict, so a hosted-rail adapter can record
 * the vendor's severity/labels for this specific check. `Verdict` is never serialized (only
 * `GuardrailDecision` is), so this adds no wire change. Layered *under* the caller's per-call
 * `Context.metadata` (context still wins a key clash) — see the engine's `emit`.
 */
export class Verdict {
  readonly action: Action;
  readonly reason: string;
  readonly replacement: unknown;
  readonly metadata: Record<string, unknown>;

  constructor(
    action: Action,
    reason = '',
    replacement: unknown = null,
    metadata: Record<string, unknown> = {},
  ) {
    if (!(ACTIONS as readonly string[]).includes(action)) {
      throw new Error(
        `unknown action ${JSON.stringify(action)}; must be one of ${ACTIONS.join(', ')}`,
      );
    }
    this.action = action;
    this.reason = reason;
    this.replacement = replacement;
    this.metadata = metadata;
  }
}

/** Everything a check knows about *where* it runs, beyond the payload. All fields optional. */
export interface Context {
  stage: string;
  agent?: string;
  tool?: string;
  toolArgs?: unknown;
  /**
   * The user's originating instruction/intent for the run, when the caller knows it. An alignment
   * check (`judge.taskAdherence`) compares a proposed tool call against it. Empty by default; a
   * standalone check ignores it. (`@cendor/sdk` auto-threading is a deferred parity tail — 🚧.)
   */
  instruction?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}

/** A check: given the payload + `Context`, return a `Verdict` to trip or `null` to pass (sync or async). */
export type Check = (payload: unknown, ctx: Context) => Verdict | null | Promise<Verdict | null>;

/** A named check bound to one or more stages. Build with `defineGuardrail` or a `rules.*` factory. */
export interface Guardrail {
  name: string;
  stages: string[];
  check: Check;
  /**
   * Optional per-check wall-clock limit in **seconds**. Meant for slow tier-3/4 checks (an LLM
   * judge, a hosted rail); deterministic built-ins run in microseconds and leave it `undefined`.
   * Enforced on the **async** path only (`evaluateAsync`) — JS has no threads, so there is no true
   * sync timeout (see `evaluate`). On the async path a coroutine check is bounded via
   * `Promise.race`; on a throw/timeout the `onError` policy decides.
   */
  timeout?: number;
  /**
   * What to do when the check *throws* or *times out*: `"fail_closed"` (default — treat it as a
   * block) or `"fail_open"` (record a `flag` and proceed). Rule factories pick the safe default for
   * their action; set it explicitly for a bring-your-own judge so an outage degrades to advisory
   * instead of a hard stop (or vice-versa).
   */
  onError?: OnError;
  /**
   * Static key/values merged into every `GuardrailDecision` this guardrail emits (under the caller's
   * per-call `Context.metadata`, which wins a key clash). `loadPolicy` uses it to stamp
   * `policy_hash` / `policy_version` so the audit chain proves which policy was active; also handy
   * for a severity, owner, or ticket id. Keep values small and payload-free.
   */
  metadata?: Record<string, unknown>;
}

export interface DefineGuardrailOptions {
  stage?: string | readonly string[];
  name?: string;
  /** Per-check wall-clock limit in seconds (async path only); positive or `undefined`. */
  timeout?: number;
  /** Error/timeout policy (default `"fail_closed"`). */
  onError?: OnError;
  /** Static metadata merged into every decision this guardrail emits (see {@link Guardrail.metadata}). */
  metadata?: Record<string, unknown>;
}

/**
 * Validate a guardrail's execution policy (mirrors Python's `Guardrail.__post_init__`). Throws on an
 * unknown `onError` or a non-positive `timeout`.
 */
export function validateExecutionPolicy(timeout: number | undefined, onError: OnError): void {
  if (!(ON_ERROR as readonly string[]).includes(onError)) {
    throw new Error(
      `unknown onError ${JSON.stringify(onError)}; must be one of ${ON_ERROR.join(', ')}`,
    );
  }
  if (timeout !== undefined && !(timeout > 0)) {
    throw new Error(
      `timeout must be positive seconds or undefined, got ${JSON.stringify(timeout)}`,
    );
  }
}

/**
 * Turn a `check(payload, ctx)` function into a `Guardrail` (the TS analogue of Python's
 * `@guardrail` decorator — JS has no function decorators). `timeout` / `onError` set the per-check
 * execution policy (see {@link Guardrail}).
 */
export function defineGuardrail(check: Check, opts: DefineGuardrailOptions = {}): Guardrail {
  const onError: OnError = opts.onError ?? 'fail_closed';
  validateExecutionPolicy(opts.timeout, onError);
  const g: Guardrail = {
    name: opts.name ?? (check.name || 'guardrail'),
    stages: normalizeStages(opts.stage ?? 'input'),
    check,
    onError,
  };
  if (opts.timeout !== undefined) g.timeout = opts.timeout;
  if (opts.metadata !== undefined) g.metadata = opts.metadata;
  return g;
}

export interface GuardrailDecisionInit {
  guardrail: string;
  stage: string;
  action: string;
  reason?: string;
  agent?: string;
  tool?: string;
  traceId?: string;
  ts?: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Evidence that a guardrail tripped or flagged — emitted on the `@cendor/core` bus. acttrace
 * duck-types it (`guardrail`/`stage`/`action` present) and chains it as a `guardrail_decision`
 * entry. Carries no raw payload — only the name, action, and a short reason.
 */
export class GuardrailDecision {
  guardrail: string;
  stage: string;
  action: string;
  reason: string;
  agent: string;
  tool: string;
  traceId: string;
  ts: Date | null;
  metadata: Record<string, unknown>;

  constructor(init: GuardrailDecisionInit) {
    this.guardrail = init.guardrail;
    this.stage = init.stage;
    this.action = init.action;
    this.reason = init.reason ?? '';
    this.agent = init.agent ?? '';
    this.tool = init.tool ?? '';
    this.traceId = init.traceId ?? '';
    this.ts = init.ts ?? null;
    this.metadata = init.metadata ?? {};
  }
}

/** Thrown when a guardrail's action is `block` (fail-closed). Carries the recorded `decisions`. */
export class GuardrailTripped extends Error {
  readonly decisions: GuardrailDecision[];

  constructor(decisions: GuardrailDecision[]) {
    const blocking = decisions.find((d) => d.action === 'block');
    let msg = 'guardrail blocked the call';
    if (blocking) {
      msg = `guardrail ${JSON.stringify(blocking.guardrail)} blocked at stage ${JSON.stringify(blocking.stage)}`;
      if (blocking.reason) msg = `${msg}: ${blocking.reason}`;
    }
    super(msg);
    this.name = 'GuardrailTripped';
    this.decisions = decisions;
  }
}
