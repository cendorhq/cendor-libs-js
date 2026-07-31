/**
 * `@cendor/contextkit` — assemble context within a token budget, with a receipt. The TypeScript port
 * of `cendor.contextkit`.
 *
 * Treat the context window like a packed suitcase: declare {@link Block}s with priority, pin, and a
 * per-block eviction rule; {@link Context.assemble} packs them to a token budget (deterministically)
 * and {@link Context.report} returns the receipt — what was kept, shrunk, or dropped, with the token
 * math. Depends only on `@cendor/core` (`tokens` + the `Compressor`/`EvictionStrategy` protocols).
 * Tools never import each other; `squeeze` plugs in by shape via the optional `@cendor/squeeze` peer.
 *
 * The receipt is honest at the **message** level: budgeting charges the per-message framing overhead
 * that providers add around every turn (self-calibrated from `core.tokens`), so `report().used`
 * equals `tokens.count(await assemble(), model)` for text content — what the model actually sees.
 *
 * Parity note: the Python module has a sync `assemble` and an async `aassemble`; this port collapses
 * them into a single `async assemble()` that awaits summarizers (sync or async) and the compressor.
 * The Python "sync path falls back to truncation for an async summarizer" behavior therefore has no
 * analog here — async summarizers are simply awaited.
 */
import { bus, tokens } from '@cendor/core';
import type { EvictionStrategy, Handle } from '@cendor/core';

// ---------------------------------------------------------------------------- public shapes / types

/** A multimodal content part (`{type, text?, image_url?}`), passed through unchanged. */
export type Part = Record<string, unknown>;

/** Single-message block content: plain text, or a list of multimodal parts. */
export type Content = string | Part[];

/** A provider-ready chat message. */
export type Msg = { role: string; content: Content };

/** A conversation turn in a `messages` block (`{role, content, ...}`). */
export type Turn = Record<string, unknown>;

/** Built-in eviction strategies; `Block.evict` also accepts any `EvictionStrategy` object. */
export type EvictStrategy = 'drop_oldest' | 'truncate' | 'summarize' | 'compress';

/**
 * What a {@link Context} does when a block asks for `evict: 'compress'` and no compressor is
 * available.
 *
 * The block is TRUNCATED in that case — lossy, and not reversible the way a compression is (a
 * squeeze compression hands back a `Handle` you can `.expand()`). This chooses how visible that
 * substitution is: `'note'` is the historical behaviour (recorded on the block's
 * {@link BlockDecision} and nothing else), `'warn'` also logs a warning, and `'error'` throws a
 * {@link MissingCompressorError} rather than quietly truncating. Default `'note'` — additive, and no
 * existing assembly changes.
 */
export type MissingCompressorMode = 'note' | 'warn' | 'error';
const MISSING_COMPRESSOR_MODES = ['note', 'warn', 'error'] as const;

/**
 * Thrown (only under `onMissingCompressor: 'error'`) instead of truncating a `compress` block for
 * which no compressor is available.
 */
export class MissingCompressorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingCompressorError';
  }
}

/** A summarize callback `(content, targetTokens) -> summary` (sync or async). */
export type Summarizer = (content: string, targetTokens: number) => string | Promise<string>;

/** A Gemini `contents[]` entry produced by {@link Context.forGemini}. */
export type GeminiContent = { role: string; parts: Part[] };

// -------------------------------------------------------------------------------------- exceptions

/** Raised when pinned blocks alone exceed the budget (they are never evicted). */
export class BudgetError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'BudgetError';
  }
}

/** Mirrors Python's `ValueError` — invalid construction arguments. */
export class ValueError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'ValueError';
  }
}

/** Mirrors Python's `RuntimeError` — `report()` before `assemble()`. */
export class RuntimeError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'RuntimeError';
  }
}

// ------------------------------------------------------------------------ compressor global default

// Optional process-wide default compressor for evict="compress" blocks. contextkit doesn't care
// *who* compresses — only that it matches core's Compressor protocol by shape. By default it
// auto-discovers `@cendor/squeeze` (the deterministic, zero-dep backend); set this to swap in any
// other backend globally.
let _defaultCompressor: unknown = null;

/**
 * Set the default compressor for `evict="compress"` blocks; returns the previous one.
 *
 * Accepts anything matching core's `Compressor` protocol — a `compress(content, opts)` object or a
 * `(text, opts) => [small, handle]` callable — so you can plug in an alternative backend without
 * touching call sites. Pass `null` to clear (falls back to auto-discovering `@cendor/squeeze`). A
 * per-`Context` `compressor` option still overrides this default.
 *
 * @example
 * ```ts
 * import { useCompressor } from '@cendor/contextkit';
 * useCompressor((text: string) => [text, null]);   // plug a `(text, opts) => [small, handle]` backend
 * ```
 */
