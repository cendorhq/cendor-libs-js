---
"@cendor/guardrails": minor
---

TypeScript parity for the semantic gate's local embedder (plan-guardrails-v04 follow-up). Additive; sync `embed` behaviour is unchanged.

- **`embed` may now be sync OR async** across `rules.customCategory` / `deniedTopics` / `groundedness` / `rules.intent`. A sync embed keeps the check synchronous (usable via `apply()` / `install()`, unchanged); an async embed (a hosted embeddings endpoint, or the new `localEmbedder`) makes the check async — run it through `applyAsync` or the SDK loop. This unblocks every realistic JS embedder (they're async), closing the gap that previously forced a sync-only embed.
- **`embeddings.localEmbedder(opts?)`** — a zero-config, offline `embed` backed by **transformers.js** (`@huggingface/transformers`), lazy-imported as an **optional peer** (never bundled; a clear, actionable error if absent — mirroring Python's lazy `model2vec`). Returns an **async** embed (default model `Xenova/all-MiniLM-L6-v2`, mean-pooled + normalized).
- **Cross-language note:** Python's `local_embedder` uses model2vec static embeddings (sync); there is no maintained model2vec JS port, so TS uses transformers.js (async). The *capability* is now at parity — the backend and sync/async shape differ, documented in the parity matrix. No catch-rate claim.
