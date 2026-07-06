# @cendor/libs

All six Cendor libraries in one install — plain building blocks for LLM apps: context, cost, compression, testing, and a tamper-evident audit trail. The TypeScript port of the `cendor-libs` meta-package. One install pulls them all:

```bash
npm i @cendor/libs
```

```ts
import { core, tokenguard, contextkit, squeeze, cassette, acttrace } from '@cendor/libs';

core.instrument(client);
const cost = core.prices.estimate('gpt-4o', 1000, { outputTokens: 500 });
```

Prefer installing an individual package (`@cendor/core`, `@cendor/tokenguard`, …) when you only need
one — this umbrella is the "give me everything" convenience. The agent SDK is a separate install:
`npm i @cendor/sdk`.
