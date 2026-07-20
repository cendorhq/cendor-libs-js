---
"@cendor/squeeze": minor
---

Compression visibility on the bus (G21) — squeeze stops being dark to a monitor/audit.

`compress()` now emits a metadata-only `CompressionEvent` (`technique`, `tokens_before`, `tokens_after`, `ratio`, `store_kind`, `handle_id`, `kind`, `trace_id`, `ts`). It carries **only the shape** of a compression — never the text — so a monitor or the acttrace audit can show squeeze activity and token savings without any content leaving the process. `@cendor/acttrace` (≥ 0.9) duck-types it into a `compression` audit entry + an `audit.compression` span.
