---
'@cendor/core': minor
---

`bus.hasSubscribers()` — `true` when at least one subscriber is registered.

It exists so an emitter can skip *building* an expensive event nobody would receive:
`@cendor/squeeze` ≥ 3.1.0 gates the two `tokens.count` passes that fill its `CompressionEvent` on
it (measured at ~93% of a large `compress()` with nothing listening). It answers "is anyone on the
bus", not "is anyone listening for this event type", and it is advisory: a subscriber registered
concurrently between the check and the `emit` misses that one event — benign, since the event
predates its subscription. The private `_subscriberCount()` test helper is unchanged.
