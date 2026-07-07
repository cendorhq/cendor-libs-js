---
"@cendor/acttrace": patch
---

Docs: correct the README to reflect the optional `compromise`-backed NER shipped in 0.4.0.

The published README still described the pre-0.4.0 state ("regex/pattern detectors only", `nerAvailable()` → `false`, `nerRedactor()` throws, "NER intentionally absent"). It now documents the actual capability: `nerRedactor()` is a working name/place/org redactor when the optional `compromise` peer dep is installed (English-only, lighter than Python's Presidio — not full parity), and `nerAvailable()` reports its presence. No code change — this republishes the corrected README to npm.
