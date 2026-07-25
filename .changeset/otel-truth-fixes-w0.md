---
'@cendor/tokenguard': minor
'@cendor/core': minor
---

**Telemetry truth fixes — attach order and concurrency no longer break the OTel path.**

Two silent defects, both found by a zero-telemetry-code study against a live monitor, both fixed
before the auto-wiring work that depends on them. Neither changes an API.

**`@cendor/tokenguard` — `OTelSink` acquires its meter lazily.** The JS metrics API has no proxy
provider: before your app calls `metrics.setGlobalMeterProvider` (i.e. before `NodeSDK.start()`),
`metrics.getMeterProvider()` is a `NoopMeterProvider` and a counter taken from it stays a no-op
**forever**. Because the sink acquired its counters in the constructor, `useSink(new OTelSink())`
placed above your OTel setup recorded **zero** datapoints, permanently and silently — an undocumented
ordering trap (Python was always safe: its providers proxy). The meter is now acquired on `write()`
and cached only once a real provider answers, so attach order is irrelevant. If your spend counters
were mysteriously empty, this is why.

**`@cendor/core` — the live-spans latch is context-local.** `enterLiveSpans`/`exitLiveSpans` (the
latch that makes the G20 span emitter stand down inside an SDK run) used a module-global counter, so
**one** open scope suppressed the emitter for **every** concurrent async context in the process: an
app mixing an SDK run with concurrent libs-only calls silently lost the flat spans for the latter, and
an unclosed `liveSpans()` handle stuck the latch forever, killing the emitter process-wide. It is now
`AsyncLocalStorage`-backed (falling back to the old counter off-Node), matching Python's `ContextVar`.
Signatures are unchanged.

Also: `bus._subscriberCount()` (a test helper, mirroring Python's `bus._subscriber_count()`).
