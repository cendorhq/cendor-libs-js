---
'@cendor/core': patch
---

**Fix: the live-spans latch is correct on Node 20 / 22 again — 0.13.0–0.15.0 could leave the span
emitter suppressed for the rest of the process on those versions.**

0.13.0 moved the latch to `AsyncLocalStorage.enterWith`, which behaves as that design needed **only on
Node ≥ 24** (AsyncContextFrame). Measured in docker on 2026-07-25 against node 20.20 and 22.23 (legacy
AsyncLocalStorage): an `enterWith` **leaks into concurrent flows** and is **not restored by the matching
exit** — so after any `liveSpans()` scope closed, `liveSpansActive()` stayed true and every later
libs-only call silently lost its flat span. If you are on Node 20 or 22 with 0.13.0–0.15.0, upgrade.

The latch now has two mechanisms, each doing what its API shape can actually guarantee:

- `enterLiveSpans()` / `exitLiveSpans()` — the callback-less pair a hand-closed `liveSpans()` handle
  uses — move a **module counter**: the emitter stands down process-wide while a manual scope is open,
  and the depth is released on close. This is the pre-0.13.0 behaviour, restored, and it is honest about
  what a hand-closed handle can bind to.
- `otel._withLiveSpansDepth(fn)` (internal) — the **scoped** form the SDK's automatic run scope uses.
  It raises the depth inside `AsyncLocalStorage.run()`, which is correctly scoped on **every** supported
  Node: two concurrent automatic runs never suppress each other's flat spans, and no depth survives a
  run (including one that throws).

`liveSpansActive()` reports either. Verified on node 20.20 / 22.23 / 24.18 — identical behaviour on all
three. The parity matrix's claim that the TS latch is "context-local" is corrected accordingly: it is
context-local for the automatic scope on every version, and process-wide for a manual handle.
