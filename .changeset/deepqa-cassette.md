---
"@cendor/cassette": patch
---

Docs/typing: `localEmbeddingScorer` is now clearly documented as **Python-only — always throws** in JS (there is no maintained model2vec JS port). The symbol exists only so the name is discoverable and the failure is an immediate, clear error, not a working scorer; wire your own embedder via `embeddingScorer` (L9).
