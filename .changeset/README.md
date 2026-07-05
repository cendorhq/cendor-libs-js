# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets). Run
`pnpm changeset` to record a version bump for one or more packages; CI's release workflow opens a
version PR and, on merge, publishes the changed `@cendor/*` packages to npm with provenance via
OIDC trusted publishing (tag ≍ version asserted).
