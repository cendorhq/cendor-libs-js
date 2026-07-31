---
'@cendor/core': minor
---

`prices.registerModelPrice(model, { input, output })` — the per-1M convenience, now on the libraries
door.

The helper existed only in `@cendor/sdk`, while Python has had `prices.register_model_price` in
`cendor-core` since 1.15.0. That was the last pricing asymmetry between the two cores after
`registerDeployment` landed on both, and it was a documented trap in the making: the libraries-door
providers page tells you to price a Microsoft Foundry deployment, so a TypeScript app following it
imported `registerModelPrice` from `@cendor/core` and got nothing. It now resolves.

Takes the **USD per 1M tokens** numbers a published rate card quotes (`per: '1K' | 'token'` to
change), stores exact per-token `Decimal`, returns the stored rates, and survives `refresh()` like
every registration. `per` is narrowed to a union, so the wrong unit string is a compile error whose
message names the right ones — and the runtime check still covers untyped JS callers.

Use it when you hold the rate card: a fine-tune, a negotiated rate, or a Foundry deployment serving a
model the snapshot has no row for (DeepSeek, Mistral, Phi — the snapshot has no rows for those, so
`registerDeployment(..., { like })` correctly raises rather than guessing). When the deployment serves
a model that *is* in the table, `registerDeployment` stays the shorter path.

`@cendor/sdk`'s `registerModelPrice` is unchanged and still works.
