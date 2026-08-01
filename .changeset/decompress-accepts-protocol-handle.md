---
'@cendor/squeeze': minor
---

`decompress()` now accepts any handle that can expand, not just squeeze's own `Handle`.

The handle you are most likely to be holding did not come from `compress()` — it came from
`contextkit`, whose `BlockDecision.handle` is typed as core's `Compressor` **protocol** handle
(`{ expand(): unknown }`), deliberately the smallest thing contextkit needs to know about whatever
backend was registered. Narrowing this parameter to squeeze's concrete class made the obvious line a
compile error on objects that are identical at runtime:

```ts
const cut = ctx.report().decisions.find((d) => d.action === 'compressed');
decompress(cut.handle); // ✗ before — core's Handle is missing id, kind, originalRef, restoreMap…
```

Widening the parameter is backward compatible: squeeze's own `Handle` still satisfies it, and
`.expand()` remains the equivalent protocol-pure call. Python never had this — there
`BlockDecision.handle` is `Any`.

Pinned by `type-tests/protocol-handle.ts`, which covers the concrete handle, a bare protocol handle,
and the real contextkit → squeeze path.
