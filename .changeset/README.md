# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets). Run
`pnpm changeset` to record a version bump for one or more packages.

⚠️ **A changeset publishes on merge — there is no Version PR.** `.github/workflows/release.yml`
triggers on every push to `main`. Its `verify` job re-runs the whole CI gate (`pnpm install
--frozen-lockfile` · `pnpm build` · `pnpm check:types` · `pnpm lint` · `pnpm check:major` ·
`pnpm test`, on Node 20 **and** 22); only when every matrix leg is green does the `release` job run
`changeset version`, commit the bumps back to `main` (`[skip ci]`), and `changeset publish` the
changed `@cendor/*` packages to npm — tagging each `@cendor/<pkg>@<version>`. So **merging a
changeset is the release.** A push carrying no changeset files versions nothing and publishes
nothing.

Publishing authenticates with the `NPM_TOKEN` secret. npm **provenance is off** for now
(`NPM_CONFIG_PROVENANCE: "false"`) because sigstore rejects a private source repo; flip it to
`"true"` in `release.yml` once these repos are public.

A **major** bump is never autonomous: it needs the maintainer's approval expressed as an in-band
`Approved-Major:` line in the changeset, and `pnpm check:major` fails the gate without it. See
[`PUBLISHING.md`](../PUBLISHING.md) and [`CONTRIBUTING.md`](../CONTRIBUTING.md).
