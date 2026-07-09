---
"@cendor/guardrails": minor
---

Add `scoped(guardrails, fn)` (per-async-context gating via AsyncLocalStorage, all-runtime with a single-context fallback), per-guardrail `timeout` + `onError` execution policy on `rules.custom` / `rules.llmJudge` / `defineGuardrail` (async-path timeout, fail-closed/fail-open recorded as evidence), and LLM-judge helpers (`judge.verdictPrompt` / `parseVerdict` / `judge`) for composing a bring-your-own model judge into a `rules.llmJudge` check.

Also add opt-in **detection-tier adapters** (`adapters.*`, re-exported as `rules.*`): `classifier` (a generic, license-agnostic contract around any local classifier — bool/score/`{label:score}`, threshold + `label`), `language` (trip when the detected language is not in `allowed`, via a bring-your-own `detect`), and `openaiModeration` (trip when OpenAI's free moderation endpoint flags the payload — BYO client, optional category filter). No ML/network deps of the package; no jailbreak-detection claim. `prompt_guard` stays Python-only (needs `transformers`) — in TS wire an ONNX/transformers.js model through `rules.classifier`.
