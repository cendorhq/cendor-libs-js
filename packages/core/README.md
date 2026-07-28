# @cendor/core

[![npm version](https://img.shields.io/npm/v/@cendor/core.svg)](https://www.npmjs.com/package/@cendor/core) [![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Wrap your LLM client once and capture exact token counts and cost on every call — the shared foundation the other Cendor tools build on. The TypeScript port of [`cendor.core`](https://github.com/cendorhq/cendor-libs/tree/main/packages/cendor-core): shared types, an event bus, decimal-safe `Money`, an offline price table, provider-aware token counting, and `instrument()`. Every other `@cendor/*` package cooperates through this.

```bash
npm i @cendor/core
# provider SDKs are optional peers — install the one(s) you use:
npm i openai @anthropic-ai/sdk
```

Using an AI coding assistant? `npx @cendor/init` (TS) / `uvx cendor-init` (Python) wires it up — or point it at [cendor.ai/docs/for-ai-assistants](https://cendor.ai/docs/for-ai-assistants).


## Telemetry: it flows (and `CENDOR_TELEMETRY=off` stops it)

With OpenTelemetry installed and a provider configured **by your app**, core emits
`gen_ai.*` spans for every governed call as soon as you call `instrument()` — plus `governance.*` spans
for the budget/guardrail decisions the other libraries make. No emitter to attach, no exporter to
install: core has **no endpoint of its own** and emits into your provider. `CENDOR_TELEMETRY=off` turns
it off process-wide; `CENDOR_DEBUG_TELEMETRY=1` prints one line saying what was detected; `otel.telemetryMode()` / `providerConfigured()` let
you check the state yourself. With OpenTelemetry absent, nothing is subscribed and behaviour is
byte-identical.

## Killer example — wrap once, get cost + tokens on every call

```ts
import OpenAI from 'openai';
import { instrument, bus, LLMCall } from '@cendor/core';

const client = instrument(new OpenAI());

bus.subscribe((e) => {
  if (e instanceof LLMCall) console.log(e.model, e.usage?.totalTokens, e.cost?.toString());
});

await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hello' }],
}); // → gpt-4o 152 0.000... USD
```

Streaming, the Responses API, embeddings, every other detected provider, interceptors
(record/replay), and `Reroute` (model downgrade / message redaction) all flow through the same
`instrument()`.

## Surface

| Symbol | Notes |
|---|---|
| `instrument(client)` | wraps **OpenAI** (Chat + Responses + Embeddings) · **Anthropic** · **Bedrock** (a client exposing `converse` / `converse_stream`) · **Gemini** (`@google/genai` + the legacy model surface) · **Ollama** · **Hugging Face**, all detected by *shape*; idempotent; async + streaming |
| `instrumentTool(fn)` | emits a `ToolCall` per invocation |
| `Money`, `Usage`, `LLMCall`, `ToolCall` | the cross-language event vocabulary (`events/1`) |
| `bus` | `subscribe` / `unsubscribe` / `emit` |
| `prices` | `estimate` / `models` / `refresh` / staleness — exact `Decimal`, never floats (`prices/1`) |
| `tokens` | `count` / `method` / `family` / `register` via `js-tiktoken` |
| `trace(id, fn)` / `currentTraceId()` | ambient correlation (async-callback scope, isolated by a real `AsyncLocalStorage` on Node by default; `installTraceContext` overrides the store for a runtime without `node:async_hooks`) |
| `Reroute`, `addInterceptor`, `MISS` | pre-call interception seam used by `@cendor/cassette` & `@cendor/acttrace` |

## Parity & conformance

Field names map `snake_case` (Python) → `camelCase` (TS); type and error names are identical
(`UnknownModelError` in both). Cost math, the model table, `Money` semantics, and token counts are
verified against golden vectors generated from the Python reference — see
[`fixtures/`](../../fixtures). Money is compared by exact decimal *value*.

---

**Full docs:** [cendor.ai/docs/core](https://cendor.ai/docs/core) · part of the Cendor stack ([cendorhq/cendor-libs-js](https://github.com/cendorhq/cendor-libs-js)).
