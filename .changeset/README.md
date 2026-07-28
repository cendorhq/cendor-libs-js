# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets). Run
`pnpm changeset` to record a version bump for one or more packages.

**Releasing takes two steps, and publishing is a MERGE — not a push.**
[`.github/workflows/release.yml`](../.github/workflows/release.yml) triggers on every push to `main`.
Its `verify` job re-runs the whole CI gate (`pnpm install --frozen-lockfile` · `pnpm build` ·
`pnpm check:types` · `pnpm lint` · `pnpm check:major` · `pnpm test`, on Node 20 **and** 22), and the
`release` job declares `needs: verify`, so nothing moves unless every matrix leg is green. What the
`release` job then does depends on whether changesets are pending:

1. **Changesets present** → it opens (or updates) a pull request titled **`chore: version packages`**
   on the branch `changeset-release/main`. That PR runs `changeset version`, so it carries the version
   bumps and the CHANGELOG entries for review. **Nothing is published at this point.**
2. **No changesets, versions already bumped** — i.e. you merged that PR → it runs `changeset publish`,
   which publishes the bumped `@cendor/*` packages to npm (pnpm rewrites `workspace:^` into real
   ranges) and tags each `@cendor/<pkg>@<version>`.

So a release is: land your changeset → review the version PR → **merge it to publish.** A push with no
changesets and no pending bumps versions nothing and publishes nothing.

> This replaced a direct publish-on-push flow on 2026-07-29. Under that flow a single push to `main`
> carrying a changeset went straight to npm with no human step in between — tolerable while the repo
> was private and the audience was one person, but in public an accidental push is a release.

Publishing authenticates with the `NPM_TOKEN` secret. npm **provenance is off** for now
(`NPM_CONFIG_PROVENANCE: "false"`) because sigstore rejects a private source repo; flip it to
`"true"` in `release.yml` once these repos are public.

A **major** bump is never autonomous: it needs the maintainer's approval expressed as an in-band
`Approved-Major:` line in the changeset, and `pnpm check:major` fails the gate without it — before the
version PR is ever opened. See [`PUBLISHING.md`](../PUBLISHING.md) and
[`CONTRIBUTING.md`](../CONTRIBUTING.md).
