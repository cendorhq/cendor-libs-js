# Publishing `@cendor/*`

The `@cendor/*` packages are **published on npm**. Releases are automated by
[`.github/workflows/release.yml`](.github/workflows/release.yml) — a **direct publish-on-push**
flow (no "Version Packages" PR), mirroring the Python release flow.

## How a release happens

1. Land your change together with a **changeset**: `pnpm changeset` (pick the affected packages +
   bump type), commit the generated `.changeset/*.md`.
2. Push (or merge) to `main`. `release.yml` runs on every push to `main` in **two** jobs — a `verify`
   gate, then `release`, which declares `needs: verify`:
   - **`verify`** re-runs the full CI gate — `pnpm install --frozen-lockfile`, `pnpm build`
     (typecheck), `pnpm check:types`, `pnpm lint`, `pnpm check:major`, `pnpm test` — on the same
     **Node 20 + 22** matrix as [`ci.yml`](.github/workflows/ci.yml). Every matrix leg must be green.
   - **`release`** then does the publish work:
     - `pnpm install --frozen-lockfile` + `pnpm build`;
     - `changeset version` — applies pending changesets: bumps versions and writes CHANGELOGs;
     - commits that back to `main` as `chore: version packages [skip ci]` (the `[skip ci]` marker
       stops it re-triggering);
     - `changeset publish` — publishes the bumped `@cendor/*` packages to npm (pnpm rewrites
       `workspace:^` ranges to real version ranges at pack time) and tags each `@cendor/<x>@<version>`;
     - `git push --follow-tags`.
3. A push with **no** pending changesets versions nothing and publishes nothing — it's a no-op.

Publish this repo's libs **before** `@cendor/sdk` (the SDK depends on them). Versions are
independent from the Python packages — parity is documented, never version-coupled.

### The publish gate — a red build cannot ship

`ci.yml` and `release.yml` are both `push: main` triggers. Before the `verify` job existed they ran
**independently**, with no dependency between them, so a failing CI run did not stop a publish:
commit `00930d6` failed CI and published `@cendor/*` to npm in the same push. `release.yml` now runs
its own copy of the CI gate first and the publish job declares `needs: verify`, so npm is downstream
of a green build on both supported Node versions.

Two consequences worth knowing:

- **`verify` deliberately duplicates `ci.yml`'s step list** instead of using `workflow_run`. A
  `workflow_run` trigger fires as a separate event whose head commit can differ from the one that was
  tested — a race you do not want on a workflow that publishes. The cost is that the two step lists
  must be kept in sync: **add a gate to `ci.yml`, add it to `verify` too.**
- The gate includes `pnpm check:major`, so an unapproved major bump fails before anything is
  published — a major is irreversible on npm.

An npm publish cannot be undone (unpublish is limited to a 72-hour window and the version can never
be reused), which is why the gate is in front of the publish rather than a red badge after it.

## Authentication & provenance (current state)

- The workflow authenticates to npm with an **automation token** in the `NPM_TOKEN` repository
  secret (`NODE_AUTH_TOKEN`).
- **Provenance is currently off** (`NPM_CONFIG_PROVENANCE: "false"` in `release.yml`). npm/sigstore
  provenance requires a **public** source repository (private sources are rejected with `E422`).
  These repos are private today, so provenance stays off; flip it to `"true"` once the repo is public.

### Upgrade path — OIDC trusted publishing (tokenless)

Once the repo is public, the more secure setup is npm **Trusted Publishing** (OIDC): drop
`NODE_AUTH_TOKEN`/`NPM_TOKEN` and register each package's trusted publisher on npmjs.com. This binds
`cendorhq/cendor-libs-js` + `release.yml` to each package and publishes with provenance and no
long-lived token. Trusted publishing can only bind to a package that **already exists**, so every
`@cendor/*` package must be published at least once first (they are), after which the token can be
retired.

## The unscoped `cendor` brand alias (later)

Publish the unscoped `cendor` npm name later as a **real tiny pointer package** (a meta that depends
on `@cendor/libs`), never an empty placeholder (npm anti-squatting policy).

## Notes

- `packageManager` is pinned (`pnpm@9.14.2`); CI uses `--frozen-lockfile`.
- Tests need **no** Python and **no** network — 899 tests across 72 files (measured 2026-07-28),
  including the cross-language conformance vectors under [`fixtures/`](fixtures).
- Versions are independent from the Python packages (parity is documented, never version-coupled).
