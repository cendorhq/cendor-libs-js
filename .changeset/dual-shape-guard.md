---
'@cendor/acttrace': minor
---

The dual-shape guard: `guard()` is now scope-capable, so the SDK can re-export the identical object (`Object.is(sdk.guard, acttrace.guard)`). Backward-compatible — the raw interceptor form is unchanged.

- **`guard(opts, fn)` scope form.** `guard({ policy, audit, onBlock }, fn)` installs the interceptor on core's seam, runs `fn`, and removes it on the way out (exception-safe) — the TS analogue of Python's `with guard(...):`. The raw form `guard(policy, audit?, onBlock?)` still returns the plain interceptor for `addInterceptor`. Enforcement still lives on core's seam — the recorder/enforcer split is intact.
- **`resolveFindings(findings, policy?)`** — the per-category action resolution `guard()` applies, exported: partitions findings into `{ block, redact, flag }`; with `policy` given, each finding is re-resolved against it (scan under one policy, enforce under another). Composers (like the SDK's pii/secrets bridge) can now honor per-category actions instead of flattening to one.
- New exported types: `GuardOptions`, `OnBlock`, `ResolvedFindings`.
