# @cendor/cassette

[![npm version](https://img.shields.io/npm/v/@cendor/cassette.svg)](https://www.npmjs.com/package/@cendor/cassette) [![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Record real LLM calls once, then replay them in your tests forever — offline, no API key, no cost, and the same result every run. The TypeScript port of [`cendor.cassette`](https://github.com/cendorhq/cendor-libs), byte-conformant with the Python package (same request hashes, same on-disk `cassette/2` format).

The `vcrpy` of the agent era, except it captures the _whole_ run: every LLM call and tool call, in
order. It cooperates through `@cendor/core` — it never patches a client itself. It **records** by
subscribing to the bus, and **replays** by registering a pre-call interceptor that returns the
recorded response by request hash before the real call runs.

## Killer example

```ts
import { instrument } from '@cendor/core';
import { using } from '@cendor/cassette';

const client = instrument(openai); // your real OpenAI/Anthropic client

// First run records to run.json; every run after replays it — no network, no key, no cost.
const answer = await using('tests/fixtures/run.json', { mode: 'auto' }, async () => {
  const resp = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'I was double charged' }],
  });
  return resp.choices[0].message.content;
});
```

Secrets/PII are scrubbed on record (cassettes get committed), but the **matching hash is taken over
the un-redacted request**, so two calls that differ only inside a redacted span (two API keys) still
replay to distinct entries.

## Surface

| Export | Purpose |
| --- | --- |
| `using(target, options?, body)` | Async-scope record/replay a block. `target` is a path or a `CassetteStorage`. |
| `use(target, options?)` | Decorator form: `use(path)(fn)` returns an async wrapper. |
| `promote(tracePath, to, redact?)` | Convert a JSONL call trace into a replayable cassette. Returns entry count. |
| `drift()` | Divergences found by the most recent `mode: 'rerecord'` run. |
| `semanticDrift(threshold?, scorer?)` | Filter `drift()` to _meaningful_ divergences (score `<` threshold). |
| `semanticMatch(actual, expected, threshold?, scorer?)` | Assert meaning (inclusive `>=`). Lexical default. |
| `lexicalScore`, `cosine`, `embeddingScorer`, `openaiEmbeddingScorer` | Scorers for `semanticMatch`. |
| `CassetteEntry`, `CassetteError` | Value type + the replay/read error. |
| `_hash`, `_normalizedRequest`, `_redact`, `_drift` | Internals, exported for conformance vectors. |

**Options:** `mode` is `'auto'` (record if the cassette is missing, else replay), `'record'`,
`'replay'` (fail on an unrecorded call), or `'rerecord'` (run live, report drift, never overwrite).
`normalizer` is a pluggable `event -> request-dict` that owns the whole matching key. `redact` is
`true` (built-in scrubber), `false` (verbatim), or a custom `obj -> obj`.

## Parity notes

- **Byte-conformant hashing.** `request_hash = sha256Hex(canonical(request))` where `canonical` is
  `json.dumps(sort_keys=True, ensure_ascii=False, separators=(",",":"))`. Wire keys are snake_case
  (`request_hash`, `response_type`); the file is `json.dumps(indent=2, ensure_ascii=False)` with no
  trailing newline. Verified against the committed cross-language fixtures under `fixtures/cassette/`
  (the golden `d222f427…` vector).
- **TS calling conventions.** `@cendor/core`'s `instrument()` wrappers are async, so client/tool calls
  are awaited; the context-manager becomes an async-callback scope (`using(path, opts, async () => …)`).
  Tools take positional args (JS has no kwargs), so a tool's arguments normalize to
  `{ args: [...], kwargs: {} }`.
- **Reconstruction is a no-op in JS.** A plain object is both attribute- and index-accessible, so the
  recorded `response_type` (`"object"` vs `"mapping"`) marker is preserved for fidelity but both
  reconstruct to the same deep plain value.
- **Session isolation** uses `node:async_hooks` `AsyncLocalStorage` (Python's `ContextVar`), so
  concurrent `using()` blocks on the shared bus never capture each other's events.
- `localEmbeddingScorer` throws in JS (no static-embedding model is bundled) — wire your own via
  `embeddingScorer(embedFn)`.