export function useCompressor(compressor: unknown): unknown {
  const previous = _defaultCompressor;
  _defaultCompressor = compressor;
  return previous;
}

// --------------------------------------------------------------------------- framing calibration

// Per-model (priming, per_message) framing overhead, derived once from core.tokens' public API:
// count([one empty msg]) = priming + per_message; the delta to two empty msgs isolates per_message.
// This stays correct for any registered tokenizer without importing core internals.
const _framingCache = new Map<string, [number, number]>();

/** Return `[priming, perMessage]` token overhead for `model`, per `core.tokens`. */
function framing(model: string): [number, number] {
  const cached = _framingCache.get(model);
  if (cached !== undefined) return cached;
  const one = tokens.count([{ role: 'user', content: '' }], model);
  const two = tokens.count(
    [
      { role: 'user', content: '' },
      { role: 'user', content: '' },
    ],
    model,
  );
  const perMessage = Math.max(0, two - one);
  const priming = Math.max(0, one - perMessage);
  const value: [number, number] = [priming, perMessage];
  _framingCache.set(model, value);
  return value;
}

// -------------------------------------------------------------------------------------- constants

// Default render order: system first, history/context middle, the user turn last.
const ROLE_RANK: Record<string, number> = {
  system: 0,
  history: 1,
  tool: 1,
  assistant: 2,
  user: 3,
};
const ORDERS = ['default', 'attention', 'cache'] as const;

// A short, honest marker appended (head) or prepended (tail) so a truncated block reads as cut.
// The ellipsis is the single Unicode character U+2026 (…), NOT three dots.
const TRUNC_MARK: Record<'head' | 'tail', string> = {
  head: '\n…[truncated]',
  tail: '[truncated]…\n',
};

// ------------------------------------------------------------------------------------- data model

/** Options for {@link Block}. Also the first-argument form for `messages`-only blocks. */
export interface BlockOpts {
  content?: Content | null;
  priority?: number;
  pin?: boolean;
  evict?: EvictStrategy | EvictionStrategy;
  role?: string;
  summarizer?: Summarizer | null;
  keep?: 'head' | 'tail';
  messages?: Turn[] | null;
}

/**
 * A unit of context with packing intent.
 *
 * Provide **exactly one** of `content` (a single message, text or multimodal parts) or `messages`
 * (a conversation segment — a list of `{role, content}` turns that `evict="drop_oldest"` shrinks by
 * peeling the *oldest* turns until it fits).
 *
 * Construct positionally with the content first (`new Block('hi', { priority: 5, role: 'system' })`)
 * or via an options object for `messages` blocks (`new Block({ messages: [...], priority: 5 })`).
 *
 * @example
 * ```ts
 * import { Block } from '@cendor/contextkit';
 * ctx.add(new Block(SYSTEM_PROMPT, { priority: 10, pin: true, role: 'system' }));
 * // note: an { evict: 'compress' } block additionally needs @cendor/squeeze installed
 * ```
 */
export class Block {
  content: Content | null;
  priority: number;
  pin: boolean;
  evict: EvictStrategy | EvictionStrategy;
  role: string;
  summarizer: Summarizer | null;
  keep: 'head' | 'tail';
  messages: Turn[] | null;

  constructor(contentOrOpts?: Content | BlockOpts, opts?: BlockOpts) {
    const contentFirst = typeof contentOrOpts === 'string' || Array.isArray(contentOrOpts);
    const options: BlockOpts =
      (contentFirst ? opts : (contentOrOpts as BlockOpts | undefined)) ?? {};
    const contentArg = contentFirst ? (contentOrOpts as Content) : options.content;

    this.content = contentArg ?? null;
    this.priority = options.priority ?? 0;
    this.pin = options.pin ?? false;
    this.evict = options.evict ?? 'drop_oldest';
    this.role = options.role ?? 'user';
    this.summarizer = options.summarizer ?? null;
    this.keep = options.keep ?? 'head';
    this.messages = options.messages ?? null;

    if ((this.content === null) === (this.messages === null)) {
      throw new ValueError('Block requires exactly one of content= or messages=');
    }
    if (this.keep !== 'head' && this.keep !== 'tail') {
      throw new ValueError(`keep must be 'head' or 'tail', got ${JSON.stringify(this.keep)}`);
    }
    if (
      this.messages !== null &&
      !this.messages.every(
        (t) => t !== null && typeof t === 'object' && 'role' in t && 'content' in t,
      )
    ) {
      throw new ValueError("each item in messages= must be a {'role', 'content'} dict");
    }
  }
}

/**
 * What happened to one block during assembly (a line on the receipt).
 *
 * `tokensBefore`/`tokensAfter` are *content* tokens (framing-exclusive); the report's `used`
 * additionally accounts for per-message framing.
 */
