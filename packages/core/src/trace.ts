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
 * graph. Since 0.16.0 the scope also opens a **real parent span**, so one scope is one trace (see
 * {@link trace}), and it isolates itself with a real `AsyncLocalStorage` on Node **by default** — two
 * overlapping scopes no longer share one module variable. A host can still supply its own store via
 * {@link installTraceContext} (`{ getStore, run }`); on a runtime without `node:async_hooks` the
 * save/restore variable remains, which is correct for sync and sequential-async use.
 */

import { createRequire } from 'node:module';
import { _withTraceSpan } from './otel.js';

/** The minimal surface Cendor needs from an async-context store (AsyncLocalStorage satisfies it). */
export interface TraceContextStore {
  getStore(): string | undefined;
  run<T>(traceId: string, fn: () => T): T;
}

/**
 * The default store, installed automatically on Node (0.16.0).
 *
 * Before this, correlation fell back to a save/restore module variable unless a host injected a store
 * — so two **overlapping** scopes shared one variable: the second scope's id leaked into the first's
 * remaining work, and the last one to finish left its id behind for everything after. Core builds an
 * `AsyncLocalStorage` for the live-span latch already, so building one here costs nothing and removes
 * the entire class of defect. `run(value, fn)` only — never `enterWith`, which leaks into concurrent
 * flows and is not restored on exit on node 20/22 (measured 2026-07-25).
 *
 * On a non-Node runtime (edge/browser) there is no `node:async_hooks`, so the save/restore variable
 * remains — correct for sync and sequential-async use, which is what those runtimes do here.
 */
const nodeStore: TraceContextStore | null = (() => {
  try {
    const req = createRequire(import.meta.url);
    const { AsyncLocalStorage } = req('node:async_hooks') as {
      AsyncLocalStorage: new () => TraceContextStore;
    };
    return new AsyncLocalStorage();
  } catch {
    return null;
  }
})();

let store: TraceContextStore | undefined = nodeStore ?? undefined;
let ambient = '';

/**
 * Install a real async-context store (e.g. `new AsyncLocalStorage()` from `node:async_hooks`) so
 * overlapping async traces stay isolated. **Already installed for you on Node** since 0.16.0 — call
 * this only to supply a different implementation. Pass `undefined` to fall back to the save/restore
 * ambient variable (used by tests that assert that path).
 */
export function installTraceContext(impl: TraceContextStore | undefined): void {
  store = impl;
}

/** @internal Test helper: restore the automatic Node store after `installTraceContext(undefined)`. */
export function _resetTraceContext(): void {
  store = nodeStore ?? undefined;
}

/** The ambient `traceId` for the current context (`''` when unset). */
export function currentTraceId(): string {
  if (store) return store.getStore() ?? '';
  return ambient;
}

/** Options for {@link trace}. */
export interface TraceOptions {
  /**
   * Force the parent span on/off for this scope. Default follows `CENDOR_TRACE_SPAN` (default **on**);
   * `off` restores the pre-0.16.0 shape for a backend that groups by trace id today.
   */
  span?: boolean;
}

/**
 * Group a unit of work: run `fn` with `traceId` stamped onto every `LLMCall`/`ToolCall` emitted inside
 * it **and open a real parent span**, so the calls inside become one trace. Returns whatever `fn`
 * returns (awaitable if `fn` is async). Nests correctly.
 *
 * **Behaviour change in @cendor/core 0.16.0.** Before it, the scope stamped an id and nothing else, so
 * every call inside still arrived as its own root span — one logical unit of work became N unrelated
 * traces in any backend that groups by trace. The scope now brackets them with a `cendor.trace <id>`
 * span (instrumentation scope `cendor.core`, carrying `cendor.run.id` and `cendor.scope: 'trace'`), and
 * each child call carries a 1-based `cendor.step`. The ambient id is stamped exactly as before, so
 * correlation by `cendor.trace_id` is unaffected.
 *
 * Nothing is emitted when there is nobody to emit to (no `@opentelemetry/api`, no configured provider,
 * or `CENDOR_TELEMETRY=off`), and **no span is opened inside a @cendor/sdk run** — that run already
 * owns its trace, and the calls attach to it rather than to a competing root. Nesting is a no-op for
 * the inner scope: one root per scope family.
 *
 * @example
 * await trace('run-42', async () => {
 *   await client.chat.completions.create(...); // one trace, `cendor.step` 1
 *   await lookup('order-7');                   //   …and 2
 * });
 */
export function trace<T>(traceId: string, fn: () => T, opts: TraceOptions = {}): T {
  const id = String(traceId);
  // The span wraps the id binding, so a call inside sees both. Imported lazily to keep this module
  // free of the OTel probe on the (common) path where no span is opened at all.
  const body = (): T => {
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
  };
  return _withTraceSpan(id, body, opts.span);
}
