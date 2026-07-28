# Security Policy

We take the security of the Cendor projects seriously. Thank you for helping keep them and their
users safe.

This policy covers **`cendor-libs-js`** — the `@cendor/*` TypeScript packages published on npm
(`core`, `contextkit`, `squeeze`, `tokenguard`, `guardrails`, `cassette`, `acttrace`, and the
`@cendor/libs` umbrella).

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities privately through **GitHub Private Vulnerability Reporting**:
[open a report](https://github.com/cendorhq/cendor-libs-js/security/advisories/new) from this
repository's **Security** tab → **Report a vulnerability**. This creates a private advisory only the
maintainers can see, and lets us collaborate on a fix and coordinate disclosure with you.

If Private Vulnerability Reporting is not enabled, open a **draft security advisory** on any Cendor
repository under [`cendorhq`](https://github.com/cendorhq) and we will route it.

Please include, where you can:

- the affected package(s) and version(s),
- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- any known mitigations.

## Scope

These are **local-first libraries** — they run in your process, with no Cendor-operated servers or
network services. That shapes the threat model: there is no hosted endpoint to attack. Relevant
classes of issues include, for example:

- redaction bypasses in `@cendor/acttrace`, or audit-chain verification flaws (a mutation that still
  passes `verify()`),
- incorrect budget enforcement in `@cendor/tokenguard` (a call that should have been blocked),
- a `@cendor/guardrails` rule that can be evaded by crafted input at a stage it claims to gate,
- unsafe deserialization of a cassette, a squeeze handle, or a policy document,
- leakage of prompt/response content into a surface documented as metadata-only (span attributes, the
  audit mirror, a `CompressionEvent`).

`@cendor/acttrace` produces **evidence to support** a compliance case — it is not a compliance
guarantee.

**Out of scope:** vulnerabilities in a provider SDK or another third-party dependency (report those
upstream; tell us if our usage makes an upstream issue exploitable), and findings that require an
attacker to already control the process running the library.

## What to expect

- We aim to acknowledge a report within a few business days.
- We'll work with you on a fix and a coordinated disclosure timeline, and credit you in the advisory
  unless you prefer to remain anonymous.

## Supported versions

Fixes land on the latest released minor of each affected package. All `@cendor/*` libraries share one
major version (see the [parity matrix](https://cendor.ai/docs/languages)), so upgrade the set
together. Because versions are **independent across languages**, a fix may ship on different version
numbers in Python (`cendor-*` on PyPI) and TypeScript (`@cendor/*` on npm).
