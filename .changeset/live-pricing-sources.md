---
'@cendor/core': minor
---

Live pricing: three new `refresh()` sources, a rewritten Azure source, and the visibility layer that
makes any rate explain itself. Every number below was measured live on 2026-08-01, in both languages,
with identical results.

**New sources.** `aws` — the Bedrock **public price files**, Amazon's own billing catalog, keyless,
dated from `publicationDate`, one region (`region`, default `us-east-1`). It unions **both** offer
codes, and that is not defensive coding: `AmazonBedrock` alone carries only Claude
2.0/2.1/3-Haiku/3-Sonnet/Instant — `Claude Sonnet 4` and `4.5` exist **only** in
`AmazonBedrockService`, so a single-offer client silently misses every current Claude rate. Rate keys
come from `usagetype`, not `inferenceType`, because Sonnet 4 carries `"Input tokens"` on both the
standard meter ($3/MTok) and the half-price batch one. `modelsdev` — models.dev (MIT), the widest
keyless catalog found, per-1M converted exactly, per-row `last_updated` carried through; restricted to
a first-party provider allowlist because the same id appears under many providers at different prices
(`gpt-5.1` under 11, $1.07–$1.25/MTok) and the biggest are all resellers. `vercel` — the AI Gateway,
**resale** prices like OpenRouter's, base rates only, undatable.

**Azure rewritten.** `serviceName eq 'Foundry Models'`, a **mandatory** region, and pagination. The
pre-rename `productName eq 'Azure OpenAI'` still returned rows — which is exactly why the coverage
loss was invisible — but saw 462 of eastus2's 1,526 meters and **no GPT-5, DeepSeek, Grok, Mistral,
Llama, Phi, Kimi, Qwen or Cohere at all**. End to end: **104 mapped models where the old filter mapped
23**. Also `opt` is now read as **output** (141 rows spell it that way, so every GPT-5.x family had an
input rate and no output rate), and batch / fine-tune / provisioned / long-context / media meters are
excluded rather than winning a cheapest-rate comparison. The region is not an optimisation: unregioned
the query is >25,000 rows and still paging after 28.5 s.

**Visibility.** `prices.explain(model)` returns the resolved id, how it resolved, the rates, the
table's **and the row's** provenance, the age, and honest notes (a registration in effect, a gateway
resale source, an undatable table, an unpriced model). `prices.save(path)` / `prices.load(path)` are
explicit, opt-in persistence across processes carrying provenance through — never an implicit cache.
`refresh(url, { required: true })` throws the new `PriceRefreshError` instead of resolving `false`;
`refresh()` itself stays contractually never-throw.

**The default table moved.** `SNAPSHOT_URL` points at the cendor-prices feed — dated, per-row
provenance, reconciled daily behind validation gates. The bundled snapshot is **generated** from it
rather than hand-typed: 44 rows becomes 861. The hand-feeding drift goes with it (`gpt-5.6-luna` was
5× off every other source).

**A zero input rate is no longer published.** `llama3` (0/0, inherited from litellm) leaves the
snapshot: it made exactly one local model report a fabricated `$0.00` while every other reported
`null`, and `estimate()` returning `$0.00` as a *fact* means a USD cap silently never binds. Say it
yourself if you mean it: `prices.register('llama3', { input: 0, output: 0 })`.

Rates are also coerced to `Decimal` at the table swap, so a pass-through `refresh(url)` against a
table that quotes its rates no longer makes `estimate()` throw.
