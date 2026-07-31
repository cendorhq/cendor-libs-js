---
'@cendor/core': minor
---

feat(core): `prices.registerDeployment(name, { like })` — price an Azure/Foundry deployment name

On Azure and Azure AI Foundry the id a call reports is the **deployment name you chose**, not a model
id. It is therefore in no price table: `cost` is `null`, `@cendor/tokenguard` records `$0`, and a USD
budget silently never binds — the blind spot the external black-box suite recorded verbatim as "would
improve DX". You already know which model the deployment serves; this says so once, instead of making
you find and re-type a rate card.

```ts
import { prices } from '@cendor/core';
prices.registerDeployment('prod-gpt4o-eastus', { like: 'gpt-4o' });
prices.estimate('prod-gpt4o-eastus', 1000, { outputTokens: 500 }); // priced like gpt-4o
```

Deliberately **explicit**. This is not the `-preview` / `-latest` alias *guessing* that was considered
and rejected — a confidently wrong price is worse than an honest `null` — and nothing is inferred from
the deployment's name.

**Copy-at-registration, not a live alias.** `like`'s rates are read now and stored as the deployment's
own registration, so a later `refresh()` that reprices the base does **not** reprice the deployment
(call it again to pick that up), and — like every registration — it survives `refresh()` and overrides
a snapshot row with the same id. The alternative would make a deployment's cost depend on whether its
base still exists in whatever table was last fetched, and would have to invent an answer when it
doesn't.

`like` goes through the same lookup reduction a real call does, so a dated or Bedrock-decorated base id
works. An unknown `like` **throws `UnknownModelError`** rather than leaving the deployment quietly
unpriced, which would reproduce the exact silence the function exists to remove. Every rate key is
copied rather than an enumerated few, so a future rate category cannot be silently dropped.

Also re-exported as `registerDeployment` from `@cendor/sdk`. Python parity:
`prices.register_deployment(deployment, like="gpt-4o")` in `cendor-core` 1.16.0.
