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
 */
export class Verdict {
  readonly action: Action;
  readonly reason: string;
  readonly replacement: unknown;

  constructor(action: Action, reason = '', replacement: unknown = null) {
    if (!(ACTIONS as readonly string[]).includes(action)) {
      throw new Error(
        `unknown action ${JSON.stringify(action)}; must be one of ${ACTIONS.join(', ')}`,
      );
    }
    this.action = action;
    this.reason = reason;
    this.replacement = replacement;
  }
}

/** Everything a check knows about *where* it runs, beyond the payload. All fields optional. */
export interface Context {
  stage: string;
  agent?: string;
  tool?: string;
  toolArgs?: unknown;
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
}

export interface DefineGuardrailOptions {
  stage?: string | readonly string[];
  name?: string;
}

/**
 * Turn a `check(payload, ctx)` function into a `Guardrail` (the TS analogue of Python's
 * `@guardrail` decorator — JS has no function decorators).
 */
export function defineGuardrail(check: Check, opts: DefineGuardrailOptions = {}): Guardrail {
  return {
    name: opts.name ?? (check.name || 'guardrail'),
    stages: normalizeStages(opts.stage ?? 'input'),
    check,
  };
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
