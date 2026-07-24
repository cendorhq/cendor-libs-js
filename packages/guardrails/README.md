# @cendor/guardrails

[![npm version](https://img.shields.io/npm/v/@cendor/guardrails.svg)](https://www.npmjs.com/package/@cendor/guardrails) [![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

```bash
npm i @cendor/guardrails
```

A local-first **gate** for LLM apps: define a check — keyword, regex, URL, length, JSON-schema —
attach it to a stage (`input`, `tool_call`, `tool_output`, `output`), and block, redact, or flag
before the model or a tool ever runs. The TypeScript port of `cendor.guardrails`.

**Deterministic checks in microseconds for $0 — and every decision lands in a tamper-evident audit chain.**

Every trip or flag emits a `GuardrailDecision` on `@cendor/core`'s bus, so `@cendor/acttrace` chains
it as a `guardrail_decision` entry with **no import** between the two. Imports only `@cendor/core`.

> **Deterministic ≠ adversarial protection.** The built-ins catch what you configure — keywords,
> patterns, hosts, sizes, shapes. They do **not** stop a novel jailbreak. Pair them with a
> bring-your-own model judge (`rules.llmJudge`) for open-ended risk. No jailbreak-detection or
> PII-catch-rate claims are made here.

Using an AI coding assistant? `npx @cendor/init` (TS) / `uvx cendor-init` (Python) wires it up — or point it at [cendor.ai/docs/for-ai-assistants](https://cendor.ai/docs/for-ai-assistants).

## Killer example

```ts
import { instrument } from '@cendor/core';
import { install, rules } from '@cendor/guardrails';

const client = instrument(openai);
install([
  rules.keywordDeny(['ignore previous instructions'], { action: 'block' }),   // prompt-injection floor
  rules.regexRule(/\bsk-[A-Za-z0-9]{20,}\b/, { action: 'redact', stage: 'input' }), // scrub leaked keys
  rules.urlAllowlist(['docs.cendor.ai'], { stage: 'input' }),                 // only sanctioned links
]);

await client.chat.completions.create({ model: 'gpt-4o', messages });
// a blocked prompt -> throws GuardrailTripped BEFORE the request is sent ($0 spent)
// a leaked key    -> the provider receives "[redacted]" instead of the secret
```

Or gate a payload directly:

```ts
import { apply, GuardrailTripped, rules } from '@cendor/guardrails';

try {
  apply([rules.jsonSchema({ type: 'object', required: ['ok'] })], 'output', modelText);
} catch (e) {
  if (e instanceof GuardrailTripped) console.log(e.decisions); // recorded decisions, block last
}
```

## Surface

| Export | What it does |
|---|---|
| `rules.keywordDeny` / `regexRule` / `spotlight` / `urlAllowlist` / `urlDeny` / `lengthBounds` / `jsonSchema` / `custom` | deterministic built-in rules (regex/arithmetic only); `spotlight` wraps untrusted content in a trust-lowering delimiter (a `$0` mitigation) |
| `rules.llmJudge` | adapter **contract** for a bring-your-own model judge — you supply the call |
| `rules.classifier` / `language` / `openaiModeration` | opt-in detection-tier adapters (bring-your-own local classifier / `detect` / OpenAI client) |
| `rules.bedrockGuardrail` / `azureContentSafety` / `modelArmor` | **hosted rails** (duck-typed cloud client, metered by the vendor) — a cloud verdict, a **local** `guardrail_decision` |
| `rules.groundedness` / `deniedTopics` | similarity checks over a bring-your-own `embed(text)` fn — RAG-hallucination / off-topic gates, no bundled model |
| `loadPolicy(source, { parse })` | build deterministic rules from a versioned JSON/YAML document; stamps `policyHash` / `policyVersion` onto every decision |
| `runRedteam` / `loadCorpus` / `RedTeamReport` | measure trip rate + false-positive rate against a labeled corpus you supply (no vended data) |
| `judge.verdictPrompt` / `parseVerdict` / `judge` | compose a model judge into a check: strict-JSON prompt + parse (malformed → `onError` decides) |
| `apply` / `evaluate` (+ `applyAsync` / `evaluateAsync`) | gate a payload directly; `evaluate` also returns the redacted payload |
| `install` / `uninstall` | register one `@cendor/core` interceptor + output subscriber (process-global) |
| `scoped(guardrails, fn)` | like `install`, but **scoped to the current async context** — vary guardrails per request on a concurrent server (AsyncLocalStorage on Node; single-context fallback elsewhere) |
| `defineGuardrail(check, { stage, timeout, onError })` | wrap a `(payload, ctx) => Verdict \| null` check into a `Guardrail` |
| `Verdict` / `GuardrailDecision` / `GuardrailTripped` | trip vocabulary, bus event, fail-closed error |

### Execution policy: `timeout` + `onError`

`rules.custom` / `rules.llmJudge` (and `defineGuardrail`) take a per-check **`timeout`** (seconds,
**async path only** — JS has no threads, so a sync timeout is a no-op) and an **`onError`** policy
for when a check *throws or times out*: `"fail_closed"` (default — treat it as a `block`) or
`"fail_open"` (record a `flag` and proceed). `llmJudge` defaults `onError` from its action
(`flag → fail_open`, else `fail_closed`). Either way the failure is emitted as a `GuardrailDecision`
(the reason carries the error type + message, never the payload) — evidence, not a swallowed error.

## Parity

Deterministic pure-compute TS mirror of `cendor.guardrails` — same four stages, same rule set, same
`guardrail_decision` bus event (snake_case wire keys). Runs on Node, edge, and the browser (no
`node:*` imports). The full split is in the [parity matrix](https://cendor.ai/docs/languages).

*Part of the Cendor stack — github.com/cendorhq/cendor-libs-js. Powered by PowerAI Labs.*
