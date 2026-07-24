---
"@cendor/tokenguard": patch
---

`QueueSink` gains drop observability: an optional `onDropError(error, entry)` constructor callback and a `droppedRows()` counter. A row the inner sink's `write` throws on is now counted (and optionally surfaced) instead of being silently swallowed; the drain worker still survives both a bad row and a broken callback.
