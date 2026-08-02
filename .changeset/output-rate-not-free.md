---
"@cendor/core": patch
---

A missing output rate no longer prices a chat model as free.

The bundled snapshot is regenerated from a feed that can no longer publish a row without one.
`prices/1` reads an absent `output` as **zero** — correct for an embedding, which bills no output
tokens, and wrong for a chat model whose rate simply never parsed, because `estimate()` then reports
the output side as a *fact* of `$0.00` and a USD `budget(...)` cap under-counts by the entire output
cost.

14 rows in the 3.6.1 snapshot were affected. Three now carry a real rate:

| model | output was | output now |
|---|---|---|
| `claude-3-haiku` | `$0.00` | `$1.25` / 1M |
| `claude-3-sonnet` | `$0.00` | `$15.00` / 1M |
| `gpt-image-2` | `$0.00` | `$30.00` / 1M |

`estimate("claude-3-haiku", 1_000_000, { outputTokens: 1_000_000 })` returned `0.25` and now returns
`1.50`. **If you budget or report on any of those three, your figures were low by the output side** —
the input side, and every other model, was always correct.

Twelve rows no source prices an output rate for are now **absent** rather than free, which renders as
an honest `null` plus a warn-once: `claude-2-0`, `claude-2-1`, `claude-instant`, `az-gpt4-turbo-128k`,
`gpt-image-1-mini`, `chatgpt-image-latest`, `gpt-4o-transcribe-diarize`, `mai-image-2.5`,
`mai-image-2.5-flash`, `mai-image-2e`, `codestral-embed`, `codestral-embed-2505`. An output rate a
source explicitly *states* as `0` is untouched — real embeddings keep theirs.

The snapshot's `_feed` field also stops naming `raw.githubusercontent.com/cendorhq/cendor-prices`,
which 404s now the repo is private.

Snapshot: 861 → 849 rows, `_updated` 2026-08-02.
