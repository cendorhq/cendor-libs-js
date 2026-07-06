---
"@cendor/acttrace": minor
---

Add the `acttrace` CLI bin so `npx acttrace verify <path> [--key K] [--expect-head H]
[--expect-entries N]` works, and correct the NER hint for JS: `nerRedactor()` now throws an honest
message stating NER-backed redaction is Python-only (regex/pattern detectors ship in the JS port) —
no more misleading `pip install` suggestion.
