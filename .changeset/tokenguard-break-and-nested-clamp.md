---
"@cendor/tokenguard": minor
---

Add `onExceed: 'break'` — a **mid-stream budget breaker**. It rides `@cendor/core`'s new
stream-observer seam to cut a streamed call the instant its running output estimate (visible text +
visible thinking) crosses the remaining `tokens`/`usd` budget: you keep the partial output already
yielded, the provider bills to the cut (~one chunk + one RTT — it stops the meter, it does not
un-bill the provider), and the settled usage is an estimate flagged `usage_estimated`. USD headroom
is converted to an integer token allowance once per stream; `reasoningReserve` cuts early on
hidden-thinking models. It also acts as a post-flight cumulative gate (like `raise`) for non-streamed
calls, and emits a `BudgetEvent` with `action: 'broken'`. Needs `@cendor/core` ≥ 0.11.

`onExceed: 'clamp'` now injects the output ceiling for **more providers**: nested Bedrock
`inferenceConfig.maxTokens` and Ollama `options.num_predict` (copy-on-write merged), and a plain-object
Gemini `config.max_output_tokens`. A typed Gemini `GenerateContentConfig` can't be safely merged and
falls back to a hard block (as before).
