---
'@cendor/acttrace': minor
---

A chain now names the format it implements and the library that opened it.

A new chain's `audit_open` entry carries two fields: `format` (the wire spec — `acttrace-chain/1`)
and `producer` (`@cendor/acttrace/<version>`). They sit **inside** the hashed payload, so they are
part of the tamper-evident chain and cannot be edited after the fact.

**Nothing about verification changes.** The hashed body is still exactly `{seq, ts, type, payload}`,
so chains written before this release verify unchanged, and a file mixing old and new entries
verifies end to end. There is no new format version and no migration.

Why it matters: Cendor never upgrades you automatically, partly so your evidence stays reproducible.
Evidence that could not name what produced it undercut that.

Two honest limits, both documented: it is self-reported provenance inside a tamper-evident chain, not
proof of origin — a forged file can claim anything from the outset. And because a resume writes no
second `audit_open`, a file names the version that **opened** it, not every version that appended to
it. If the version cannot be read (a bundler that can't resolve the manifest, say), `producer` is
**omitted rather than guessed**.

`producer` deliberately differs from Python's (`cendor-acttrace/<version>`) — separate packages,
independent version lines. Only `format` is identical across the two ports, and cross-language
verification is unaffected: each side verifies the bytes actually in the file. The committed
conformance vector was regenerated and a pre-provenance vector is now kept permanently as a
backward-compatibility guard.
