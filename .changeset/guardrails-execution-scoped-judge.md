---
"@cendor/guardrails": minor
---

Add `scoped(guardrails, fn)` (per-async-context gating via AsyncLocalStorage, all-runtime with a single-context fallback), per-guardrail `timeout` + `onError` execution policy on `rules.custom` / `rules.llmJudge` / `defineGuardrail` (async-path timeout, fail-closed/fail-open recorded as evidence), and LLM-judge helpers (`judge.verdictPrompt` / `parseVerdict` / `judge`) for composing a bring-your-own model judge into a `rules.llmJudge` check.
