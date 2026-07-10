/**
 * Canonical data types shared across the Cendor stack — the cross-language vocabulary defined by the
 * bus-events spec (`events/1`). Type names (`Money`, `Usage`, `LLMCall`, `ToolCall`) are identical
 * across languages; field names map `snake_case` (Python) -> `camelCase` (TS) per the parity rules.
 */
import { Dec, type Decimal, type DecimalValue } from './decimal.js';

/**
 * A Decimal-backed monetary amount. **Never use a `number` for money.**
 *
 * Accepts `number` / `string` / `Decimal` for `amount` and coerces to `Decimal` (numbers via their
 * string form, to avoid binary-float noise). Arithmetic and comparisons require a matching
 * `currency`. Scalar serialization is the string `"{amount} {currency}"` (e.g. `"0.0025 USD"`).
 *
 * @example
 * ```ts
 * import { Money } from '@cendor/core';
 * const price = new Money('0.0025');   // pass a string or Decimal — a number works but risks float noise
 * ```
 */
export class Money {
  readonly amount: Decimal;
  readonly currency: string;

  constructor(amount: DecimalValue, currency = 'USD') {
    // Coerce a JS number via its string form (mirrors Python's Decimal(str(x))), so 0.1 does not
    // pick up binary-float noise. Strings and Decimals pass straight through.
    this.amount =
      amount instanceof Dec
        ? amount
        : new Dec(typeof amount === 'number' ? String(amount) : amount);
    this.currency = currency;
  }

  /** A zero amount in the given currency. */
  static zero(currency = 'USD'): Money {
    return new Money(new Dec(0), currency);
  }

  private check(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(`currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }

  add(other: Money): Money {
    this.check(other);
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  sub(other: Money): Money {
    this.check(other);
    return new Money(this.amount.minus(other.amount), this.currency);
  }

  mul(scalar: DecimalValue): Money {
    return new Money(
      this.amount.times(typeof scalar === 'number' ? String(scalar) : scalar),
      this.currency,
    );
  }

  eq(other: Money): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }

  lt(other: Money): boolean {
    this.check(other);
    return this.amount.lessThan(other.amount);
  }

  le(other: Money): boolean {
    this.check(other);
    return this.amount.lessThanOrEqualTo(other.amount);
  }

  gt(other: Money): boolean {
    this.check(other);
    return this.amount.greaterThan(other.amount);
  }

  ge(other: Money): boolean {
    this.check(other);
    return this.amount.greaterThanOrEqualTo(other.amount);
  }

  /** `"{amount} {currency}"`, e.g. `"0.0025 USD"`. */
  toString(): string {
    return `${this.amount.toString()} ${this.currency}`;
  }
}

/** Sum a list of Money (empty -> zero in `currency`). Mirrors Python's `sum([...])` over Money. */
export function sumMoney(items: Money[], currency = 'USD'): Money {
  let total = Money.zero(currency);
  for (const m of items) total = total.add(m);
  return total;
}

export interface UsageInit {
  inputTokens: number;
  outputTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  cacheWrite?: number;
}

/**
 * Token usage for a single LLM call. `cachedTokens` is a *subset of* `inputTokens` and
 * `reasoningTokens` is a *subset of* `outputTokens` — breakdowns, not extra tokens, so neither is
 * added into `totalTokens`. `cacheWrite` is a **separate** billed category (not part of input).
 */
export class Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly reasoningTokens: number;
  readonly cacheWrite: number;

  constructor(init: UsageInit) {
    this.inputTokens = init.inputTokens;
    this.outputTokens = init.outputTokens ?? 0;
    this.cachedTokens = init.cachedTokens ?? 0;
    this.reasoningTokens = init.reasoningTokens ?? 0;
    this.cacheWrite = init.cacheWrite ?? 0;
  }

  /** input + output (cached/reasoning are subsets; cacheWrite is billed separately, not added). */
  get totalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }
}

/** A provider-native chat message (passed through unchanged; not further normalized). */
export type Message = Record<string, unknown>;

export interface LLMCallInit {
  id: string;
  provider: string;
  model: string;
  messages: Message[];
  usage?: Usage | null;
  cost?: Money | null;
  latencyMs?: number | null;
  traceId?: string;
  ts?: Date | null;
  metadata?: Record<string, unknown>;
}

/** A normalized, provider-agnostic record of one model call. Emitted on the bus. */
export class LLMCall {
  id: string;
  provider: string;
  model: string;
  messages: Message[];
  usage: Usage | null;
  cost: Money | null;
  latencyMs: number | null;
  traceId: string;
  ts: Date | null;
  metadata: Record<string, unknown>;

  constructor(init: LLMCallInit) {
    this.id = init.id;
    this.provider = init.provider;
    this.model = init.model;
    this.messages = init.messages;
    this.usage = init.usage ?? null;
    this.cost = init.cost ?? null;
    this.latencyMs = init.latencyMs ?? null;
    this.traceId = init.traceId ?? '';
    this.ts = init.ts ?? null;
    this.metadata = init.metadata ?? {};
  }
}

export interface ToolCallInit {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  latencyMs?: number | null;
  traceId?: string;
  ts?: Date | null;
  metadata?: Record<string, unknown>;
}

/** A normalized record of one tool invocation. Emitted when a tool is instrumented. */
export class ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
  latencyMs: number | null;
  traceId: string;
  ts: Date | null;
  metadata: Record<string, unknown>;

  constructor(init: ToolCallInit) {
    this.id = init.id;
    this.name = init.name;
    this.arguments = init.arguments;
    this.result = init.result ?? null;
    this.latencyMs = init.latencyMs ?? null;
    this.traceId = init.traceId ?? '';
    this.ts = init.ts ?? null;
    this.metadata = init.metadata ?? {};
  }
}
