---
'@cendor/core': patch
---

Add `otel._isolateLiveSpans(fn)` — an internal seam the SDK's automatic run scope needs.

`enterLiveSpans()` mutates the *current* async context's depth, and an async function's body starts in
its **caller's** context, so a scope opened inside `run()` bound the caller while the matching close
(after an `await`) bound only the resumed continuation. The caller was left latched: its later
libs-only calls silently lost their spans, and two concurrent runs shared one latch (the second seeing
"a scope is already open" and emitting no root). This runs a callback with the depth isolated, so the
automatic scope is airtight. The public `enterLiveSpans`/`exitLiveSpans` API is unchanged.
