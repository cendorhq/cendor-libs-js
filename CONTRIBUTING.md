# Contributing to `cendor-libs-js`

Thanks for your interest in contributing. This file covers the **TypeScript libraries** repo — the
`@cendor/*` packages on npm. The Python reference implementation lives in
[`cendor-libs`](https://github.com/cendorhq/cendor-libs).

## Ground rules

- **Honest claims.** Every number in docs, READMEs, or the site must be reproducible from the
  benchmark suite or the tests. Never overstate coverage, test counts, provider support, or
  compliance. `acttrace` produces *evidence to support* compliance — never a guarantee.
- **Local-first.** No library may require an account, network, or running server. Provider SDKs are
  **optional peer dependencies**, never hard dependencies.
- **Small, composable, no cross-imports.** The libraries cooperate only through `@cendor/core`'s
  event bus / interceptor seams — they never import one another. A `packages/<tool>` may depend on
  `@cendor/core` and nothing else in this workspace.
- **No `node:*` in a library that claims to be all-runtime.** Where a package documents runtime
  breadth (`@cendor/guardrails`, `@cendor/squeeze`'s core path), keep Node built-ins behind an
  optional subpath or a feature check.
- Be respectful and constructive — see the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting set up

Node **≥ 20** (CI tests 20 and 22) and [pnpm](https://pnpm.io/) — the version is pinned in
`packageManager`, so `corepack enable` is enough to get the right one.

```bash
pnpm install --frozen-lockfile
pnpm build         # tsc -b — typecheck + emit every package
pnpm test          # vitest, offline
pnpm lint          # biome check .
pnpm check:types   # type-level regression tests (the decoy overloads must still error)
```

All tests run **offline** — no API key, no network, no Python. If a change needs a network call to
pass, it doesn't belong in the test suite (use a recorded `cassette` fixture instead). The
cross-language conformance vectors in [`fixtures/`](fixtures) are generated from the Python reference
and committed for exactly this reason.

Useful extras:

- `pnpm lint:fix` / `pnpm format` — apply Biome's fixes.
- `pnpm check:major` — asserts a major bump carries explicit approval (runs in CI; see below).

## Making a change

1. Open an issue first for anything non-trivial, so we can agree on the approach.
2. Fork, branch, and keep changes focused. Match the surrounding code's style and run Biome.
3. Add or update tests in the same PR. New behavior ships with tests. When you fix a defect, prefer a
   test that **would have failed before** the fix, and say in the PR how you know.
4. Add a [changeset](https://github.com/changesets/changesets) (`pnpm changeset`) describing the
   change and the bump type: a new capability a user can call is a **minor**, a fix is a **patch**.
5. Keep the [parity matrix](docs/parity.md) honest. If a capability exists in Python and not here (or
   the other way round), say so there — the matrix, not matching version numbers, is the contract
   between the two languages.
6. Public API? Give every exported symbol a JSDoc `@example` with a correct call shape. The examples
   are extracted and typechecked, so a wrong one fails a build rather than misleading a reader.
7. Open a PR against `main` with a clear description of the *why*.

## Versioning

- **All `@cendor/*` libraries share one major.** They move together, because they cooperate through a
  single in-process event bus in `@cendor/core` — two copies of core is two buses, and cooperation
  then stops silently. Minors and patches stay independent per package.
- **A major bump is never an autonomous decision.** It is irreversible on npm. `pnpm check:major`
  fails any bump that crosses a major without explicit in-band approval in the changeset.
- Versions are **independent across languages**; parity is documented, never version-coupled.

## Commit and PR conventions

- Conventional-ish commit messages (`feat:`, `fix:`, `docs:`, `chore:`), with a body explaining the
  reasoning. No `Co-Authored-By` trailers.
- Keep PRs green. CI runs build/typecheck, type-tests, lint, the major-approval check, and the test
  suite on Node 20 and 22 — and the release workflow re-runs that same gate before it can publish, so
  a red build cannot ship. See [`PUBLISHING.md`](PUBLISHING.md).

## License

By contributing, you agree that your contributions are licensed under the project's Apache-2.0
license.
