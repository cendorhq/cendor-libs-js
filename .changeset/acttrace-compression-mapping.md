---
"@cendor/acttrace": minor
---

Compression enters the audit chain (G21) — squeeze's `CompressionEvent` becomes evidence + a span.

A `@cendor/squeeze` `CompressionEvent` (≥ 0.3) on the bus is duck-typed (keys `technique` + `ratio`) into a `compression` chain entry (metadata only) and mirrored as an `audit.compression` span (`cendor.audit.technique` / `.tokens_before` / `.tokens_after` / `.ratio` / `.store_kind` / `.handle_id` / `.kind`). Metadata-only, so not auto-redacted. Framework control mappings added for all four bundled frameworks. Backward-compatible; the file remains the sole verifiable evidence.
