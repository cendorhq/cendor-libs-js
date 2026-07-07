# @cendor/core

[![npm version](https://img.shields.io/npm/v/@cendor/core.svg)](https://www.npmjs.com/package/@cendor/core) [![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Wrap your LLM client once and capture exact token counts and cost on every call — the shared foundation the other Cendor tools build on. The TypeScript port of [`cendor.core`](https://github.com/cendorhq/cendor-libs/tree/main/packages/cendor-core): shared types, an event bus, decimal-safe `Money`, an offline price table, provider-aware token counting, and `instrument()`. Every other `@cendor/*` package cooperates through this.

```bash
npm i @cendor/core
# provider SDKs are optional peers — install the one(s) you use:
npm i openai @anthropic-ai/sdk
```

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

Streaming, the Responses API, Anthropic, interceptors (record/replay), and `Reroute`
(model downgrade / message redaction) all flow through the same `instrument()`.

## Surface

| Symbol | Notes |
|---|---|
| `instrument(client)` | wraps OpenAI (Chat + Responses) / Anthropic clients; idempotent; async + streaming |
| `instrumentTool(fn)` | emits a `ToolCall` per invocation |
| `Money`, `Usage`, `LLMCall`, `ToolCall` | the cross-language event vocabulary (`events/1`) |
| `bus` | `subscribe` / `unsubscribe` / `emit` |
| `prices` | `estimate` / `models` / `refresh` / staleness — exact `Decimal`, never floats (`prices/1`) |
| `tokens` | `count` / `method` / `family` / `register` via `js-tiktoken` |
| `trace(id, fn)` / `currentTraceId()` | ambient correlation (async-callback scope; inject `AsyncLocalStorage` via `installTraceContext`) |
| `Reroute`, `addInterceptor`, `MISS` | pre-call interception seam used by `@cendor/cassette` & `@cendor/acttrace` |

## Parity & conformance

Field names map `snake_case` (Python) → `camelCase` (TS); type and error names are identical
(`UnknownModelError` in both). Cost math, the model table, `Money` semantics, and token counts are
verified against golden vectors generated from the Python reference — see
[`fixtures/`](../../fixtures). Money is compared by exact decimal *value*.