export class BlockDecision {
  role: string;
  action: string; // "kept" | "truncated" | "summarized" | "compressed" | "dropped" | "evicted"
  tokensBefore: number;
  tokensAfter: number;
  note: string;
  // For a "compressed" block, the reversible squeeze Handle — call `.expand()` to restore the
  // original content. `null` for every other action.
  handle: Handle | null;

  constructor(
    role: string,
    action: string,
    tokensBefore: number,
    tokensAfter: number,
    note = '',
    handle: Handle | null = null,
  ) {
    this.role = role;
    this.action = action;
    this.tokensBefore = tokensBefore;
    this.tokensAfter = tokensAfter;
    this.note = note;
    this.handle = handle;
  }
}

/**
 * The receipt: budget math + per-block decisions.
 *
 * `used` is the message-level token count of the assembled prompt (content + framing), so it equals
 * `tokens.count(messages, model)` for text content; multimodal image budget is also charged into
 * `used` even though `core.tokens` can't see image parts.
 */
export class AssemblyReport {
  budget: number;
  used: number;
  reservedOutput: number;
  model: string;
  decisions: BlockDecision[];
  order: string;

  constructor(
    budget: number,
    used: number,
    reservedOutput: number,
    model: string,
    decisions: BlockDecision[] = [],
    order = 'default',
  ) {
    this.budget = budget;
    this.used = used;
    this.reservedOutput = reservedOutput;
    this.model = model;
    this.decisions = decisions;
    this.order = order;
  }

  toString(): string {
    const lines = [
      `AssemblyReport(model=${this.model}, order=${this.order}) ` +
        `budget=${this.budget} reserved_output=${this.reservedOutput} ` +
        `used=${this.used}/${this.budget - this.reservedOutput}`,
    ];
    for (const d of this.decisions) {
      const arrow = `${d.tokensBefore}->${d.tokensAfter}tok`;
      const note = d.note ? `  # ${d.note}` : '';
      lines.push(`  [${d.action.padEnd(10)}] ${d.role.padEnd(9)} ${arrow}${note}`);
    }
    return lines.join('\n');
  }
}

// -------------------------------------------------------------------- internal packing structures

interface PackState {
  used: number;
  hasMsgs: boolean;
  decisions: BlockDecision[];
  kept: Kept[];
}

/** A kept entry: `[insertionIndex, block, renderedMessages]`. */
type Kept = [number, Block, Msg[]];

interface BlockPlan {
  status: 'kept' | 'dropped' | 'evict';
  used?: number;
  message?: Msg;
  decision?: BlockDecision;
  contentBudget?: number;
  prim?: number;
  contentTokens?: number;
  text?: string;
}

// ------------------------------------------------------------------------------- the assembler

/**
 * A token-budgeted, declarative context assembler.
 *
 * `order` controls how kept blocks are arranged in the final messages:
 * - `"default"` — role-grouped: system -> history/context -> the user turn.
 * - `"attention"` — "lost-in-the-middle": highest-priority context blocks ride the edges, weakest
 *   in the dead center.
 * - `"cache"` — stable prefix first (pinned, high-priority blocks lead) to maximize prompt-cache
 *   hits across calls.
 */
export interface ContextOpts {
  budgetTokens: number;
  model: string;
  reserveOutput?: number;
  compressor?: unknown;
  order?: string;
  imageTokens?: number | ((part: Part) => number);
  onMissingCompressor?: MissingCompressorMode;
}

/**
 * A token-budgeted context assembler: construct with a budget + model, {@link Context.add} blocks,
 * then `await` {@link Context.assemble}. See {@link ContextOpts} for `order` and the other options.
 *
 * @example
 * ```ts
 * import { Context } from '@cendor/contextkit';
 * const ctx = new Context({ budgetTokens: 8000, model: 'gpt-4o', reserveOutput: 1000 });
 * ```
 */
export class Context {
  budgetTokens: number;
  model: string;
  reserveOutput: number;
  order: string;
  imageTokens: number | ((part: Part) => number);
  onMissingCompressor: MissingCompressorMode;
  private _compressor: unknown;
  private blocks: Block[];
  private _report: AssemblyReport | null;
  private _messages: Msg[];

