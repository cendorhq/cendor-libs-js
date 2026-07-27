---
'@cendor/core': patch
---

The provider SDK's own helper methods work under `instrument()` again.

`openai-node` builds `responses.parse`, `chat.completions.parse` and `runTools` on
`APIPromise._thenUnwrap`, which derives a **new** promise sharing the fetch `Response` and calls the
*original's* `parseResponse` a second time. A fetch body can only be read once, and cendor's capture
chain parses too — so an instrumented `responses.parse()` threw
`TypeError: Body is unusable: Body has already been read` and emitted no event. (Below 0.16.1 it
failed earlier still, with `_thenUnwrap is not a function`, because the accessors were stripped.)
Measured against the real openai 6.49.0 SDK on the published shelf.

- That parse step is now memoized on the SDK's own promise, so every consumer — ours and any derived
  promise — shares a single read. Duck-typed, no SDK import, inert on a promise without it.
- `responses.parse` is **no longer an `instrument()` target**. It was added in 0.16.1 for parity with
  Python, but in this SDK it is a helper *built on* `create`, so a second target counts one request
  twice; the wrapped `create` already captures it exactly once. Python is the language where `parse`
  POSTs its own request and therefore does need its own target — parity of behaviour, not of
  mechanism. The same reasoning is why `chat.completions.parse` is not a target here either, though
  it is one in `cendor-core` 1.14.2.

The test that missed this used a fake whose `parse` returned its own promise instead of delegating to
`create`; the new fixture models the real architecture — one-shot body, memoizing `parse()`,
re-parsing `_thenUnwrap` — so the defect is expressible offline.

A third helper, found by surveying the rest of the family rather than stopping at `parse`:
**`anthropic.messages.stream()` threw under `instrument()`.** It is built on
`messages.create({...,stream:true}).withResponse()` (`lib/MessageStream.mjs`), and a streamed call
returned cendor's plain chain, which has no `withResponse` — so an instrumented Anthropic client
broke the SDK's own streaming helper with
`AnthropicError: messages.create(...).withResponse is not a function`. Measured on the published
0.16.1 against the real `@anthropic-ai/sdk` 0.112.5. A streamed call now keeps the accessors too, and
`withResponse()` hands back the SDK's `response` with **cendor's counting stream** as `data` —
forwarding the SDK's raw stream would have unbroken the helper while silently counting nothing.
`openai`'s `chat.completions.stream` was measured in the same sweep and already worked (it delegates
to `create`).
