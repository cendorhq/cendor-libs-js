---
"@cendor/guardrails": minor
---

V03 Tier-A — spotlight, annotation-parity metadata, and the task-adherence judge helper (parity with `cendor-guardrails` 1.3). Additive and backward-compatible; `$0`/offline in the default path.

- **A1 `rules.spotlight(opts?)`** — a deterministic `redact`-action **mitigation** (inspired by Azure Spotlighting): wraps each scannable text field of the payload in a trust-lowering delimiter (a tag like `<untrusted>` gets a matching `</untrusted>` close; any other string is used on both sides) so the model treats it as data, not instructions. `encode: true` base-64-encodes the body. Preserves payload shape; never blocks. Default stages `['input','tool_output']`, `encode` off. Not an ML/network call.
- **A2 annotation-parity metadata** — reserved `GuardrailDecision.metadata` keys (`severity` / `detected` / `filtered` / `redacted` / `citation` / `license`) documented in the bus-events spec, with no event-shape change. A check attaches them via a new `Verdict.metadata` (4th constructor arg — transient, never serialized) that the engine merges under `Context.metadata`. `openaiModeration` and the three hosted rails now populate `detected`/`filtered` (and `redacted` for a Bedrock mask); `spotlight` sets `redacted`.
- **A3 `judge.taskAdherence(respond, opts?)`** — a BYO-judge alignment check for the `tool_call` stage (does a proposed call match the user's intent?), reading the intent from the new optional `Context.instruction`. Default `action: 'flag'`. No adherence-rate claim. The `@cendor/sdk` auto-threading of the instruction is a deferred parity tail (🚧).
