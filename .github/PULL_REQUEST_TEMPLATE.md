<!-- Thanks for the PR. Keep it focused and green. Full contract: CONTRIBUTING.md -->

## What & why

<!-- What does this change, and what problem does it solve? Link the related issue. Explain the *why* —
     that is the part a reviewer cannot reconstruct from the diff. -->

Affected package(s): <!-- e.g. packages/tokenguard -->

## Gates — run each one bare and read its exit code

<!-- Exactly what CI runs (.github/workflows/ci.yml), on Node 20 and 22. `release.yml` re-runs the
     same list in its `verify` job before anything reaches npm. Never pipe a gate into `tail`/`grep`
     and chain the next step off `&&`: a pipeline's exit code is the last command's, so a failing
     check reads as a pass. -->

```bash
pnpm install --frozen-lockfile
pnpm build          # tsc -b — typecheck + emit every package
pnpm check:types    # Type Teach regression: the decoy overloads must STILL fail to compile
pnpm lint           # biome check .
pnpm check:major    # a major bump needs explicit in-band approval
pnpm test           # vitest, offline
```

- [ ] `pnpm build`
- [ ] `pnpm check:types` — the deliberate `@ts-expect-error` fixtures still error
- [ ] `pnpm lint`
- [ ] `pnpm check:major`
- [ ] `pnpm test` — green, and **offline**: no API key, no network, no Python; provider-shaped stubs or a recorded `cassette` fixture
- [ ] Tried it on Node **20** as well as 24+ if this touches async context, timers, or streams — a test that is green on the newest Node proves nothing about the LTS

## Checklist

- [ ] Tests added or updated in this PR for the new behavior. Fixing a defect? A test that **would have failed before** the fix, and a note on how you know
- [ ] Every exported symbol carries a JSDoc `@example` with the *correct* call shape — that is what an editor's language server (and an AI assistant) hands a reader, and the examples are extracted and typechecked
- [ ] [`docs/parity.md`](../docs/parity.md) updated if this opens or closes a Python↔TypeScript gap — the matrix, not matching version numbers, is the contract between the two languages
- [ ] A [changeset](https://github.com/changesets/changesets) added (`pnpm changeset` → a new `.changeset/*.md`): a **patch** for a fix, a **minor** for a new capability a user can call
- [ ] **No hand-edited version number and no hand-edited `CHANGELOG.md`** — changesets own both, and hand-bumping under changesets corrupts the next release

## The rules this repo will not bend

- [ ] No library imports another library — cooperation goes through `@cendor/core`'s bus / interceptor / protocol seams. A `packages/<tool>` may depend on `@cendor/core` and on nothing else in this workspace
- [ ] Money is `decimal.js`, never a `number` — costs, prices, and budgets end to end. Binary floating point cannot represent a price, and a budget wrong in the 15th digit is a budget nobody can audit
- [ ] All `@cendor/*` libraries still share **one** major, and no package's declared range can resolve a *second* `@cendor/core` in a consumer's tree — two cores is two event buses, and cross-library cooperation then stops *silently*, with every library still passing its own tests. (There is no `check:one-core` script here, because pnpm's workspace linking gives this repo one core by construction; the gate is vendored into the repos that *consume* these packages, and the shared major is what keeps it green there.)
- [ ] Still local-first: no required account, network, or running server; provider SDKs stay optional peers and no `instrument()` target imports one
- [ ] Node built-ins (`node:*`) stay behind an optional subpath or a feature check in any package that documents runtime breadth
- [ ] No agent orchestration added here (loop, handoff/supervisor, tool-schema generation, provider response normalization) — that is [`cendor-sdk-js`](https://github.com/cendorhq/cendor-sdk-js)
- [ ] Every number I added is reproducible from the tests or the benchmark suite, and nothing claims regulatory compliance (`@cendor/acttrace` produces *evidence to support* a case)
- [ ] Commit messages are conventional-ish with a body, and carry **no `Co-Authored-By` trailer**

## ⚠️ A merge to `main` publishes to npm

`release.yml` triggers on push to `main`: when a changeset is present it runs `changeset version`,
commits the bump, and runs `changeset publish`. Its `verify` job re-runs the full gate list above on
the Node 20 + 22 matrix and `release` declares `needs: verify`, so a red build cannot ship — but a
green one ships **immediately**, with no separate approval step.

- [ ] I understand a merge here publishes, and my changeset's bump type is the one I actually want
- [ ] **Crossing a MAJOR?** Not an autonomous decision, in either language: it is irreversible on npm and re-frames the product for every reader. It needs the maintainer's explicit approval, recorded in-band as an `Approved-Major:` line in the changeset or an `APPROVED-MAJOR` file naming the exact version. `pnpm check:major` fails the build without it. Propose it, say what breaks, and wait
