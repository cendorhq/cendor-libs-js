---
"@cendor/core": minor
---

Add the ambient metadata seam — the one core-owned pre-emit capture point. `addAmbientProvider(fn)` /
`removeAmbientProvider(fn)` register a `(event) => metadata | undefined` provider that runs at every
event's construction (the caller's synchronous frame, before interceptors), merging its metadata onto
`event.metadata` with never-throw / never-overwrite / registration-order semantics and a zero-provider
single-length-check fast path. This is how a library (or app) attaches run context — agent,
conversation id, budget frames, cassette session — at the moment it is unconditionally correct,
instead of re-reading async-local storage at bus-delivery time (which breaks for streams finalized
outside the originating scope, context-losing layers, subscriber order, and concurrent runs).

Also: `otel.ingest()` now stamps the ambient `traceId` at construction so an ingested call joins its
run; the libs-only span emitter maps `metadata.agent` → `gen_ai.agent.name`; and the LangChain
callback handler stamps the agent/chain/LangGraph-node name into `metadata.agent` (explicit
`metadata.agent` wins). No shape change to `events/1` — everything rides the sanctioned `metadata`
extension point.
