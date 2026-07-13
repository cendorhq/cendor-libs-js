---
'@cendor/core': minor
---

Embeddings capture, Usage arithmetic, and a survive-refresh price registry — the core half of the SDK↔lib inheritance fixes.

- **`instrument()` now captures `embeddings.create`** on openai-shaped clients (OpenAI + Azure-via-openai): the pre-flight interceptor pass runs (budget block/clamp and guard redact-before-send now apply to embedding calls — a `Reroute({ messages })` maps back to the raw `input` shape), and the emitted `LLMCall` carries `metadata.embedding = true`, usage from `response.usage`, and cost from the price table. Embeddings leave the documented capture-gaps list.
- **`sumUsage(usages)`** — field-complete `Usage` aggregation next to `sumMoney`: iterates the instances' own numeric fields, so a future `Usage` field can never silently vanish from an aggregate.
- **`prices.register` registrations now survive `prices.refresh()`** — re-applied after every table swap instead of being dropped.
- The bundled price snapshot gains the OpenAI embedding rows (`text-embedding-3-small` $0.02/1M · `text-embedding-3-large` $0.13/1M · `text-embedding-ada-002` $0.10/1M — verified on the official model pages), so USD budgets bind on embedding calls out of the box.
