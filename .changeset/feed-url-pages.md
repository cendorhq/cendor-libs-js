---
'@cendor/core': patch
---

`SNAPSHOT_URL` moves to the feed's GitHub Pages URL
(`https://cendorhq.github.io/cendor-prices/prices.json`).

The `cendorhq/cendor-prices` repo is private — the builder, the curation policy and the run history
are internal — so the `raw.githubusercontent` URL 3.6.0 shipped requires auth and would 404. A
data-only `gh-pages` branch publishes the file itself, keyless and CDN-served, and Pages returns it
as `application/json` rather than raw's `text/plain`.

**Anyone on 3.6.0 should upgrade**: there, a bare `await prices.refresh()` fails and — because
`refresh()` is contractually never-throw — resolves a silent `false`, leaving the bundled snapshot
active. Nothing is wrong with the rates in 3.6.0; only the default refresh target is unreachable.
