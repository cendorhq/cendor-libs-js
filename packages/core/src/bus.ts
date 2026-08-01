/**
 * In-process pub/sub event bus: one `instrument()` emits, many tools subscribe. Mirrors
 * `cendor.core.bus`. JavaScript is single-threaded, so there is no lock — but `emit` still fans out
 * over a *snapshot* so a subscriber may (un)subscribe from inside a callback without corrupting the
 * iteration.
 */

export type Subscriber = (event: unknown) => void;

const subscribers: Subscriber[] = [];

/** Register a subscriber. Idempotent: re-registering the same function is a no-op. Returns `fn`. */
export function subscribe(fn: Subscriber): Subscriber {
  if (!subscribers.includes(fn)) subscribers.push(fn);
  return fn;
}

/** Remove a subscriber (no error if absent) — the inverse of {@link subscribe}. */
export function unsubscribe(fn: Subscriber): void {
  const i = subscribers.indexOf(fn);
  if (i >= 0) subscribers.splice(i, 1);
}

/**
 * Publish an event to every subscriber (synchronous). Every subscriber runs even if an earlier one
 * throws, so one tool's failure can't starve another; the first error raised is re-thrown after all
 * subscribers have run, so intentional control flow (e.g. tokenguard's post-flight `BudgetExceeded`)
 * still reaches the caller.
 */
export function emit(event: unknown): void {
  const snapshot = [...subscribers];
  let firstError: unknown;
  let hasError = false;
  for (const fn of snapshot) {
    try {
      fn(event);
    } catch (err) {
      if (!hasError) {
        firstError = err;
        hasError = true;
      }
    }
  }
  if (hasError) throw firstError;
}

/**
 * `true` when at least one subscriber is registered.
 *
 * Lets an emitter skip *building* an expensive event nobody would receive — `@cendor/squeeze` uses
 * it to skip the two `tokens.count` passes that fill its `CompressionEvent` when nothing is
 * listening (measured at ~93% of a large `compress()`). It answers "is anyone on the bus", not
 * "is anyone listening for *this* event type".
 *
 * @example
 * ```ts
 * import { bus } from '@cendor/core';
 * if (bus.hasSubscribers()) bus.emit({ kind: 'my.expensive.event' });
 * ```
 */
export function hasSubscribers(): boolean {
  return subscribers.length > 0;
}

/**
 * Test helper: how many subscribers are registered. Used by the local-first pins — with OTel absent,
 * auto-wiring must subscribe **nothing** (zero added bus cost), and a manual attachment plus the auto
 * one must never both be subscribed.
 */
export function _subscriberCount(): number {
  return subscribers.length;
}

/** Test helper: clear all subscribers. */
export function _reset(): void {
  subscribers.length = 0;
}
