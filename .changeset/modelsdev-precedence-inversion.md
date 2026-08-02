---
'@cendor/core': patch
---

Fix: `refresh({ source: 'modelsdev' })` returned a HOST's deployment price where the lab's own
listing was available.

`mapModelsdev` walks its provider allowlist in *reverse* precedence so the highest-precedence
provider is written last and wins — but the guard that stops a host-namespaced id overwriting a bare
one was a plain `if (bare.has(key)) continue`, which **inverts that ordering** whenever two
*allowlisted* providers both key a model with a bare id: the lower-precedence one is written first,
claims the key, and the higher-precedence one is then skipped.

Measured 2026-08-02 against the live `models.dev/api.json`. Four rows affected, every one of them a
host's listing displacing the lab's:

| model | was | now |
|---|---|---|
| `gpt-5.6-luna` | $1 / $6 per 1M *(azure)* | **$0.2 / $1.2** *(openai)* |
| `gpt-5.6-terra` | $2.5 / $15 | **$2 / $12** |
| `deepseek-v4-pro` | $1.74 / $3.48 | **$0.435 / $0.87** |
| `deepseek-v4-flash` | $0.19 / $0.51 | **$0.14 / $0.28** |

Only the `modelsdev` source is affected. The **default** `refresh()` — the cendor-prices feed — and
the bundled snapshot were both already correct, so this reaches only a caller who names that source
explicitly. `mapLitellm` keeps the plain guard **on purpose**: its payload is a flat dict with no
precedence order to appeal to, so "the first bare id wins" is the only rule there.

Caught by the feed builder's day-over-day swing gate (`gpt-5.6-luna` moved 5.00x on all four rate
keys), not by any test here — nothing offline had two allowlisted providers keying one model bare.
Two regression tests added, both proven by poisoning the guard back and demanding the failure.

The bundled price snapshot is also regenerated from the 2026-08-02 feed: same 849 rows, three rates
move, all of them a suppression the feed now makes rather than a price change.

Ships in lockstep with `cendor-core` 1.20.1 — the mapper is a deliberate three-way twin (the feed
builder plus both libraries) and a change to one without the others is drift.
