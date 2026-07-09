---
"@cendor/guardrails": minor
---

First release of `@cendor/guardrails` — the **Gate** in the Cendor pipeline (`contextkit → squeeze → tokenguard → guardrails → cassette → acttrace`). The TypeScript port of `cendor.guardrails`.

Define a deterministic check — `keywordDeny`, `regexRule`, `urlAllowlist` / `urlDeny`, `lengthBounds` (char + exact token bounds via `@cendor/core`), `jsonSchema`, `custom` — and attach it to one of four intervention points (`input` / `tool_call` / `tool_output` / `output`). A `Verdict` trips with `block` (fail-closed → `GuardrailTripped`), `redact` (replace the payload and continue), or `flag` (record and continue). Three ways to use it: pure `apply()` / `evaluate()` (+ async), framework-independent `install()` (one `@cendor/core` interceptor + an output subscriber), and — via `@cendor/sdk` — `Agent({ guardrails: [...] })`.

Every trip or flag emits a `GuardrailDecision` on the `@cendor/core` bus, so `@cendor/acttrace` chains it as a tamper-evident `guardrail_decision` entry with **no import** in either direction (duck-typed). Regex/arithmetic only — microseconds, offline, `$0`, no `node:*` (all-runtime). `llmJudge` is a bring-your-own model-judge adapter contract, not a bundled classifier. Deterministic checks do not stop a novel adversarial attack — see the docs' "Honest limits".
