---
'@cendor/core': minor
---

**An absent price rate is unknown, never zero.**

3.6.2 closed the *data* half of this: the feed can no longer publish a row without an output rate.
This closes the two halves a data fix cannot reach — the **spec** and the **library** — so a table
that did not come from us can no longer make the same mistake.

`prices/1` used to read an absent `output` as `0`. Right for an embedding, which genuinely bills no
output tokens; wrong for a chat model whose rate merely failed to parse — and downstream the two are
indistinguishable, so `estimate()` reported a fabricated `$0.00` as a *fact* and a USD budget cap
under-counted by the entire output side. Measured on 3.6.2 through a documented API:
`refresh({ source: 'litellm' })` supplied 10 rows with no output rate, and
`estimate('gpt-image-1', 1e6, { outputTokens: 1e6 })` answered **$5.00** where OpenAI's own rates
($5/1M text in, $40/1M image out) make it **$45.00**.

- **New `MissingRateError`**, a subclass of `UnknownModelError`, so every existing handler is
  unaffected — `instrument()`, `otel`, the LangChain handler and `tokenguard` already catch it and
  fall back to an honest `null` / warn-once. Its message names the fix on both call shapes.
- **`estimate()` refuses an unpriceable rate object** whenever it prices the model, not only when the
  call carries output tokens. Three shapes: no `input`, a **table-stated** zero `input`, no `output`.
- **An explicit `output: 0` is honoured forever** (18 bundled rows are real embeddings), and a zero
  **you** registered is honoured too — `prices.register('llama3', { input: 0, output: 0 })` still
  prices a local model free, because a user registration outranks any table.
- **`registerDeployment({ like })` fails at registration** when the base cannot price a call.
- **A mapped `refresh({ source })` drops rows it cannot price** — the mirror of the feed's own rule.
  A pass-through `refresh(url)` is a *table*, not a mapper: every row is kept and `estimate()`
  refuses the unpriceable ones by name.
- There is deliberately no switch back to the old behaviour: state the rate, or state `0`.

Parity: `cendor-core` 1.20.0. Spec: `docs/specs/price-dataset.md` § *Changed 2026-08-02*.
