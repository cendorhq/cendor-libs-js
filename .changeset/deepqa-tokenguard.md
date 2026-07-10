---
"@cendor/tokenguard": patch
---

Deep-QA fix: under `onExceed: 'clamp'`, the provider output ceiling (`max_completion_tokens` / `max_tokens` = the tokens left in the budget) is now **always** injected on a call under a token budget — not only when the 256-token reserve heuristic would breach. A single surprise-long call can no longer overshoot the `tokens=` cap while headroom exists (M1).
