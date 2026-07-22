---
"@cendor/cassette": minor
---

Record / replay now key off a session id stamped **at call initiation** (via the `@cendor/core`
ambient seam), with the delivery-time async-local read kept only as a split-brain fallback. A
streamed call created inside a `using()` block but drained on a detached consumer (or while a
different session's scope is active) is now recorded into — and replayed from — the correct
cassette, instead of being lost or captured by the wrong session. The session id is a reserved
top-level metadata key, excluded from the replay fingerprint, so **every existing recorded cassette
replays byte-identically** — nothing to re-record. Requires `@cendor/core` >= 0.10.0.