  constructor(opts: ContextOpts) {
    const order = opts.order ?? 'default';
    if (!(ORDERS as readonly string[]).includes(order)) {
      throw new ValueError(
        `order must be one of ${ORDERS.join(', ')}, got ${JSON.stringify(opts.order)}`,
      );
    }
    this.budgetTokens = opts.budgetTokens;
    this.model = opts.model;
    this.reserveOutput = opts.reserveOutput ?? 0;
    this._compressor = opts.compressor ?? null;
    this.order = order;
    const onMissing = opts.onMissingCompressor ?? 'note';
    if (!(MISSING_COMPRESSOR_MODES as readonly string[]).includes(onMissing)) {
      throw new ValueError(
        `onMissingCompressor must be one of ${MISSING_COMPRESSOR_MODES.join(', ')}, got ` +
          `${JSON.stringify(opts.onMissingCompressor)}`,
      );
    }
    this.onMissingCompressor = onMissing;
    // Token cost per image part in multimodal blocks: a flat int, or a callable
    // (part -> tokens) for resolution-aware estimates.
    this.imageTokens = opts.imageTokens ?? 0;
    this.blocks = [];
    this._report = null;
    this._messages = [];
  }

  /** Add a block. Returns `this` for chaining. */
  add(block: Block): this {
    this.blocks.push(block);
    return this;
  }

  /**
   * Pack blocks within the budget; return provider-ready messages (OpenAI/Foundry shape).
   *
   * Deterministic: stable sort by `(pinned, priority, insertion order)`. Awaits summarizers and the
   * compressor, then emits the {@link AssemblyReport} onto core's bus.
   *
   * @example
   * ```ts
   * import { Context } from '@cendor/contextkit';
   * const ctx = new Context({ budgetTokens: 8000, model: 'gpt-4o' });
   * const messages = await ctx.assemble();   // async in TS (Python: sync assemble() + async aassemble())
   * ```
   */
  async assemble(): Promise<Msg[]> {
    const [messages, report] = await this.pack(this.budgetTokens, true);
    this._messages = messages;
    this._report = report;
    return messages;
  }

  /** Return the receipt for the most recent {@link assemble}. Throws before the first one. */
  report(): AssemblyReport {
    if (this._report === null) {
      throw new RuntimeError('call assemble() before report()');
    }
    return this._report;
  }

  /** Preview the assembly at a different budget without committing (no bus emit). */
  async whatif(budgetTokens: number): Promise<AssemblyReport> {
    const [, report] = await this.pack(budgetTokens, false);
    return report;
  }

  /**
   * Anthropic adapter: split system blocks out (the Messages API takes `system` apart).
   *
   * Returns `[systemText, messages]`. The Messages API accepts only `user`/`assistant` roles, so any
   * other role (e.g. `tool`) is coerced to `user`. Multimodal content is passed through unchanged.
   */
  async forAnthropic(): Promise<[string, Msg[]]> {
    if (this._messages.length === 0) await this.assemble();
    const rest: Msg[] = this._messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    return [this.systemText(), rest];
  }

