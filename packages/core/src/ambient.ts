/**
 * Ambient metadata providers — the one core-owned seam for stamping run-scoped context onto every
 * event at its single guaranteed-correct capture moment: **event construction, in the caller's
 * synchronous frame, before interceptors run.** The `traceId` has always been captured there; this
 * generalizes it to everything else (agent, conversation id, decision id, attribution tags, budget
 * frames, cassette session) that would otherwise be re-read at bus-delivery time — a read that
 * breaks under streams finalized outside the originating scope, context-losing layers, subscriber
 * order, and concurrent runs.
 *
 * A provider is a `(event) => metadata | undefined` function. `applyAmbient` runs the registered
 * providers over a freshly built event and merges their metadata onto `event.metadata`, in
 * registration order, **never overwriting an existing key**. The event is passed read-only so a
 * provider may key a `WeakMap` off it for non-serializable attachments (frames, handles) instead of
 * returning them. Contract: **never-throw** (a provider's exception is swallowed) and a **zero-provider
 * fast path of a single length check** (the standalone-libs byte-identity + the 14.51 µs benchmark
 * row both hold when nothing is registered).
 *
 * Core stays generic: it merges opaque metadata and learns no SDK vocabulary — what "agent" or
 * "conversation" means lives entirely in the library that registers a provider.
 */
import type { LLMCall, ToolCall } from './types.js';

/** An event an ambient provider may enrich (read-only to the provider). */
export type AmbientEvent = LLMCall | ToolCall;

/**
 * An ambient metadata provider. Receives the freshly-constructed event (treat it as read-only) and
 * returns a metadata bag to merge, or `undefined` for nothing. It **must not throw** (exceptions are
 * swallowed) and its keys **never overwrite** metadata already on the event; providers run in
 * registration order.
 */
export type AmbientProvider = (event: AmbientEvent) => Record<string, unknown> | undefined;

const providers: AmbientProvider[] = [];

/**
 * Register an ambient metadata provider. Idempotent (registering the same function twice is a no-op)
 * and returns the function so a caller can hold it for {@link removeAmbientProvider}. The provider
 * runs synchronously at every event's construction site — the frame where run context (async-local
 * storage / trace scope) is unconditionally correct — so values it stamps survive delivery no matter
 * when or where the event is finalized.
 *
 * @example
 * ```ts
 * import { addAmbientProvider } from '@cendor/core';
 * // stamp run context onto every LLMCall/ToolCall as it is constructed (before interceptors run):
 * addAmbientProvider(() => ({ agent: 'reviewer', tenant: 'acme' }));
 * ```
 */
export function addAmbientProvider(fn: AmbientProvider): AmbientProvider {
  if (!providers.includes(fn)) providers.push(fn);
  return fn;
}

/** Unregister a previously added ambient provider (no error if absent). */
export function removeAmbientProvider(fn: AmbientProvider): void {
  const i = providers.indexOf(fn);
  if (i >= 0) providers.splice(i, 1);
}

/**
 * Merge every registered provider's metadata onto `event.metadata`, in registration order, never
 * overwriting a key already present. Internal — invoked by core at every event-construction site.
 * Zero-provider fast path is a single length check.
 */
export function applyAmbient(event: AmbientEvent): void {
  if (providers.length === 0) return;
  const meta = event.metadata as Record<string, unknown>;
  for (const provider of providers) {
    let bag: Record<string, unknown> | undefined;
    try {
      bag = provider(event);
    } catch {
      continue; // never-throw: a broken provider must never break capture
    }
    if (bag == null) continue;
    for (const key of Object.keys(bag)) {
      if (!Object.prototype.hasOwnProperty.call(meta, key)) meta[key] = bag[key];
    }
  }
}

/** Test helper: drop every registered provider. */
export function _resetAmbient(): void {
  providers.length = 0;
}

/** Test helper: the number of registered providers (mirrors Python's `len(_providers)`). */
export function _providerCount(): number {
  return providers.length;
}
