# Publishing `@cendor/*`

The `@cendor/*` packages are **published on npm**. Releases are automated by
[`.github/workflows/release.yml`](.github/workflows/release.yml) — a **direct publish-on-push**
flow (no "Version Packages" PR), mirroring the Python release flow.

## How a release happens

1. Land your change together with a **changeset**: `pnpm changeset` (pick the affected packages +
   bump type), commit the generated `.changeset/*.md`.
2. Push (or merge) to `main`. `release.yml` runs on every push to `main` and, in one job:
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
- Tests need **no** Python and **no** network — 790+ tests (796 cases across 59 files), including
  the cross-language conformance vectors under [`fixtures/`](fixtures).
- Versions are independent from the Python packages (parity is documented, never version-coupled).
