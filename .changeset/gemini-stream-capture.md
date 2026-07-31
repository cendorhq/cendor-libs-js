---
'@cendor/core': minor
'@cendor/tokenguard': patch
---

**Gemini streaming is captured** — `client.models.generateContentStream` (and the `aio` twin, for
parity with Python). The `@google/genai` SDK streams through a **separate method**, not a
`stream: true` kwarg, so it needed its own always-stream detection target — the machinery Bedrock's
`converseStream` already uses. Until now a streamed Gemini call emitted **nothing at all**: measured
live 2026-07-31 against a real key, zero `LLMCall`s in both languages.

One `LLMCall` lands when the stream completes, carrying `metadata.streamed`, with real usage read
from the **last** usage-bearing chunk — Gemini reports *running totals* on every chunk, so the
generic "first usage-bearing chunk wins" rule would have under-counted every stream longer than one
chunk. `thoughtsTokenCount` folds into output and surfaces as `reasoningTokens`; a stream that
reports no usage falls back to a flagged offline estimate (`metadata.usage_estimated`); chunks pass
through unchanged; and the per-chunk stream-observer seam fires, so `@cendor/tokenguard`'s
`withBudget({ onExceed: 'break' })` cuts a runaway Gemini stream and closes it — pinned by a new
tokenguard test with a negative control (an under-cap stream is not cut and settles on real usage).

Also: the `prices.register` JSDoc no longer says Python has no public equivalent — `cendor-core`
1.15.0 added `prices.register` and `prices.register_model_price`.

Tests are red-first (5 of 7 fail against the pre-fix tree) and use a **real chunk cadence** rather
than an instant stub; the built tarball was additionally exercised in `node:20-slim` and
`node:22-slim` docker, including two **overlapping** streamed runs with different cadences, because
an async-context test green on node 24 proves nothing about the LTS.
