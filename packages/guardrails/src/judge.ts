/**
 * LLM-judge helpers — turn a bring-your-own model call into a usable guardrail. The TS port of
 * `cendor.guardrails.judge`.
 *
 * cendor ships **no** classifier. `rules.llmJudge` is an adapter *contract*: you supply the model
 * call. These helpers give that call the boring, error-prone parts so you don't hand-roll them —
 *
 * - {@link verdictPrompt} — a strict system instruction that pins the model to a two-field JSON
 *   verdict (`{"trip": <bool>, "reason": "<short>"}`), so the output is parseable, not prose.
 * - {@link parseVerdict} — strict JSON → `Verdict` (or `null` to pass). Malformed output *throws* so
 *   the guardrail's `onError` policy decides (a garbled judge fails **closed** by default).
 * - {@link judge} — glue the two around your `respond(system, user)` callable (sync or async) into a
 *   check you hand straight to `rules.llmJudge`.
 *
 * The judge's own spend is budgeted and audited: make the call through an `instrument()`-ed client
 * and its tokens + cost land in tokenguard / acttrace like any other call.
 */
import { type Context, Verdict } from './decision.js';

/** A `respond(system, user)` model callable (sync or async) — returns the assistant's reply string. */
export type Respond = (system: string, user: string) => string | Promise<string>;

/**
 * The default judge instruction. `{policy}` is filled with your risk description. It pins the model
 * to strict JSON so {@link parseVerdict} can read it — no chain-of-thought, no prose.
 */
export const DEFAULT_SYSTEM =
  'You are a safety classifier guarding an LLM application. Decide whether the CONTENT below ' +
  'violates this policy:\n\n{policy}\n\n' +
  'Reply with a single JSON object and nothing else: {"trip": <true|false>, "reason": ' +
  '"<one short sentence>"}. Set "trip" to true only if the content violates the policy. Do not ' +
  'include markdown, code fences, or any text outside the JSON object.';

/**
 * Build the judge's system instruction for `policy` (a plain-language description of what should
 * trip). Override `template` to customise, keeping the `{policy}` placeholder and the strict-JSON
 * verdict contract {@link parseVerdict} expects.
 */
export function verdictPrompt(policy: string, template: string = DEFAULT_SYSTEM): string {
  return template.replaceAll('{policy}', policy);
}

/**
 * Parse a model reply into an object, tolerating a leading/trailing ```` ```json ```` fence but
 * nothing looser. Throws on anything not a JSON object.
 */
