---
'@cendor/tokenguard': patch
---

fix(tokenguard): load the optional `better-sqlite3` lazily, so `@cendor/tokenguard/sinks` imports without it

`sinks.ts` carried a **value** import of `better-sqlite3` at module scope. It is an
`optionalDependency`, which npm silently SKIPS when it cannot be installed — so the whole
`@cendor/tokenguard/sinks` subpath became unimportable in that case, taking `QueueSink` and
`OTelSink` (neither of which touches SQLite) down with it.

Measured 2026-07-31 on a clean `node:20-slim` container, linux-x64:

```
prebuild-install warn install No prebuilt binaries found
  (target=20.20.2 runtime=node arch=x64 libc= platform=linux)
gyp ERR! find Python  Could not find any Python installation to use
...
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'better-sqlite3'
  imported from …/node_modules/@cendor/tokenguard/dist/sinks.js
```

`npm install` **succeeds** (a failed optional dependency is skipped), and the failure only appears at
the first import. The same install succeeds on `node:22-slim`, where a prebuild exists — so the bug
is green on Node 22 and red on Node 20.

The fix is the pattern `@cendor/squeeze`'s `store.ts` already used: `import type` plus a
`createRequire` load inside `SQLiteSink`'s constructor. `SQLiteSink` stays fully typed and behaves
identically; it now throws only when you actually construct one without the native module installed,
which is the correct time to find out.

Pinned by `packages/tokenguard/test/sinks-optional-native.test.ts` — a source-level assertion (a
value import is a syntactic property) with a negative control that fails when the eager form returns.
