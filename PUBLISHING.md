# Publishing `@cendor/*`

The `@cendor/*` packages are **published on npm**. Releases are automated by
[`.github/workflows/release.yml`](.github/workflows/release.yml) — the changesets
**"Version Packages" PR** flow, so **publishing is a merge, not a push**.

## How a release happens

1. Land your change together with a **changeset**: `pnpm changeset` (pick the affected packages +
   bump type), commit the generated `.changeset/*.md`.
2. Push (or merge) to `main`. `release.yml` runs in **two** jobs — a `verify` gate, then `release`,
   which declares `needs: verify`:
   - **`verify`** re-runs the full CI gate — `pnpm install --frozen-lockfile`, `pnpm build`
     (typecheck), `pnpm check:types`, `pnpm lint`, `pnpm check:major`, `pnpm test` — on the same
     **Node 20 + 22** matrix as [`ci.yml`](.github/workflows/ci.yml). Every matrix leg must be green.
   - **`release`** then runs `changesets/action`, which branches on whether changesets are pending:
     - **changesets present** → it opens or updates a PR titled **`chore: version packages`** on the
       branch `changeset-release/main`. That PR runs `changeset version`, so it carries the version
       bumps and the CHANGELOG entries. **Nothing is published yet** — this is the review step.
     - **no changesets, versions already bumped** (you merged that PR) → it runs `changeset publish`,
       which publishes the bumped `@cendor/*` to npm (pnpm rewrites `workspace:^` into real ranges)
       and tags each `@cendor/<x>@<version>`.
3. **Review the version PR, then merge it. The merge is the release.**
4. A push with no changesets and no pending bumps versions nothing and publishes nothing — a no-op.

> **Why the PR step exists (changed 2026-07-29).** This was a direct publish-on-push flow: a single
> push to `main` carrying a changeset went straight to npm, with no human step between the merge and
> the registry. That is tolerable on a private repo with an audience of one; in public an accidental
> push is a release, and a release is irreversible. The version PR is the human step. FLIP-CHECKLIST
> A4.
>
> Two operational notes. The flow needs the org setting *Allow GitHub Actions to create and approve
> pull requests* — without it the action cannot open the PR and the release stalls with a permissions
> error (enabled org-wide 2026-07-29; the repo-level toggle 409s while the org forbids it). And
> `createGithubReleases` is deliberately **off**, preserving today's behaviour of tags-without-GitHub-
> Releases; turning it on is a reasonable follow-up.

Publish this repo's libs **before** `@cendor/sdk` (the SDK depends on them). Versions are
independent from the Python packages — parity is documented, never version-coupled.

### A MAJOR needs the approval twice under this flow — and that is deliberate

`check:major` runs in `verify`, and it checks **two** things: pending changesets that declare `major`
(which need an in-band `Approved-Major:` line), and **`package.json` versions against the last
published tag** (which need an `APPROVED-MAJOR` file naming the exact token). The second check exists
because `changeset version` cannot express every target, so a hand-set major would otherwise sail past.

Under the version-PR flow those two checks fire at *different* moments, because
`changeset version` **consumes the changeset**:

| Moment | Changeset present? | Version bumped? | Which check fires |
|---|---|---|---|
| you push the changeset to `main` | yes | no | the changeset check — needs `Approved-Major:` |
| on the version PR, and after it merges | **no** | **yes** | the tag check — needs `APPROVED-MAJOR` |

So a major release needs **both**: the `Approved-Major:` line in the changeset, *and* an
`APPROVED-MAJOR` file listing the exact token (e.g. `@cendor/core@4.0.0`). Add the file to the version
PR when its CI stops on the tag check — the failure prints the exact token to paste. Verified by
negative control on 2026-07-29: faking `@cendor/squeeze` to `4.0.0` with no changeset and no approval
file exits **1** with `Add this exact token to cendor-libs-js/APPROVED-MAJOR: @cendor/squeeze@4.0.0`.

**Minor and patch releases are unaffected** — the tag check only fires when the major number rises,
which is every routine release's no-op. This is not a workaround: a major is irreversible on npm, and
two independent in-band approvals at two moments is the behaviour you want. Remove the
`APPROVED-MAJOR` file once the release has published.

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
