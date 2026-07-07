# @cendor/tokenguard

[![npm version](https://img.shields.io/npm/v/@cendor/tokenguard.svg)](https://www.npmjs.com/package/@cendor/tokenguard) [![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Spending limits for LLM calls: stop a call before it runs if it would blow the budget, and see cost broken down per feature. The TypeScript port of `cendor.tokenguard`.

tokenguard **subscribes** to `@cendor/core`'s event bus and registers a pre-flight interceptor — it
never patches a client itself (the locked architecture: one `instrument()`, many subscribers). Once a
client is instrumented, `withBudget(...)` / `budget(...)` enforce a cap and `track(...)` attributes
spend by tags, with zero per-call wiring.

## Killer example

```ts
import { instrument } from '@cendor/core';
import { withBudget, track, report, BudgetExceeded } from '@cendor/tokenguard';

const client = instrument(openai); // one seam; tokenguard rides the bus

// Pre-flight hard cap: the over-budget call never runs.
try {
  await withBudget({ usd: 0.05, onExceed: 'block' }, async () => {
    await track({ feature: 'support', user_id: 'alice' }, async () => {
      await client.chat.completions.create({ model: 'gpt-4o', messages });
    });
  });
} catch (err) {
  if (err instanceof BudgetExceeded) console.log('refused before spending');
}

// Free attribution — group spend by any tag.
for (const row of report(['feature'])) {
  console.log(row.tags.feature, row.usd.toString(), row.calls);
}
```

## Surface

| Symbol | What it does |
| --- | --- |
| `withBudget(cfg, cb)` | Cap spend within an async-callback scope (parity of `with budget(...) as b:`). |
| `budget(cfg)(fn)` | Decorator form — wraps a function with a fresh budget per call. |
| `track(tags, cb)` | Attribute spend by ambient tags (merges with enclosing scopes). `track.report === report`. |
| `estimate(model, messages, maxOutputTokens?)` | Pure pre-flight cost projection (no call). |
| `report(groupBy?)` | Aggregate recorded spend into a `Report` (rows keyed by tag values). |
| `Report` | `.rows`, `.total(): Money`, `.assertUnder(usd, tagFilter?)`, iterable. |
| `downgrades()` / `clamps()` | Pre-flight reroutes / token clamps applied so far. |
| `useSink(sink)` | Also persist each spend row to a `Sink`; returns the previous sink. |
| `configure({ maxRecords?, onUnpriced? })` | Tune the retained-buffer cap and unpriced-model policy. |
| `dropped()` / `unpricedCalls()` | Rows evicted by the buffer cap / count of `$0` unpriced calls. |
| `reset()` | Clear state + re-arm the subscription (between tests). |
| `BudgetExceeded`, `UnpricedModelWarning` | The public exception + warning types. |
| `onUnpricedWarning(fn)` | Register a listener for unpriced-model warnings (returns an unsubscribe). |
| `@cendor/tokenguard/sinks` | `SQLiteSink`, `QueueSink`, `OTelSink`. |

**`onExceed` modes:** `'raise'` (post-flight, stops the *next* call — overshoots by one),
`'block'` (pre-flight hard cap — never overspends), `'clamp'` (inject a provider output ceiling —
requires `tokens=`), `'downgrade'` (reroute to a cheaper model — requires `usd=` + a `downgrade`
map), `'truncate'` (degrade gracefully — resolves to `undefined`), or a callable `(ctx) => …`.

## Parity note

Behavior, defaults, string-enum values, error names, report/sink/downgrade/clamp row keys, and the
OTel metric names are a faithful port of the Python `cendor.tokenguard` v1.1.1. Adaptations for the
async, single-threaded TS runtime:

- Python `contextvars` → two `node:async_hooks` `AsyncLocalStorage` scopes (`track`/`budget`
  propagate across `await`, not across worker threads — the same caveat as contextvars vs. OS
  threads). Context managers → the async-callback forms `withBudget` / `track`, plus the `budget(cfg)(fn)`
  decorator.
- `warnings.warn(UnpricedModelWarning)` → a capturable/escalatable channel: register via
  `onUnpricedWarning(fn)` (deduped once-per-model, cleared by `reset()`); with no listener it falls
  back to `console.warn`.
- Token counts use the bundled **js-tiktoken** (real tiktoken numbers), not Python's forced
  `ceil(len/4)` heuristic — so recorded **cost** (from reported usage) is identical, while pre-flight
  **projections** use exact token counts. The OS-thread thread-safety tests are dropped (Node is
  single-threaded); `QueueSink` is an async FIFO drain loop rather than a daemon thread, preserving
  the observable semantics (FIFO order, back-pressure, idempotent close, flush→close ordering).
