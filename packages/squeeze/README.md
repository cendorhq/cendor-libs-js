# @cendor/squeeze

[![npm version](https://img.shields.io/npm/v/@cendor/squeeze.svg)](https://www.npmjs.com/package/@cendor/squeeze) [![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Shrink long prompts to hit a token budget and expand them back exactly — the same input always produces the same output, with no LLM and no model download. Compression returns a *handle*; the original is always restorable, byte-for-byte. The TypeScript port of [`cendor-squeeze`](https://github.com/cendorhq/cendor-libs).

The TypeScript port of [`cendor-squeeze`](https://github.com/cendorhq/cendor-libs). Satisfies
`@cendor/core`'s `Compressor` protocol by shape, so context tooling can use it without importing it.

Using an AI coding assistant? `npx @cendor/init` (TS) / `uvx cendor-init` (Python) wires it up — or point it at [cendor.ai/docs/for-ai-assistants](https://cendor.ai/docs/for-ai-assistants).

```ts
import { compress, decompress } from '@cendor/squeeze';

const [small, handle] = compress(hugeJson, { kind: 'auto' });                    // detect + route
const [small2] = compress(sourceCode, { kind: 'code', fidelity: 'aggressive' });
const [small3] = compress(logs, { kind: 'logs', targetTokens: 400 });           // compress to a budget
const original = handle.expand();                                               // restore, byte-for-byte
decompress(handle) === handle.expand();                                          // true
```

## Surface

| Symbol | What it does |
|---|---|
| `compress(content, opts?)` | `[small, handle]`. `opts`: `kind` (`"auto"` detects), `targetTokens` (never exceeded), `model` (`"gpt-4o"`), `fidelity` (`"lossless" \| "balanced" \| "aggressive"`). Accepts a string or a JSON-serializable object. |
| `decompress(handle)` | `handle.expand()` — the exact original. |
| `detect(content)` | `"json" \| "logs" \| "code" \| "prose"`. |
| `Handle` | `.expand()`, `.technique`, `.toDict()`, `Handle.fromDict()`, `.id`, `.kind`, `.originalRef`, `.restoreMap`. |
| `SqueezeCompressor` | Object form matching core's `Compressor` protocol. |
| `useStore(store)` | Swap the content-addressed store (CCR) backend; returns the previous one. |
| `MemoryStore(maxItems?)` · `SQLiteStore(path)` | CCR backends (also at `@cendor/squeeze/store`). `MemoryStore` is LRU-capped; `SQLiteStore` persists (via optional `better-sqlite3`). |

- **Four compressors** — JSON (minify + drop nulls; budget-shrink drops keys/elements *structurally*, staying valid JSON), logs (normalize timestamps/UUIDs/IPs/hex/integers + dedup repeats into `(×N)`, chronological), code (string-aware comment stripping — a `//` or `#` inside a literal stays put; keeps preprocessor & shebang), prose (extractive, abbreviation-aware sentence splitting).
- **Compress to a budget** — `targetTokens` is never exceeded.
- **100% reversible** — a content-addressed store (deduped by sha256) keeps every original; `handle.expand()` restores it no matter how hard you squeeze. The deterministic handle id is the first 32 hex of `sha256(`ref:technique`)`.

## Parity note

Faithful port of the Python package: same public symbols, defaults, string-literal values (`kind`,
`fidelity`, technique strings, the `×` dedup marker U+00D7), algorithms, and error names (`KeyError`,
invalid-`fidelity` throws). Python `snake_case` keyword args become a trailing options object;
`content_ref`/`restore_map` stay snake_case inside `toDict()` for cross-language persistence.

One deliberate difference: token counts. `@cendor/core` bundles `js-tiktoken`, so `tokens.count`
returns **real tiktoken** numbers for `gpt-4o` (not Python's forced `ceil(len/4)` test heuristic).
The compressors call the same counter their budget checks do, so every guarantee — `targetTokens`
never exceeded, reversibility, ordering — holds identically; only exact token *counts* differ from
the Python test fixtures.
