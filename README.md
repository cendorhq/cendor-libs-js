# cendor-libs-js

**Production plumbing for LLM applications** — the TypeScript/JavaScript port of the
[Cendor libraries](https://github.com/cendorhq/cendor-libs). A family of small, composable,
framework-agnostic packages that sit *beneath* agent frameworks: context, cost, testing, governance.
ESM-only. Local-first. Apache-2.0.

> These are the `@cendor/*` npm packages — one implementation of the cross-language
> [format specs](https://github.com/cendorhq/cendor-libs/tree/main/docs/specs). A cassette recorded
> in Python replays here; an audit chain written here verifies in Python. Byte-for-byte.

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

## Design rules (from the plan)

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
local checkout of `cendor-libs`).