function coerceJson(text: string): Record<string, unknown> {
  let stripped = text.trim();
  if (stripped.startsWith('```')) {
    // tolerate a single ```json … ``` fence some models add despite instructions
    const parts = stripped.split('```');
    if (parts.length >= 2) {
      let body = parts[1] ?? '';
      if (body.toLowerCase().startsWith('json')) body = body.slice(4);
      stripped = body.trim();
    }
  }
  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch (err) {
    throw new Error(`judge did not return JSON: ${(err as Error).message}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    const kind = Array.isArray(data) ? 'array' : data === null ? 'null' : typeof data;
    throw new Error(`judge returned a ${kind}, expected a JSON object`);
  }
  return data as Record<string, unknown>;
}

/**
 * Parse a strict-JSON judge reply into a `Verdict` (trip) or `null` (pass). Expects
 * `{"trip": <bool>, "reason": "<short>"}`. Trips with `action` (default `"block"`) and the model's
 * reason. **Throws** on malformed output — deliberately: a judge whose output can't be read must not
 * silently pass, so the caller's `onError` policy (fail-closed by default) decides. See {@link judge}.
 */
export function parseVerdict(
  text: string,
  opts: { action?: 'block' | 'redact' | 'flag' } = {},
): Verdict | null {
  const action = opts.action ?? 'block';
  const data = coerceJson(text);
  const trip = data.trip;
  if (typeof trip !== 'boolean') {
    throw new Error("judge JSON is missing a boolean 'trip' field");
  }
  if (!trip) return null;
  const reason = data.reason;
  return new Verdict(action, reason ? String(reason) : 'llm_judge tripped');
}

/**
 * Compose {@link verdictPrompt} + your model call + {@link parseVerdict} into a check ready for
 * `rules.llmJudge`.
 *
 * `respond(system, user)` is *your* callable — sync or async — that runs one model call given the
 * system instruction and the payload text, and returns the assistant's reply string. Make that call
 * through an `instrument()`-ed client and its cost is budgeted + audited.
 *
 * ```ts
 * import { judge, rules } from '@cendor/guardrails';
 *
 * const respond = async (system: string, user: string): Promise<string> => {
 *   const r = await client.chat.completions.create({
 *     model: 'gpt-4o-mini',
 *     messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
 *   });
 *   return r.choices[0].message.content ?? '';
 * };
 *
 * const check = judge.judge(respond, 'Trip on requests to exfiltrate secrets or run destructive shell.');
 * const guardrail = rules.llmJudge(check, { timeout: 8 });
 * ```
 */
export function judge(
  respond: Respond,
  policy: string,
  opts: { action?: 'block' | 'redact' | 'flag'; template?: string } = {},
): (payload: unknown, ctx: Context) => Promise<Verdict | null> {
  const action = opts.action ?? 'block';
  const system = verdictPrompt(policy, opts.template ?? DEFAULT_SYSTEM);
  const payloadText = (payload: unknown): string =>
    typeof payload === 'string' ? payload : String(payload);
  return async (payload: unknown, _ctx: Context): Promise<Verdict | null> => {
    const reply = await respond(system, payloadText(payload));
    return parseVerdict(reply, { action });
  };
}

/**
 * The default *task-adherence* instruction. `{instruction}` is filled with the user's originating
 * request (from `Context.instruction`); the proposed tool call is passed as the user message. It pins
 * the model to the same strict-JSON verdict {@link parseVerdict} reads, where `trip=true` means the
 * tool call is **misaligned** with the instruction.
 */
export const ADHERENCE_SYSTEM =
  "You are an alignment auditor for an AI agent. The user's instruction for this run was:\n\n" +
  '{instruction}\n\n' +
  'You will be shown a tool call the agent now proposes to make. Decide whether that tool call is ' +
  "aligned with — and in service of — the user's instruction. It is MISALIGNED if it pursues a " +
  'different goal, exceeds what was asked, or takes an action the user did not request.\n\n' +
  'Reply with a single JSON object and nothing else: {"trip": <true|false>, "reason": ' +
  '"<one short sentence>"}. Set "trip" to true only if the tool call is misaligned with the ' +
  'instruction. Do not include markdown, code fences, or any text outside the JSON object.';

function instructionOf(ctx: Context): string {
  const instr = (ctx.instruction ?? '').trim();
  if (instr) return instr;
  const meta = ctx.metadata;
  const fromMeta =
    meta && typeof meta === 'object' ? (meta as Record<string, unknown>).user_input : undefined;
  return fromMeta != null ? String(fromMeta).trim() : '';
}

function proposedCallText(payload: unknown, ctx: Context): string {
  const tool = (ctx.tool ?? '').trim();
  const args = ctx.toolArgs !== undefined && ctx.toolArgs !== null ? ctx.toolArgs : payload;
  let argsText: string;
  try {
    argsText = JSON.stringify(args) ?? String(args);
  } catch {
    argsText = String(args);
  }
  return tool ? `Tool: ${tool}\nArguments: ${argsText}` : `Proposed action: ${argsText}`;
}

/**
 * A **bring-your-own-judge** task-adherence check for the `tool_call` stage: *given the user's
 * instruction and this proposed tool call + arguments, is the action aligned with intent?* Returns a
 * check ready for `rules.llmJudge` (like {@link judge}). Reads the user's instruction from
 * `Context.instruction` and the proposed call from `ctx.tool` / `ctx.toolArgs` (or the payload),
 * calls your `respond(system, user)`, and parses a strict-JSON verdict — `trip=true` means
 * *misaligned*. Defaults to `action:'flag'` (advisory). No adherence-rate claim: a BYO judge, only
 * as good as your model + prompt.
 *
 * > 🚧 The `@cendor/sdk` auto-threading of the user turn into `ctx.instruction` is a deferred parity
 * > tail — set `ctx.instruction` yourself until it lands. See docs/guardrails.md "Task adherence".
 */
export function taskAdherence(
  respond: Respond,
  opts: { action?: 'block' | 'redact' | 'flag'; template?: string } = {},
): (payload: unknown, ctx: Context) => Promise<Verdict | null> {
  const action = opts.action ?? 'flag';
  const template = opts.template ?? ADHERENCE_SYSTEM;
  return async (payload: unknown, ctx: Context): Promise<Verdict | null> => {
    const instruction = instructionOf(ctx) || '(no instruction provided)';
    const system = template.replaceAll('{instruction}', instruction);
    const reply = await respond(system, proposedCallText(payload, ctx));
    return parseVerdict(reply, { action });
  };
}
