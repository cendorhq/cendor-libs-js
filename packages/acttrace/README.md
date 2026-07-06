# @cendor/acttrace

A tamper-evident, auto-populated audit log for AI decisions. The TypeScript port of
`cendor.acttrace` (regex/pattern detectors only — no Presidio).

Construct an `AuditLog` and it **subscribes** to `@cendor/core`'s event bus: every instrumented
model/tool call becomes a hash-chained audit entry with zero per-call wiring. You add only the
explicit human-facing events (`decision`, `humanOversight`). Integrity comes from a hash chain, not a
server: `entry.hash = sha256(prev_hash + canonical(entry))`, so editing any past entry breaks every
entry after it — and `verify()` re-walks the chain offline.

**Byte-conformant with Python:** a chain written by JS verifies in Python and vice-versa. The hashed
canonical bytes and HMAC inputs are identical across languages (snake_case wire keys, int/float
preserved, `prev_hash` text-prepended, `GENESIS` = 64 zeros).

## Killer example

```ts
import { instrument } from '@cendor/core';
import { AuditLog, verify } from '@cendor/acttrace';

const log = new AuditLog('loan_triage', { riskTier: 'high', path: 'audit.jsonl' });
const client = instrument(openai); // one seam; acttrace rides the bus

await log.decision(
  async (d) => {
    // this call is auto-captured as an `llm_call` entry, tagged to the decision
    await client.chat.completions.create({ model: 'gpt-4o', messages });
    d.record({ model: 'gpt-4o', prompt_id: 'triage@v3' });
    d.humanOversight('ops@bank', 'approved', 'manual check');
  },
  { input: { amount: 5000 } }, // PII in inputs is auto-redacted + flagged before hashing
);

log.export('evidence.jsonl', 'eu_ai_act'); // annotate with control IDs + a signed-completeness header
log.detach();

const [ok, detail] = verify('audit.jsonl'); // re-walk offline; catches any edit / reorder / truncation
```

## Surface

| Symbol | What it does |
| --- | --- |
| `new AuditLog(system, opts?)` | Hash-chained, auto-populating log. `opts`: `riskTier`, `path`, `signingKey`, `redact`, `redactor`, `flagOnRedact`, `policy`, `maxEntries`. Auto-subscribes to the bus. |
| `log.decision(cb, { input?, actor? })` | Async-scoped decision span (`AsyncLocalStorage`); auto-captured calls inside `cb` are tagged. |
| `d.record(fields)` / `d.humanOversight(reviewer, action, note?)` / `d.flag(reason, opts?)` | Explicit decision events. |
| `log.flag(reason, { action?, severity?, data?, extra? })` | Record a `policy_flag` (action/severity lowercased). |
| `log.export(path, framework?)` | JSONL evidence pack + `_meta` header (control mapping, summary, signed completeness). |
| `log.head` / `log.evictedFromMemory` / `log.detach()` | Chain head, ring-eviction count, unsubscribe + close. |
| `verify(path, { key?, expectedHead?, expectEntries? })` | `[ok, detail]`. Never throws. Detects tamper / bad-sig / reorder / truncation. |
| `frameworks()` | `['eu_ai_act', 'gdpr', 'iso_42001', 'nist_rmf']`. |
| `scan(obj, policy?)` / `redact(obj, policy?)` | Pure detection (counts only) / scrub. `Policy.default/gdpr/pci/strict`. |
| `guard(policy?, audit?, onBlock?)` | Interceptor for `addInterceptor`: block (throw) / redact-before-send (`Reroute`) / flag. `PolicyViolation.findings`. |
| `DETECTORS`, `registerDetector`, `detectors`, `Detector` | The 20-detector registry (validators: Luhn / IBAN mod-97 / Verhoeff / ABA / SSN / phone / BIC). |
| `enableLocalePack('uk'\|'in')`, `enableEntropyDetector()`, `LOCALE_PACKS` | Opt-in packs (off by default). |
| `nerAvailable()` / `nerRedactor()` | Regex-only port: returns `false` / throws (no Presidio in JS). |
| `chainHash`, `metaSignature`, `GENESIS`, `AuditEntry`, `BoundedMemoryWithoutPathWarning` | Low-level conformance primitives + types. |

Wire the guard in one line:

```ts
import { addInterceptor } from '@cendor/core';
import { AuditLog, Policy, guard } from '@cendor/acttrace';

const log = new AuditLog('support_bot', { riskTier: 'high' });
addInterceptor(guard(Policy.gdpr(), log)); // enforce + record; recorder and enforcer stay separate
```

## Parity note

Python `snake_case` kwargs become a trailing options object; string-literal values are unchanged
(`action: 'blocked'`, `evict semantics`, framework ids). Python context managers (`with
log.decision(...) as d:`) become the async-callback form `await log.decision(async (d) => …, opts)`,
scoped with `node:async_hooks` `AsyncLocalStorage`. Class/type/error names are byte-identical
(`AuditLog`, `AuditEntry`, `Policy`, `Finding`, `Detector`, `PolicyViolation`, `verify`). Hashing is
synchronous via `node:crypto`; storage (fs/memory) and crypto are lazily required so importing the
package never forces Node built-ins into a browser bundle. NER is intentionally absent — the JS port
ships the regex/pattern detectors only.
