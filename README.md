<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/cendor-libs-js-banner-dark.png">
    <img alt="cendor-libs-js" src=".github/assets/cendor-libs-js-banner-light.png" width="820">
  </picture>
</p>

# cendor-libs-js

**Production plumbing for LLM applications** — the TypeScript/JavaScript port of the
[Cendor libraries](https://github.com/cendorhq/cendor-libs). A family of small, composable,
framework-agnostic packages that sit *beneath* agent frameworks: context, cost, testing, governance.
ESM-only. Local-first. Apache-2.0.

[![npm: @cendor/libs](https://img.shields.io/npm/v/@cendor/libs.svg?label=%40cendor%2Flibs)](https://www.npmjs.com/package/@cendor/libs) [![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

[**Docs**](https://cendor.ai/docs) · [**Parity matrix**](https://cendor.ai/docs/languages) · [**Packages**](#packages)

> These are the `@cendor/*` npm packages — one implementation of the cross-language
> [format specs](https://github.com/cendorhq/cendor-libs/tree/main/docs/specs). A cassette recorded
> in Python replays here; an audit chain written here verifies in Python. Byte-for-byte.

## Install

```bash
npm i @cendor/libs                       # the umbrella (all six), or à la carte:
npm i @cendor/core @cendor/tokenguard    # provider SDKs are optional peers
```

```ts
import OpenAI from 'openai';
import { instrument, bus, LLMCall } from '@cendor/core';

const client = instrument(new OpenAI());          // wrap once
bus.subscribe((e) => {
  if (e instanceof LLMCall) console.log(e.model, e.usage?.totalTokens, e.cost?.toString());
});
// every call now emits exact token counts + Decimal cost — see each package's README for more.
```

## Packages

| npm | mirrors (Python) | what it does |
|---|---|---|
| [`@cendor/core`](packages/core) | `cendor.core` | shared types, event bus, `Money` (decimal, never float), price table, token counting, `instrument()` |
| [`@cendor/tokenguard`](packages/tokenguard) | `cendor.tokenguard` | budgets & cost enforcement |
| [`@cendor/contextkit`](packages/contextkit) | `cendor.contextkit` | assemble context to a token budget |
| [`@cendor/squeeze`](packages/squeeze) | `cendor.squeeze` | reversible context compression |
| [`@cendor/cassette`](packages/cassette) | `cendor.cassette` | record/replay LLM+tool runs offline |
| [`@cendor/acttrace`](packages/acttrace) | `cendor.acttrace` | tamper-evident audit chain |
| [`@cendor/libs`](packages/libs) | `cendor-libs` | umbrella meta-package |

## Design rules

- **ESM-only**; no Node `fs`/`path` in core code paths — pluggable storage adapters
  (memory / fs / IndexedDB-shaped / Workers KV) for cassette, acttrace, and sessions.
- **Money is never an IEEE float** — string decimals + [`decimal.js`](https://mikemcl.github.io/decimal.js/),
  mirroring Python's `Decimal` discipline.
- **API parity**: `snake_case` (Python) ↔ `camelCase` (TS); identical defaults, type names, and
  error names (`BudgetExceeded` in both). See the
  [parity rules](https://github.com/cendorhq/cendor-libs/blob/main/docs/specs/api-parity.md).

## Develop

```bash
pnpm install
pnpm build       # tsc -b across the workspace
pnpm test        # vitest (no network — ever)
pnpm typecheck
pnpm lint
```

Cross-language conformance vectors live in [`fixtures/`](fixtures) (generated from the Python
libraries, committed so CI needs no Python). Regenerate with `pnpm fixtures` (requires `uv` + a
local checkout of `cendor-libs` beside this repo — it runs both Python generators).
