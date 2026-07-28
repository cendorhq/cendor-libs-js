# @cendor/libs

[![npm version](https://img.shields.io/npm/v/@cendor/libs.svg)](https://www.npmjs.com/package/@cendor/libs) [![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

All seven Cendor libraries in one install — plain building blocks for LLM apps: context, cost, compression, a deterministic guardrails gate, testing, and a tamper-evident audit trail. The TypeScript port of the `cendor-libs` meta-package. One install pulls them all:

```bash
npm i @cendor/libs
```

Using an AI coding assistant? `npx @cendor/init` (TS) / `uvx cendor-init` (Python) wires it up — or point it at [cendor.ai/docs/for-ai-assistants](https://cendor.ai/docs/for-ai-assistants).

```ts
import { core, tokenguard, contextkit, squeeze, guardrails, cassette, acttrace } from '@cendor/libs';

core.instrument(client);
const cost = core.prices.estimate('gpt-4o', 1000, { outputTokens: 500 });
```

Prefer installing an individual package (`@cendor/core`, `@cendor/tokenguard`, …) when you only need
one — this umbrella is the "give me everything" convenience. The agent SDK is a separate install:
`npm i @cendor/sdk`.

## Docs

Full documentation is at [cendor.ai/docs](https://cendor.ai/docs) — one searchable site with a
Python/TypeScript toggle on every code block.

- **The seven libraries** — [core](https://cendor.ai/docs/core) · [contextkit](https://cendor.ai/docs/contextkit) · [squeeze](https://cendor.ai/docs/squeeze) · [tokenguard](https://cendor.ai/docs/tokenguard) · [guardrails](https://cendor.ai/docs/guardrails) · [cassette](https://cendor.ai/docs/cassette) · [acttrace](https://cendor.ai/docs/acttrace)
- [Getting started](https://cendor.ai/docs/getting-started) · [Architecture](https://cendor.ai/docs/architecture) · [Providers](https://cendor.ai/docs/providers) · [FAQ](https://cendor.ai/docs/faq)
- [Parity matrix](https://cendor.ai/docs/languages) — what's ported and what's Python-only. All
  `@cendor/*` libraries share one major, so anything on major 3 works with anything else on major 3.
- Site: [cendor.ai](https://cendor.ai) · Source: [cendorhq/cendor-libs-js](https://github.com/cendorhq/cendor-libs-js)
