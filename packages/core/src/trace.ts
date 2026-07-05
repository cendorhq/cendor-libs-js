/**
 * Ambient `traceId` correlation, the TS mirror of `cendor.core`'s `trace()` context manager. Per the
 * api-parity rules, a Python context manager maps to an async-callback scope in TS:
 *
 * ```ts
 * await trace('run-42', async () => {
 *   await client.chat.completions.create(...); // emitted LLMCall.traceId === 'run-42'
 * });
 * ```
 *
 * Correlation is a *hook*, not an orchestrator — Cendor stamps the id you set; it never invents a run
 * graph. Core keeps zero Node dependencies (so it stays edge/browser-importable), so the default
 * store is a save/restore ambient variable — correct for sync and sequential-async use. For
 * concurrency-correct isolation under overlapping async runs (the SDK's agent loop), a host injects a
 * real `AsyncLocalStorage` via {@link installTraceContext}; its `{ getStore, run }` shape matches.
 */

/** The minimal surface Cendor needs from an async-context store (AsyncLocalStorage satisfies it). */
export interface TraceContextStore {
  getStore(): string | undefined;
  run<T>(traceId: string, fn: () => T): T;
}

let store: TraceContextStore | undefined;
let ambient = '';

/**
 * Install a real async-context store (e.g. `new AsyncLocalStorage()` from `node:async_hooks`) so
 * overlapping async traces stay isolated. Optional; without it, correlation uses a save/restore
 * ambient variable. Pass `undefined` to revert to the ambient variable (used by tests).
 */
export function installTraceContext(impl: TraceContextStore | undefined): void {
  store = impl;
}

/** The ambient `traceId` for the current context (`''` when unset). */
export function currentTraceId(): string {
  if (store) return store.getStore() ?? '';
  return ambient;
}

/**
 * Run `fn` with `traceId` stamped onto every `LLMCall`/`ToolCall` emitted inside it. Returns whatever
 * `fn` returns (awaitable if `fn` is async). Nests correctly.
 */
export function trace<T>(traceId: string, fn: () => T): T {
  const id = String(traceId);
  if (store) return store.run(id, fn);
  const previous = ambient;
  ambient = id;
  let result: T;
  try {
    result = fn();
  } catch (err) {
    ambient = previous;
    throw err;
  }
  if (result instanceof Promise) {
    return result.finally(() => {
      ambient = previous;
    }) as unknown as T;
  }
  ambient = previous;
  return result;
}
