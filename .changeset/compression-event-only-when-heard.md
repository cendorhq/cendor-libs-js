---
'@cendor/squeeze': patch
---

`compress()` stops paying for a `CompressionEvent` nobody is listening to.

Since the event shipped, every `compress()` ran `tokens.count` twice — over the original *and* the
compressed text — to fill the metadata-only event **before** `bus.emit`, whether or not anything was
subscribed. Measured on a ~78 KB JSON payload with zero subscribers: the two counts were **~88–96%
of the whole call**, and tokenizing is linear in payload size, so every large compress paid it
(including `contextkit`'s `evict: "compress"` path, per block).

`emitCompression` now returns before any counting when `bus.hasSubscribers()` (new in
`@cendor/core` 3.5.0) is false. An event with no subscriber is unobservable, so nothing observable
changes; with anything attached — an acttrace `AuditLog`, a monitor exporter — the event is emitted
exactly as before: same fields, same counts, same duck-typed `compression` audit entry. Honest
limit: the check is "is anyone on the bus", so an app with tokenguard armed still computes the
counts — that is the cost of visibility, now paid only when something can see it.

Pinned both ways by `test/compression-event-cost.test.ts`: zero `tokens.count` calls with zero
subscribers; exactly two, with correct `tokens_before`/`tokens_after`/`ratio`, with one.
