# @cendor/guardrails

## 0.7.4

### Patch Changes

- Updated dependencies [9e1e564]
  - @cendor/core@0.10.0

## 0.7.3

### Patch Changes

- Updated dependencies [83c0ca7]
  - @cendor/core@0.9.0

## 0.7.2

### Patch Changes

- Updated dependencies [60f2eaf]
  - @cendor/core@0.8.0

## 0.7.1

### Patch Changes

- Updated dependencies [ec4be36]
  - @cendor/core@0.7.0

## 0.7.0

### Minor Changes

- 16e627b: A native governance counter. Every emitted `GuardrailDecision` also increments a `cendor.guardrails.decisions` counter on the meter `cendor.guardrails` (a no-op when `@opentelemetry/api` isn't installed), dimensioned by the bounded label sets `guardrail` / `stage` / `action`. Renders as `cendor_guardrails_decisions_total` in Prometheus, so guardrail block/flag rates are chartable per guardrail and stage. Backward-compatible — no change to `GuardrailDecision` or the bus shape.

## 0.6.2

### Patch Changes

- b774bd0: Re-pin `@cendor/core` to the 0.6.0 shelf (no code change). A 0.x caret never crosses a minor, so without this bump a fresh install mixing these libs with `@cendor/core@0.6.0` consumers (e.g. `@cendor/sdk` ≥ 0.10.0) would resolve two coexisting core copies — two buses, split governance. One deduped core restores the single seam.
- Updated dependencies [b774bd0]
  - @cendor/core@0.6.0

## 0.6.1

### Patch Changes

- 3ae2af6: AI-assistant onboarding: inline Type Teach now ships in every package — `@example` + correct-shape JSDoc on public symbols, the `budget(cfg, fn): never` decoy overload (the wrong shape is a compile error), Literal-narrowed string params, and `@deprecated` casing aliases — plus the bundled `INTEGRATION.md`. No runtime behavior change for correct code; the wrong call-shape just fails to typecheck with a message stating the right one. Full trap sheet: https://cendor.ai/docs/for-ai-assistants
- Updated dependencies [3ae2af6]
  - @cendor/core@0.5.1

## 0.6.0

### Minor Changes

- d20450e: Deep-QA fixes: security-gate correctness + a security-relevant default change.

  - `rules.language` default action is now `flag` (was `block`), matching the docs. A false language-ID no longer hard-blocks every call, and — with no BYO `detect` — it no longer fails closed on every request. Pass `action: 'block'` explicitly to gate (M3).
  - Output-stage guardrails now run on **streamed** responses: `install()` / `scoped()` reconstruct the streamed delta chunks into the completed text before gating, so a `block` fires instead of silently no-oping and delivering the banned text (M2).
  - `rules.llmJudge` / `judge.judge` / `judge.taskAdherence` build a **sync** check when the supplied callable is synchronous, so an LLM judge can attach to the sync `apply()` / `install()` / `scoped()` seam (previously they were always async and threw `TypeError: … is async`) (M4).
  - Refreshed the `ctx.instruction` JSDoc — `@cendor/sdk` (≥ 0.7.0) auto-threads it (M11).

### Patch Changes

- Updated dependencies [d20450e]
  - @cendor/core@0.5.0

## 0.5.0

### Minor Changes

- eb92af0: TypeScript parity for the semantic gate's local embedder (plan-guardrails-v04 follow-up). Additive; sync `embed` behaviour is unchanged.

  - **`embed` may now be sync OR async** across `rules.customCategory` / `deniedTopics` / `groundedness` / `rules.intent`. A sync embed keeps the check synchronous (usable via `apply()` / `install()`, unchanged); an async embed (a hosted embeddings endpoint, or the new `localEmbedder`) makes the check async — run it through `applyAsync` or the SDK loop. This unblocks every realistic JS embedder (they're async), closing the gap that previously forced a sync-only embed.
  - **`embeddings.localEmbedder(opts?)`** — a zero-config, offline `embed` backed by **transformers.js** (`@huggingface/transformers`), lazy-imported as an **optional peer** (never bundled; a clear, actionable error if absent — mirroring Python's lazy `model2vec`). Returns an **async** embed (default model `Xenova/all-MiniLM-L6-v2`, mean-pooled + normalized).
  - **Cross-language note:** Python's `local_embedder` uses model2vec static embeddings (sync); there is no maintained model2vec JS port, so TS uses transformers.js (async). The _capability_ is now at parity — the backend and sync/async shape differ, documented in the parity matrix. No catch-rate claim.

## 0.4.0

### Minor Changes

- 524f350: V04 — from substring to meaning (parity with `cendor-guardrails` 1.4). Additive and backward-compatible; the deterministic matcher's default is byte-for-byte unchanged, new capability is opt-in and `$0`/offline in the default path. Three new claim gates ship shut (paraphrase catch-rate, intent accuracy, injection-preset coverage).

  - **G1 — `keywordDeny(words, { match, normalize })`** — opt-in matching maturity, defaulting to the original substring behaviour. `match: 'word'` anchors each term on **Unicode** word boundaries (JS `\b` is ASCII-only, so `\p{L}\p{N}_` lookarounds under the `u` flag) and spans line-wraps for multi-word terms; `normalize` folds both sides (`['nfkc','strip_zero_width','casefold','collapse_whitespace',…]`) to close full-width / zero-width / spacing evasions. The decision records `metadata.matched`.
  - **G2 — `rules.customCategory(category, examples, embed, opts?)`** — the local counterpart to Azure's _rapid custom categories_ (examples → embedding search): trips when the payload is semantically close to any example, catching paraphrases `keywordDeny` misses. Records `metadata.category`/`.score`. `embed` is bring-your-own (no zero-config `localEmbedder` in TS yet — model2vec is Python-only; parity 🚧). No catch-rate claim.
  - **G3 — `rules.intent(intents, { embed | classify, mode })`** + **`judge.intentPrompt(intents, mode?)`** — a first-class pre-LLM intent gate: `mode: 'deny'` trips on a match, `mode: 'allow'` trips when it matches none (off-topic). Embedding-exemplar or BYO-classifier backends; the judge helper builds the policy for the LLM tier. Records `metadata.intent`/`.score`. No accuracy claim, no bundled taxonomy.
  - **G4 — `presets.PROMPT_INJECTION_EN` + `presets.promptInjection(opts?)`** and **`policySchema()` + `loadPolicy(src, { validate: true })`** — a curated starter injection list (inline constant, not a bundled data file; **not detection** — no coverage claim without a published red-team run) and the policy JSON Schema (inline, all-runtime) with an opt-in structural check.
  - **G5 — `azureContentSafety(client, { checks, harmCategories, harmThreshold, blocklistNames })`** — the adapter now optionally wraps Azure's `analyzeText` harm classifier (severity → `metadata.severity`) and blocklists, alongside Prompt Shields. Default `checks: ['prompt_shields']` unchanged. Still duck-typed; cloud check, local evidence.

## 0.3.0

### Minor Changes

- 6a7d8d7: V03 Tier-A — spotlight, annotation-parity metadata, and the task-adherence judge helper (parity with `cendor-guardrails` 1.3). Additive and backward-compatible; `$0`/offline in the default path.

  - **A1 `rules.spotlight(opts?)`** — a deterministic `redact`-action **mitigation** (inspired by Azure Spotlighting): wraps each scannable text field of the payload in a trust-lowering delimiter (a tag like `<untrusted>` gets a matching `</untrusted>` close; any other string is used on both sides) so the model treats it as data, not instructions. `encode: true` base-64-encodes the body. Preserves payload shape; never blocks. Default stages `['input','tool_output']`, `encode` off. Not an ML/network call.
  - **A2 annotation-parity metadata** — reserved `GuardrailDecision.metadata` keys (`severity` / `detected` / `filtered` / `redacted` / `citation` / `license`) documented in the bus-events spec, with no event-shape change. A check attaches them via a new `Verdict.metadata` (4th constructor arg — transient, never serialized) that the engine merges under `Context.metadata`. `openaiModeration` and the three hosted rails now populate `detected`/`filtered` (and `redacted` for a Bedrock mask); `spotlight` sets `redacted`.
  - **A3 `judge.taskAdherence(respond, opts?)`** — a BYO-judge alignment check for the `tool_call` stage (does a proposed call match the user's intent?), reading the intent from the new optional `Context.instruction`. Default `action: 'flag'`. No adherence-rate claim. The `@cendor/sdk` auto-threading of the instruction is a deferred parity tail (🚧).

## 0.2.0

### Minor Changes

- 81ce71b: Add `scoped(guardrails, fn)` (per-async-context gating via AsyncLocalStorage, all-runtime with a single-context fallback), per-guardrail `timeout` + `onError` execution policy on `rules.custom` / `rules.llmJudge` / `defineGuardrail` (async-path timeout, fail-closed/fail-open recorded as evidence), and LLM-judge helpers (`judge.verdictPrompt` / `parseVerdict` / `judge`) for composing a bring-your-own model judge into a `rules.llmJudge` check.

  Also add opt-in **detection-tier adapters** (`adapters.*`, re-exported as `rules.*`): `classifier` (a generic, license-agnostic contract around any local classifier — bool/score/`{label:score}`, threshold + `label`), `language` (trip when the detected language is not in `allowed`, via a bring-your-own `detect`), and `openaiModeration` (trip when OpenAI's free moderation endpoint flags the payload — BYO client, optional category filter). No ML/network deps of the package; no jailbreak-detection claim. `prompt_guard` stays Python-only (needs `transformers`) — in TS wire an ONNX/transformers.js model through `rules.classifier`.

- 4d26329: Wave 3 — hosted rails, config-as-data, and grounding (additive; TS mirror of `cendor-guardrails` 1.2.0):

  - **Hosted-rail adapters** (`rules.bedrockGuardrail` / `azureContentSafety` / `modelArmor`, also on `adapters.*`): duck-typed cloud clients (no AWS/Azure/Google SDK imported here), metered by the vendor, but every verdict emits a **local** `GuardrailDecision` on the bus — "cloud check, local evidence". These are async (the JS cloud SDKs are async), so use them via the SDK loop / `applyAsync`, not the sync `install()` seam.
  - **Config-as-data** — `loadPolicy(source, { parse })` builds deterministic rules from a versioned JSON/YAML document. The result is a `Guardrail[]` (`LoadedPolicy`) that also carries `policyHash` (a bundled, dependency-free, all-runtime SHA-256) and `policyVersion`; both are stamped into every decision's `metadata` so the audit chain proves which policy was active. JSON is built in; pass `parse` (e.g. a YAML parser) for YAML — there is no `node:fs`, so read the file yourself and pass the text/object.
  - **Grounding & denied topics** — `rules.groundedness(embed, sources)` / `rules.deniedTopics(embed, topics)` gate on cosine similarity over a bring-your-own `embed(text)` fn (cassette's BYO-scorer precedent). No bundled model, no accuracy claim.
  - **`Guardrail.metadata`** (also `defineGuardrail({ metadata })`) — static per-guardrail metadata merged into every decision it emits, under the per-call `Context.metadata` (which wins a clash).
  - **Red-team evaluation** (`runRedteam` / `runRedteamAsync` / `loadCorpus` / `RedTeamReport`) — measure trip rate + false-positive rate + a per-category breakdown against a labeled corpus **you** supply (no vended data; `loadCorpus` takes a parsed array or jsonl/json/csv text — no `node:fs`).

## 0.1.0

### Minor Changes

- 7679740: First release of `@cendor/guardrails` — the **Gate** in the Cendor pipeline (`contextkit → squeeze → tokenguard → guardrails → cassette → acttrace`). The TypeScript port of `cendor.guardrails`.

  Define a deterministic check — `keywordDeny`, `regexRule`, `urlAllowlist` / `urlDeny`, `lengthBounds` (char + exact token bounds via `@cendor/core`), `jsonSchema`, `custom` — and attach it to one of four intervention points (`input` / `tool_call` / `tool_output` / `output`). A `Verdict` trips with `block` (fail-closed → `GuardrailTripped`), `redact` (replace the payload and continue), or `flag` (record and continue). Three ways to use it: pure `apply()` / `evaluate()` (+ async), framework-independent `install()` (one `@cendor/core` interceptor + an output subscriber), and — via `@cendor/sdk` — `Agent({ guardrails: [...] })`.

  Every trip or flag emits a `GuardrailDecision` on the `@cendor/core` bus, so `@cendor/acttrace` chains it as a tamper-evident `guardrail_decision` entry with **no import** in either direction (duck-typed). Regex/arithmetic only — microseconds, offline, `$0`, no `node:*` (all-runtime). `llmJudge` is a bring-your-own model-judge adapter contract, not a bundled classifier. Deterministic checks do not stop a novel adversarial attack — see the docs' "Honest limits".
