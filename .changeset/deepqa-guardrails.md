---
"@cendor/guardrails": minor
---

Deep-QA fixes: security-gate correctness + a security-relevant default change.

- `rules.language` default action is now `flag` (was `block`), matching the docs. A false language-ID no longer hard-blocks every call, and — with no BYO `detect` — it no longer fails closed on every request. Pass `action: 'block'` explicitly to gate (M3).
- Output-stage guardrails now run on **streamed** responses: `install()` / `scoped()` reconstruct the streamed delta chunks into the completed text before gating, so a `block` fires instead of silently no-oping and delivering the banned text (M2).
- `rules.llmJudge` / `judge.judge` / `judge.taskAdherence` build a **sync** check when the supplied callable is synchronous, so an LLM judge can attach to the sync `apply()` / `install()` / `scoped()` seam (previously they were always async and threw `TypeError: … is async`) (M4).
- Refreshed the `ctx.instruction` JSDoc — `@cendor/sdk` (≥ 0.7.0) auto-threads it (M11).
