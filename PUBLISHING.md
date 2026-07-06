# Publishing `@cendor/*`

Nothing is published yet. Two paths — **Option A is wired and active**; Option B is optional later.

## Option A — automated with `NPM_TOKEN` (active) ✅

`release.yml` authenticates with an npm **automation** token, which can create brand-new packages, so
the very first release is automated too (no manual bootstrap). One-time setup:

1. npmjs.com → avatar → **Access Tokens → Generate → Automation** (as an owner/member of the `cendor`
   org). Copy the token.
2. GitHub → this repo → **Settings → Secrets and variables → Actions → New repository secret**:
   name `NPM_TOKEN`, value = the token.
3. Land a changeset (`pnpm changeset`), push to `main`. `release.yml` opens a **"Version Packages"**
   PR (bumps versions + CHANGELOGs). Merge it → the workflow **publishes** the changed `@cendor/*`
   packages with provenance and tags each `@cendor/<x>@<version>`. Done — every future release is the
   same two-step (changeset → merge version PR).

Publish this repo's libs **before** `@cendor/sdk` (the SDK depends on them). Versions are independent
from the Python packages; parity is documented, never version-coupled.

## Option B — tokenless OIDC trusted publishing (optional, more secure)

Drop `NODE_AUTH_TOKEN` from `release.yml` and instead configure each package's **Trusted Publisher**
on npmjs.com (§2 below). Caveat: trusted publishing can't bind to a package that doesn't exist yet, so
each package needs one **manual first publish** (§1) before its trusted publisher can take over.

---

## 0. Prerequisites
- The npm org **`cendor`** exists and you're an owner (it does — the `@cendor/*` scope is registered).
- The GitHub repo `cendorhq/cendor-libs-js` exists (private is fine) with this code pushed to `main`.
- npm CLI ≥ 11.5 in CI (the `actions/setup-node@v4` + Node 22 image satisfies this).

## 1. First publish is manual (trusted publishing can't bootstrap a non-existent package)
npm trusted publishing binds a **repo+workflow** to an **existing** package. For a brand-new package
name there's nothing to bind yet, so do the very first publish of each package manually from a clean
checkout, then switch to CI/OIDC for every release after.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test           # 402 tests, no network
npm login           # an account with publish rights to @cendor
# publish each package (order doesn't matter for npm resolution, but core first is tidy):
for p in core tokenguard contextkit squeeze cassette acttrace libs; do
  npm publish --workspace @cendor/$p --access public --provenance
done
```
`--provenance` requires the publish to run in a provenance-capable environment; if publishing the
very first version from a laptop without provenance, drop `--provenance` for that one bootstrap
publish and let CI attach provenance from the next release onward.

## 2. Configure trusted publishing (per package, one-time, on npmjs.com)
For each of the 7 packages (`@cendor/core`, `@cendor/tokenguard`, `@cendor/contextkit`,
`@cendor/squeeze`, `@cendor/cassette`, `@cendor/acttrace`, `@cendor/libs`):
1. npmjs.com → the package → **Settings → Trusted Publisher**.
2. Add a GitHub Actions publisher:
   - Organization/user: `cendorhq`
   - Repository: `cendor-libs-js`
   - Workflow filename: `release.yml`
   - Environment: *(leave blank — the workflow uses none)*
3. Save. Now `release.yml` can publish **without an `NPM_TOKEN`** (OIDC), with provenance.

## 3. Every release after that (fully automated)
1. Land changes with a changeset: `pnpm changeset` (pick packages + bump type), commit it.
2. Merge to `main`. `release.yml` opens a **"Version Packages"** PR (bumps versions + writes
   CHANGELOGs).
3. Merge that PR. `release.yml` runs again, sees no changesets, and **publishes** the bumped
   packages to npm via OIDC with provenance. It tags each `@cendor/<x>@<version>`.

## 4. The unscoped `cendor` brand alias (later)
Per the plan, publish the unscoped `cendor` npm name later as a **real tiny pointer package** (a
meta that depends on `@cendor/libs`), never an empty placeholder (npm anti-squatting policy). Not
part of this first release.

## 5. Notes
- `packageManager` is pinned (`pnpm@9.14.2`); CI uses `--frozen-lockfile`.
- Tests need **no** Python and **no** network — conformance vectors are committed under `fixtures/`.
- Versions are independent from the Python packages (parity is documented, never version-coupled).
