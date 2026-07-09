---
"@cendor/guardrails": minor
---

Wave 3 — hosted rails, config-as-data, and grounding (additive; TS mirror of `cendor-guardrails` 1.2.0):

- **Hosted-rail adapters** (`rules.bedrockGuardrail` / `azureContentSafety` / `modelArmor`, also on `adapters.*`): duck-typed cloud clients (no AWS/Azure/Google SDK imported here), metered by the vendor, but every verdict emits a **local** `GuardrailDecision` on the bus — "cloud check, local evidence". These are async (the JS cloud SDKs are async), so use them via the SDK loop / `applyAsync`, not the sync `install()` seam.
- **Config-as-data** — `loadPolicy(source, { parse })` builds deterministic rules from a versioned JSON/YAML document. The result is a `Guardrail[]` (`LoadedPolicy`) that also carries `policyHash` (a bundled, dependency-free, all-runtime SHA-256) and `policyVersion`; both are stamped into every decision's `metadata` so the audit chain proves which policy was active. JSON is built in; pass `parse` (e.g. a YAML parser) for YAML — there is no `node:fs`, so read the file yourself and pass the text/object.
- **Grounding & denied topics** — `rules.groundedness(embed, sources)` / `rules.deniedTopics(embed, topics)` gate on cosine similarity over a bring-your-own `embed(text)` fn (cassette's BYO-scorer precedent). No bundled model, no accuracy claim.
- **`Guardrail.metadata`** (also `defineGuardrail({ metadata })`) — static per-guardrail metadata merged into every decision it emits, under the per-call `Context.metadata` (which wins a clash).
