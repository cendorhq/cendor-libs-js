---
"@cendor/acttrace": patch
---

Add `resetDetectors()` — restore the detector registry to the built-in defaults, dropping anything
added by `registerDetector` / `enableEntropyDetector` / `enableLocalePack`. The registry is
module-global (opt in once at startup); this is the inverse — for turning an opt-in detector back
off, dynamic reconfiguration, and test isolation (so a registered detector can't leak into a later
test and scrub, e.g., a high-entropy id from a later audit payload). `registerDetector` is now
idempotent (a detector already present is not added twice).
