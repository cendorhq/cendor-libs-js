---
'@cendor/core': minor
'@cendor/acttrace': minor
---

**Governance is now visible as ordinary telemetry — with no audit object and no `audit.*` vocabulary.**

Until now the only way a budget block or a guardrail verdict reached your backend was the *audit
mirror*, so seeing enforcement meant adopting the evidence library. Under the telemetry switch, the
libraries that **make** those decisions now emit them as plain monitoring spans:

| Span | Scope | Attributes |
|---|---|---|
| `governance.budget_event` | `cendor.core` (or `cendor.sdk` inside a run) | `cendor.gov.type/action/budget/scope/model/to_model/projected_usd/cap_usd/projected_tokens/cap_tokens` + `cendor.trace_id` |
| `governance.guardrail_decision` | same | `cendor.gov.type/guardrail/stage/action/agent/tool` + `cendor.trace_id` |

- **The mirror always wins.** `@cendor/acttrace` tells core when an `AuditLog` attaches a mirror that
  emits spans (refcounted, released on `detach()`), and the `governance.*` renderings stand down while
  one is live — so an event never renders twice, and the chained `audit.*` spans stay the richer view.
  A *custom* mirror that writes elsewhere (a SIEM sink) deliberately does **not** suppress them.
- **Rule 6 holds by construction:** no `audit.*` span name, no `cendor.audit.*` attribute, nothing
  evidence-shaped. "Audit" keeps meaning the hash-chained file that `verify()` checks.
- **No `reason` string is emitted.** A guardrail's reason is written by the rule — and by a judge
  *model* for `rules.llmJudge`, which can paraphrase the payload; the URL rules embed the matched host.
  The audit chain (an artifact you declared) keeps carrying it; these default-on spans do not. A test
  pins that no payload marker can reach any `cendor.gov.*` attribute.
- `CENDOR_TELEMETRY=off` disables these like everything else; new in core's `otel`:
  `governanceMirrored()` / `governanceMirrorActive()`.
