---
"@cendor/contextkit": patch
---

Deep-QA fix: an empty history `Block({ messages: [] })` no longer reports the misleading `history: dropped all 0 turns (no room)` — it is recorded as `kept` with no note, even with a large budget (L5).