  /**
   * Gemini adapter: returns `[systemInstruction, contents]`.
   *
   * `contents` are `{role: "user"|"model", parts: [...]}` (Gemini uses `model`, not `assistant`);
   * system blocks become the separate `systemInstruction`. Content is normalized to Gemini parts.
   */
  async forGemini(): Promise<[string, GeminiContent[]]> {
    if (this._messages.length === 0) await this.assemble();
    const contents: GeminiContent[] = this._messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: partsOf(m.content) }));
    return [this.systemText(), contents];
  }

  /**
   * Bedrock Converse adapter: returns `[system, messages]`.
   *
   * `system` is `[{text: ...}]` (or empty); `messages` are `{role: "user"|"assistant", content:
   * [...]}` — Bedrock allows only those two roles, so non-user blocks map to `assistant`.
   */
  async forBedrock(): Promise<[Array<{ text: string }>, Array<{ role: string; content: Part[] }>]> {
    if (this._messages.length === 0) await this.assemble();
    const systemText = this.systemText();
    const system = systemText ? [{ text: systemText }] : [];
    const messages = this._messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: partsOf(m.content),
      }));
    return [system, messages];
  }

  // ---------------------------------------------------------------------------------- internals

  /** Join the text of all assembled system messages (adapters split `system` out). */
  private systemText(): string {
    return this._messages
      .filter((m) => m.role === 'system')
      .map((m) => textOf(m.content))
      .join('\n\n');
  }

  private orderedBlocks(): [number, Block][] {
    // (not pin) -> pinned (false=0) sorts first; then priority desc; then insertion order.
    const indexed: [number, Block][] = this.blocks.map((b, i) => [i, b]);
    return indexed.sort(byKey(([i, b]) => [Number(!b.pin), -b.priority, i]));
  }

  private imageCost(part: Part): number {
    const it = this.imageTokens;
    return typeof it === 'function' ? it(part) : it;
  }

  /** Token cost of content, charging `imageTokens` per image part in multimodal lists. */
  private contentTokens(content: Content | null): number {
    if (Array.isArray(content)) {
      let text = '';
      for (const p of content) {
        if (p !== null && typeof p === 'object' && 'text' in p) {
          const t = (p as Record<string, unknown>).text;
          text += typeof t === 'string' ? t : String(t ?? '');
        }
      }
      let n = text ? tokens.count(text, this.model) : 0;
      for (const p of content) {
        if (p !== null && typeof p === 'object') {
          const type = (p as Record<string, unknown>).type;
          if (type === 'image' || type === 'image_url') n += this.imageCost(p);
        }
      }
      return n;
    }
    return tokens.count(String(content), this.model);
  }

  private finish(
    budgetTokens: number,
    used: number,
    decisions: BlockDecision[],
    kept: Kept[],
    emit: boolean,
  ): [Msg[], AssemblyReport] {
    const ordered = orderBlocks(kept, this.order);
    const messages: Msg[] = [];
    for (const [, , blockMessages] of ordered) messages.push(...blockMessages);
    const report = new AssemblyReport(
      budgetTokens,
      used,
      this.reserveOutput,
      this.model,
      decisions,
      this.order,
    );
    if (emit) bus.emit(report);
    return [messages, report];
  }

  /** Pack blocks within the budget. Awaits the evictor (summarizers / compressor). */
  private async pack(budgetTokens: number, emit: boolean): Promise<[Msg[], AssemblyReport]> {
    const [priming, perMessage] = framing(this.model);
    const effective = Math.max(0, budgetTokens - this.reserveOutput);
    const state: PackState = { used: 0, hasMsgs: false, decisions: [], kept: [] };
    for (const [idx, block] of this.orderedBlocks()) {
      if (block.messages !== null) {
        this.packHistoryInto(block, idx, effective, priming, perMessage, state);
        continue;
      }
      const plan = this.planBlock(block, effective, state, priming, perMessage);
      if (plan.status === 'evict') {
        const [newText, action, note, handle] = await this.evict(
          block,
          plan.text ?? '',
          plan.contentBudget ?? 0,
        );
        this.applyEvicted(idx, block, plan, perMessage, newText, action, note, state, handle);
      } else {
        this.applyPlan(idx, block, plan, state);
      }
    }
    return this.finish(budgetTokens, state.used, state.decisions, state.kept, emit);
  }

  /**
   * Decide a single-message block's fate up to (not performing) eviction. Throws {@link BudgetError}
   * on pinned overflow.
   */
  private planBlock(
    block: Block,
    effective: number,
    state: PackState,
    priming: number,
    perMessage: number,
  ): BlockPlan {
    const contentTokens = this.contentTokens(block.content);
    // Priming is charged ONCE, attributed to the first admitted message.
    const prim = state.hasMsgs ? 0 : priming;
    if (state.used + prim + perMessage + contentTokens <= effective) {
      return {
        status: 'kept',
        used: state.used + prim + perMessage + contentTokens,
        message: { role: block.role, content: block.content as Content },
        decision: new BlockDecision(block.role, 'kept', contentTokens, contentTokens),
      };
    }
    if (block.pin) {
      throw new BudgetError(
        `pinned block(s) exceed budget: need ${prim + perMessage + contentTokens} ` +
          `tokens (${contentTokens} content + ${prim + perMessage} framing), ` +
          `${effective - state.used} of ${effective} remaining ` +
          `(reserve_output=${this.reserveOutput})`,
      );
    }
    if (typeof block.content !== 'string') {
      // Can't shrink a multimodal/list block.
      return {
        status: 'dropped',
        decision: new BlockDecision(
          block.role,
          'dropped',
          contentTokens,
          0,
          'multimodal: too large',
        ),
      };
    }
    const contentBudget = effective - state.used - prim - perMessage;
    if (contentBudget <= 0) {
      return {
        status: 'dropped',
        decision: new BlockDecision(block.role, 'dropped', contentTokens, 0, 'no room (framing)'),
      };
    }
    return { status: 'evict', contentBudget, prim, contentTokens, text: block.content };
  }

  /** Fold a non-evict plan ("kept" / "dropped") into the running state. */
  private applyPlan(idx: number, block: Block, plan: BlockPlan, state: PackState): void {
    if (plan.status === 'kept') {
      state.used = plan.used ?? state.used;
      state.hasMsgs = true;
      state.kept.push([idx, block, [plan.message as Msg]]);
    }
    state.decisions.push(plan.decision as BlockDecision);
  }

  /** Fold an evictor's result back into the running state. */
  private applyEvicted(
    idx: number,
    block: Block,
    plan: BlockPlan,
    perMessage: number,
    newText: string | null,
    action: string,
    note: string,
    state: PackState,
    handle: Handle | null,
  ): void {
    const contentTokens = plan.contentTokens ?? 0;
    if (newText === null) {
      state.decisions.push(new BlockDecision(block.role, 'dropped', contentTokens, 0, note));
      return;
    }
    const after = this.contentTokens(newText);
    state.used += (plan.prim ?? 0) + perMessage + after;
    state.hasMsgs = true;
    state.kept.push([idx, block, [{ role: block.role, content: newText }]]);
    state.decisions.push(new BlockDecision(block.role, action, contentTokens, after, note, handle));
  }

  /** Pack a multi-turn block into `state` (the messages-block branch). */
  private packHistoryInto(
    block: Block,
    idx: number,
    effective: number,
    priming: number,
    perMessage: number,
    state: PackState,
  ): void {
    const [turns, dec, used, hasMsgs] = this.packHistory(
      block,
      effective,
      state.used,
      state.hasMsgs,
      priming,
      perMessage,
    );
    state.used = used;
    state.hasMsgs = hasMsgs;
    if (turns.length) state.kept.push([idx, block, turns]);
    state.decisions.push(dec);
  }

  /**
   * Pack a multi-turn block: keep the newest turns that fit, peeling the oldest. `evict="truncate"`
   * additionally tail-trims the surviving newest turn when even it overflows.
   */
  private packHistory(
    block: Block,
    effective: number,
    used: number,
    hasMsgs: boolean,
    priming: number,
    perMessage: number,
  ): [Msg[], BlockDecision, number, boolean] {
    const turns = block.messages ?? [];
    const turnTokens = turns.map((t) => this.contentTokens(turnContent(t)));
    const totalBefore = turnTokens.reduce((a, b) => a + b, 0);
    const isTruncate = block.evict === 'truncate';

    if (block.pin) {
      const full = (hasMsgs ? 0 : priming) + perMessage * turns.length + totalBefore;
      if (used + full > effective) {
        throw new BudgetError(
          `pinned history block exceeds budget: needs ${full} tokens, ` +
            `${effective - used} of ${effective} remaining (reserve_output=${this.reserveOutput})`,
        );
      }
    }

    const kept: Msg[] = []; // built newest-first, reversed at the end
    let running = used;
    let localHas = hasMsgs;
    for (let i = turns.length - 1; i >= 0; i--) {
      const prim = localHas ? 0 : priming;
      const tt = turnTokens[i] ?? 0;
      if (running + prim + perMessage + tt <= effective) {
        running += prim + perMessage + tt;
        localHas = true;
        kept.push(turns[i] as Msg);
        continue;
      }
      if (isTruncate && kept.length === 0) {
        // The newest turn alone overflows -> tail-trim it.
        const budgetCt = effective - running - prim - perMessage;
        if (budgetCt > 0) {
          const trimmed = truncateToTokens(
            String(turnContent(turns[i] as Turn)),
            budgetCt,
            this.model,
            'tail',
          );
          running += prim + perMessage + this.contentTokens(trimmed);
          localHas = true;
          kept.push({ ...(turns[i] as Turn), content: trimmed } as Msg);
        }
      }
      break; // older turns are dropped (we keep a contiguous suffix of recent turns)
    }
    kept.reverse();

    const n = turns.length;
    const k = kept.length;
    const after = kept.reduce((a, t) => a + this.contentTokens(turnContent(t)), 0);
    let action: string;
    let note: string;
    if (n === 0) {
      action = 'kept'; // empty history: nothing to place, nothing dropped
      note = '';
    } else if (k === 0) {
      action = 'dropped';
      note = `history: dropped all ${n} turns (no room)`;
    } else if (k < n) {
      action = 'truncated';
      note = `history: kept ${k} of ${n} turns`;
      if (block.evict !== 'drop_oldest' && block.evict !== 'truncate') {
        note += `; '${String(block.evict)}' n/a for message blocks, peeled oldest`;
      }
    } else {
      action = 'kept';
      note = '';
    }
    const decision = new BlockDecision('history', action, totalBefore, after, note);
    return [kept, decision, running, localHas];
  }

  /**
   * Apply a block's eviction strategy. Returns `[contentOrNull, action, note, handle]`; a `null`
   * content means DROP. `contentBudget` is always > 0. Awaits async summarizers and the compressor.
   */
  private async evict(
    block: Block,
    text: string,
    contentBudget: number,
  ): Promise<[string | null, string, string, Handle | null]> {
    const strategy = block.evict;

    if (typeof strategy !== 'string') {
      // A core EvictionStrategy object.
      let result: [string | null, string];
      try {
        result = strategy.evict(text, contentBudget, this.model);
      } catch (exc) {
        // A custom strategy must never break assembly.
        return [null, 'dropped', `custom strategy raised: ${repr(exc)}`, null];
      }
      const [newVal, action] = result;
      if (newVal === null) return [null, 'dropped', action || '', null];
      let out = newVal;
      if (tokens.count(out, this.model) > contentBudget) {
        out = truncateToTokens(out, contentBudget, this.model, block.keep);
      }
      return [out, action || 'evicted', '', null];
    }

    if (strategy === 'drop_oldest') {
      return [null, 'dropped', 'block dropped whole (use messages= for turn-level eviction)', null];
    }

    if (strategy === 'truncate') {
      return [truncateToTokens(text, contentBudget, this.model, block.keep), 'truncated', '', null];
    }

    if (strategy === 'summarize') {
      if (block.summarizer !== null && block.summarizer !== undefined) {
        let summary = await block.summarizer(text, contentBudget);
        if (tokens.count(summary, this.model) > contentBudget) {
          summary = truncateToTokens(summary, contentBudget, this.model, block.keep);
        }
        return [summary, 'summarized', '', null];
      }
      return [
        truncateToTokens(text, contentBudget, this.model, block.keep),
        'truncated',
        'no summarizer; truncated',
        null,
      ];
    }

    if (strategy === 'compress') {
      const compressor = await this.getCompressor();
      if (compressor !== null && compressor !== undefined) {
        // Keep the squeeze Handle (reversibility is squeeze's USP) so report() exposes it.
        let [small, handle] = await callCompressor(compressor, text, contentBudget, this.model);
        if (tokens.count(small, this.model) > contentBudget) {
          small = truncateToTokens(small, contentBudget, this.model, block.keep);
        }
        return [small, 'compressed', '', handle];
      }
      // No compressor: the block is TRUNCATED instead — content is discarded, and unlike a
      // compression that is not reversible. The note has always been recorded here, but a note lives
      // in the AssemblyReport and nothing obliges a caller to read one, so a forgotten
      // `@cendor/squeeze` quietly degraded every compress block in production while the assembly
      // still reported success. `onMissingCompressor` picks how loud that is; the default is the
      // historical 'note', so nothing changes unless you ask for it.
      if (this.onMissingCompressor === 'error') {
        throw new MissingCompressorError(
          `a ${JSON.stringify(block.role)} block asked for evict: 'compress' but no compressor is available, so its content would be TRUNCATED (lossy, and not reversible the way a compression is). Install @cendor/squeeze, pass new Context({ compressor }), call useCompressor(...), or set onMissingCompressor: 'note' to accept truncation.`,
        );
      }
      if (this.onMissingCompressor === 'warn') {
        console.warn(
          `@cendor/contextkit: a ${JSON.stringify(block.role)} block asked for evict: 'compress' but no compressor is available; its content was TRUNCATED instead. Install @cendor/squeeze or pass compressor.`,
        );
      }
      return [
        truncateToTokens(text, contentBudget, this.model, block.keep),
        'truncated',
        'squeeze not installed; fell back to truncate',
        null,
      ];
    }

    return [null, 'dropped', `unknown evict strategy ${repr(strategy)}`, null];
  }

  private async getCompressor(): Promise<unknown> {
    if (this._compressor !== null && this._compressor !== undefined) return this._compressor; // per-Context override wins
    if (_defaultCompressor !== null && _defaultCompressor !== undefined) return _defaultCompressor; // process-wide default
    // Otherwise auto-discover `@cendor/squeeze` at runtime (the optional peer). The string-typed
    // specifier keeps this a soft dependency: if squeeze is not installed/built the import throws
    // and we fall back to truncation.
    try {
      const specifier: string = '@cendor/squeeze';
      const mod = (await import(specifier)) as Record<string, unknown>;
      return mod.compress ?? null;
    } catch {
      return null;
    }
  }
}

