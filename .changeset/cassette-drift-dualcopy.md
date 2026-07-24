---
"@cendor/cassette": patch
---

`_drift` is now anchored on the global symbol registry (`Symbol.for('cendor.cassette.drift')`), so two loaded copies of `@cendor/cassette` share one drift buffer instead of each splitting off its own — mirroring core's cross-copy sentinel pattern (the dual-copy hazard the 0.3.0 ambient-session fix closed for sessions). No API change.
