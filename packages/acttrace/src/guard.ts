/**
 * `guard()` — a batteries-included enforcement callable for `@cendor/core`'s interceptor seam. The
 * TS port of `cendor.acttrace.guard`.
 *
 * The recorder/enforcer split stays intact: acttrace still only *records*. `guard()` returns a plain
 * callable you install via `addInterceptor` — it is core that stops the call. Per call, the active
 * {@link Policy} resolves each detected category to an action:
 *
 * - **block** → record `policy_flag(action="blocked")` → **throw** (the call never runs).
 * - **redact** → scrub the outbound messages via `Reroute(messages=…)` so the *provider* receives
 *   cleaned content, record `action="redacted"` → proceed. Tools have no message-rewrite seam, so a
 *   redact on tool arguments stays record-only.
 * - **flag** → record `policy_flag(action="flagged")` → proceed.
 * - nothing → proceed untouched.
 */

import { LLMCall, MISS, type Miss, Reroute, ToolCall } from '@cendor/core';
import { scrub } from './detectors.js';
import type { AuditLog } from './index.js';
import { type Finding, Policy, scan } from './policy.js';

/** Severity ordering, so a grouped flag carries the strongest severity in the group. */
const SEVERITY_RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 };

/**
 * Raised by a {@link guard} to block an outbound call whose content a policy forbids. Carries the
 * offending {@link Finding} list on `findings` (categories and counts only — never raw values).
 */
export class PolicyViolation extends Error {
  findings: Finding[];
  constructor(message = 'policy violation', findings: Finding[] | null = null) {
    super(message);
    this.name = 'PolicyViolation';
    this.findings = findings ?? [];
  }
}

/** An exception class (called with a message) or a factory `findings -> Error`. */
export type OnBlock = (new (message: string) => Error) | ((findings: Finding[]) => Error);

/** The caller-supplied content of a call to scan (messages for LLMs, arguments for tools). */
function content(call: unknown): unknown {
  if (call instanceof LLMCall) return call.messages;
  if (call instanceof ToolCall) return call.arguments;
  return null;
}

function maxSeverity(findings: Finding[]): string {
  let best = 'warning';
  let bestRank = -1;
  for (const f of findings) {
    const rank = SEVERITY_RANK[f.severity] ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = f.severity;
    }
  }
  return best;
}

/** ES6-class detection: distinguishes an exception class from a `findings -> Error` factory. */
function isClass(fn: OnBlock): fn is new (message: string) => Error {
  return typeof fn === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(fn));
}

function makeBlockException(onBlock: OnBlock, findings: Finding[]): Error {
  const cats = [...new Set(findings.map((f) => f.category))].sort();
  const message = `policy blocked outbound call: ${cats.join(', ')}`;
  if (isClass(onBlock)) {
    const exc = new onBlock(message);
    try {
      (exc as { findings?: Finding[] }).findings = findings;
    } catch {
      // exception type doesn't tolerate a findings attribute — ignore
    }
    return exc;
  }
  return onBlock(findings);
}

/**
 * Return a pre-call interceptor that enforces `policy` and records refusals via `audit`. Install it
 * on core's seam via `addInterceptor(guard(Policy.gdpr(), log))`.
 *
 * Note that `Policy.default()` never blocks — use `Policy.gdpr()` / `pci()` / `strict()` (or a custom
 * policy) to make a category `block`. `audit` is optional — without it the guard still enforces.
 */
export function guard(
  policy?: Policy | null,
  audit?: AuditLog | null,
  onBlock: OnBlock = PolicyViolation,
): (call: unknown) => unknown {
  const p = policy ?? Policy.default();
  const auditLog = audit ?? null;

  const record = (action: string, findings: Finding[], call: unknown, note = ''): void => {
    if (auditLog === null) return;
    const cats = [...new Set(findings.map((f) => f.category))].sort();
    const kind = call instanceof LLMCall ? 'llm_call' : 'tool_call';
    let reason = `${action} ${cats.join(', ')} in outbound ${kind}`;
    if (note) reason = `${reason} (${note})`;
    const severity = action === 'redacted' ? 'info' : maxSeverity(findings);
    auditLog.flag(reason, { action, severity, data: cats, extra: { auto: true } });
  };

  return (call: unknown): unknown => {
    const c = content(call);
    if (c === null) return MISS;
    const findings = scan(c, p);
    if (findings.length === 0) return MISS;
    const blocked = findings.filter((f) => f.action === 'block');
    const toRedact = findings.filter((f) => f.action === 'redact');
    const flagged = findings.filter((f) => f.action === 'flag');
    if (blocked.length > 0) {
      record('blocked', blocked, call); // record the refusal *before* throwing
      throw makeBlockException(onBlock, blocked);
    }
    if (flagged.length > 0) {
      record('flagged', flagged, call);
    }
    if (toRedact.length > 0) {
      if (call instanceof LLMCall) {
        // Redact-before-send: scrub the outbound messages and reroute so the provider receives the
        // cleaned content, then record that we did.
        const cleaned = scrub(call.messages, new Set(toRedact.map((f) => f.category)));
        record('redacted', toRedact, call);
        return new Reroute({ messages: cleaned });
      }
      // Tools have no message-rewrite seam, so a redact on tool arguments stays record-only.
      record(
        'flagged',
        toRedact,
        call,
        'redact-before-send applies to model calls; tool arguments unchanged',
      );
    }
    return MISS as Miss;
  };
}