// ------------------------------------------------------------------------------ ordering helpers

/** A stable multi-key ascending comparator built from a numeric key tuple. */
function byKey<T>(keyFn: (t: T) => number[]): (a: T, b: T) => number {
  return (a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    for (let i = 0; i < ka.length; i++) {
      const d = (ka[i] ?? 0) - (kb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
}

/** The role a block is ordered by — `"history"` for a multi-turn (`messages`) block. */
function ordRole(block: Block): string {
  return block.messages !== null ? 'history' : block.role;
}

/** Arrange kept blocks for rendering per the chosen strategy. Deterministic. */
function orderBlocks(kept: Kept[], mode: string): Kept[] {
  if (mode === 'cache') {
    // Stable prefix: pinned, high-priority blocks lead so the prompt prefix is reused.
    return [...kept].sort(byKey(([i, b]) => [Number(!b.pin), -b.priority, i]));
  }
  if (mode === 'attention') {
    const systems = kept
      .filter((k) => ordRole(k[1]) === 'system')
      .sort(byKey((k) => [-k[1].priority, k[0]]));
    // Ascending -> the highest-priority user turn ends up last (strongest end position).
    const finals = kept
      .filter((k) => ordRole(k[1]) === 'user')
      .sort(byKey((k) => [k[1].priority, k[0]]));
    const middles = kept
      .filter((k) => {
        const r = ordRole(k[1]);
        return r !== 'system' && r !== 'user';
      })
      .sort(byKey((k) => [-k[1].priority, k[0]]));
    return [...systems, ...edgeLoad(middles), ...finals];
  }
  // default: role-grouped, insertion order within a role.
  return [...kept].sort(byKey((k) => [ROLE_RANK[ordRole(k[1])] ?? 1, k[0]]));
}

/** Edge-load a priority-descending list: highest at both edges, lowest in the center. */
function edgeLoad<T>(items: T[]): T[] {
  const left: T[] = [];
  const right: T[] = [];
  items.forEach((item, i) => {
    (i % 2 === 0 ? left : right).push(item);
  });
  return [...left, ...right.reverse()];
}

// --------------------------------------------------------------------- text / parts normalization

/** Plain text of message content — a string, or the text parts of a multimodal list. */
function textOf(content: Content): string {
  if (Array.isArray(content)) {
    let s = '';
    for (const p of content) {
      if (p !== null && typeof p === 'object' && 'text' in p) {
        const t = (p as Record<string, unknown>).text;
        s += typeof t === 'string' ? t : String(t ?? '');
      }
    }
    return s;
  }
  return String(content);
}

/** Normalize content to a list of parts (text parts as `{text: ...}`). */
function partsOf(content: Content): Part[] {
  if (Array.isArray(content)) {
    return content.map((p) =>
      p !== null && typeof p === 'object' && 'text' in p
        ? { text: (p as Record<string, unknown>).text }
        : p,
    );
  }
  return [{ text: String(content) }];
}

/** `t.get("content", "")` — a turn's content, defaulting to the empty string. */
function turnContent(t: Turn): Content {
  const c = (t as Record<string, unknown>).content;
  return (c ?? '') as Content;
}

// ---------------------------------------------------------------------------------- compressor call

/**
 * Call a Compressor-protocol object or a `compress`-style callable. Returns `[compressedText,
 * handle]`. Forwards `model` so the compressor sizes against the *context's* model; a legacy callable
 * that ignores `model` still works (JS ignores the extra option).
 */
async function callCompressor(
  compressor: unknown,
  text: string,
  target: number,
  model: string,
): Promise<[string, Handle | null]> {
  const opts = { targetTokens: target, model };
  if (
    compressor !== null &&
    typeof compressor === 'object' &&
    typeof (compressor as { compress?: unknown }).compress === 'function'
  ) {
    const fn = (compressor as { compress: (t: string, o: unknown) => unknown }).compress;
    return normalizeCompress(await fn.call(compressor, text, opts));
  }
  if (typeof compressor === 'function') {
    return normalizeCompress(await (compressor as (t: string, o: unknown) => unknown)(text, opts));
  }
  return [text, null];
}

function normalizeCompress(result: unknown): [string, Handle | null] {
  const arr = result as [unknown, unknown];
  return [String(arr[0]), (arr[1] as Handle | null) ?? null];
}

// -------------------------------------------------------------------------------- truncation

/** Binary-search the longest head/tail slice of `text` that fits `target` tokens (code-point aware). */
function hardCut(text: string, target: number, model: string, keep: string): string {
  if (target <= 0) return '';
  if (tokens.count(text, model) <= target) return text;
  const chars = [...text]; // code-point units, matching Python's character slicing
  let lo = 0;
  let hi = chars.length;
  let best = '';
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const cand =
      keep === 'head' ? chars.slice(0, mid).join('') : chars.slice(chars.length - mid).join('');
    if (tokens.count(cand, model) <= target) {
      best = cand;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Trim `text` to at most `target` tokens, keeping the `head` or `tail`, with a marker. The marker is
 * counted against `target` so the result never exceeds the budget; if there's no room for both
 * content and marker, the text is hard-cut without one.
 */
function truncateToTokens(
  text: string,
  target: number,
  model: string,
  keep: 'head' | 'tail' = 'head',
): string {
  if (target <= 0) return '';
  if (tokens.count(text, model) <= target) return text;
  const marker = TRUNC_MARK[keep];
  const bodyBudget = Math.max(0, target - tokens.count(marker, model));
  if (bodyBudget === 0) return hardCut(text, target, model, keep);
  const body = hardCut(text, bodyBudget, model, keep);
  return keep === 'head' ? body + marker : marker + body;
}

// ------------------------------------------------------------------------------------ misc

/** A small Python-`repr`-ish rendering for note strings (strings single-quoted). */
function repr(v: unknown): string {
  return typeof v === 'string' ? `'${v}'` : String(v);
}
