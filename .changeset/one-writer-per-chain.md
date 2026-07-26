---
'@cendor/acttrace': patch
---

**Two live `AuditLog`s on one chain file are now refused instead of silently corrupting it.**

Reopening a chain path has been supported since the resume fix — a process restarts, constructs an
`AuditLog` over the same path, and the chain continues from the last on-disk entry. What was never
guarded is two logs alive **at the same time** on one path: both subscribe to the process-global bus,
so one `LLMCall` is auto-captured twice, and each appends at its own `seq`/`prevHash` — identical
right after the reopen. The file ends up holding two interleaved chains and `verify()` reports
`broken link at seq N: prev_hash mismatch`. Nothing warned at the time; the evidence was only
discovered to be broken when someone audited it.

Constructing a second live log on a path another one already holds now throws, naming the way out
(`detach()` the first, rotate to a file per process lifetime, or reuse the log). A **sequential**
reopen is untouched — that is the restart case, and it verifies green. Measured: this is what a
"restart" test hits when it never ends the first log's life, which is how the defect was reported as
a broken resume rather than a double writer.

Claims are held weakly, so a log dropped without `detach()` cannot strand its path. Path-less
(in-memory) logs and logs given an injected `storage` are never registered. Cross-process writers
cannot be detected in-process — one writer per chain file remains a documented limit.
