---
'@cendor/core': patch
---

**`instrument()` no longer costs you the provider SDK's response surface.**

openai-node and anthropic-node return an `APIPromise` — a Promise subclass whose `asResponse()` and
`withResponse()` are the documented way to read response headers (`x-request-id` for a support
ticket, rate-limit remaining, `retry-after`). The wrapper was an `async` arrow, and an async
function's return is always a *native* Promise, so both methods came back `undefined`. Since
`instrument<T>(client: T): T` preserves the client type, TypeScript kept insisting they existed: the
call type-checked and threw at runtime.

An instrumented client now hands back something that keeps those accessors. `then`/`catch`/`finally`
stay on cendor's own chain — deliberately, so a **post-flight** block (guardrails' output stage
raises *after* the call) still rejects the caller's promise — while every other method is forwarded to
the SDK's own object. Reading the body twice is safe: the SDKs memoize their parse.

Plain-promise SDKs (Gemini, Ollama, Hugging Face) are untouched — no proxy, no cost. Pre-flight
refusals (a tokenguard budget block, an acttrace guard) still **reject** rather than throwing
synchronously, and `pre()`/interceptors still run in the caller's synchronous frame, so ambient run
attribution is unchanged.

**Honest limit:** a **streamed** call still resolves to cendor's wrapped stream (it has to, to count
chunks), and a **replayed** call has no HTTP response at all — so `asResponse`/`withResponse` are
available on non-streamed live calls.

**Also fixed: `responses.parse` is captured.** The Responses structured-output entrypoint issues its
own request rather than delegating to `create`, so a structured-output call emitted **no event at
all** — no budget, no audit entry, no test. It is now an instrumented target with the same
request/response shape as `create` (exactly one `LLMCall` per call), `typeof`-gated so an older SDK
without it is simply not wrapped. Parity with `cendor-core` 1.14.1.
