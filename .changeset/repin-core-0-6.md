---
'@cendor/tokenguard': patch
'@cendor/contextkit': patch
'@cendor/squeeze': patch
'@cendor/guardrails': patch
'@cendor/cassette': patch
---

Re-pin `@cendor/core` to the 0.6.0 shelf (no code change). A 0.x caret never crosses a minor, so without this bump a fresh install mixing these libs with `@cendor/core@0.6.0` consumers (e.g. `@cendor/sdk` ≥ 0.10.0) would resolve two coexisting core copies — two buses, split governance. One deduped core restores the single seam.
