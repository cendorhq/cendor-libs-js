/**
 * Config-as-data: loadPolicy builds guardrails from a JSON/object document and stamps every decision
 * with the policy hash + version. No network. The TS port of tests/test_policy.py.
 */
import { bus } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GuardrailDecision, GuardrailTripped } from '../src/decision.js';
import { apply, evaluate, loadPolicy } from '../src/index.js';

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

const DOC = {
  version: '2026-07-09',
  guardrails: [
    { rule: 'keyword_deny', args: { words: ['forbidden'] }, stage: 'input', action: 'block' },
    {
      rule: 'regex_rule',
      args: { pattern: '\\d{3}-\\d{2}-\\d{4}' },
      action: 'redact',
      stage: 'input',
    },
    { rule: 'length_bounds', args: { max_chars: 20 }, stage: 'input', action: 'flag' },
  ],
};

function collectDecisions(): GuardrailDecision[] {
  const out: GuardrailDecision[] = [];
  bus.subscribe((e: unknown) => {
    if (e instanceof GuardrailDecision) out.push(e);
  });
  return out;
}

describe('loadPolicy', () => {
  it('builds guardrails from an object with provenance', () => {
    const policy = loadPolicy(DOC);
    expect(policy.length).toBe(3);
    expect(policy.policyVersion).toBe('2026-07-09');
    expect(policy.policyHash.startsWith('sha256:')).toBe(true);
  });

  it('the result is usable as a guardrail list', () => {
    expect(() => apply(loadPolicy(DOC), 'input', 'this is forbidden')).toThrow(GuardrailTripped);
  });

  it('stamps policy_hash + policy_version on every decision', () => {
    const decisions = collectDecisions();
    const policy = loadPolicy(DOC);
    apply(policy, 'input', 'x'.repeat(40)); // trips length_bounds (flag → continues)
    const d = decisions.at(-1);
    expect(d?.metadata.policy_hash).toBe(policy.policyHash);
    expect(d?.metadata.policy_version).toBe('2026-07-09');
  });

  it('the hash is content-addressed (order-independent; changes with content)', () => {
    const reordered = { guardrails: DOC.guardrails, version: DOC.version };
    expect(loadPolicy(DOC).policyHash).toBe(loadPolicy(reordered).policyHash);
    const changed = JSON.parse(JSON.stringify(DOC));
    changed.guardrails[0].args.words = ['other'];
    expect(loadPolicy(changed).policyHash).not.toBe(loadPolicy(DOC).policyHash);
  });

  it('parses JSON text and a BYO parser', () => {
    const fromJson = loadPolicy(JSON.stringify(DOC));
    expect(fromJson.length).toBe(3);
    // a BYO parser (here: JSON, standing in for YAML.parse) is honoured
    const fromParser = loadPolicy('anything', { parse: () => DOC });
    expect(fromParser.policyVersion).toBe('2026-07-09');
  });

  it('applies a redact rule from the policy', () => {
    const { payload, decisions } = evaluate(loadPolicy(DOC), 'input', 'my ssn is 123-45-6789');
    expect(String(payload)).toContain('[redacted]');
    expect(decisions.some((d) => d.action === 'redact')).toBe(true);
  });

  it('rejects an unknown/non-declarative rule', () => {
    expect(() => loadPolicy({ guardrails: [{ rule: 'llm_judge' }] })).toThrow(
      /unknown or non-declarative/,
    );
  });

  it('rejects a missing guardrails array', () => {
    expect(() => loadPolicy({ version: '1' })).toThrow(/guardrails/);
  });

  it('wraps bad rule args with the index', () => {
    expect(() => loadPolicy({ guardrails: [{ rule: 'length_bounds', args: {} }] })).toThrow(
      /bad arguments/,
    );
  });
});

// Prove the bundled (dependency-free, all-runtime) SHA-256 is a REAL SHA-256 by matching Node's
// crypto over the exact canonical document loadPolicy hashes. (The test may use node:crypto; the
// library must not — hence the hand-rolled impl.)
import { createHash } from 'node:crypto';

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

describe('policy hash = real SHA-256', () => {
  it("matches Node's SHA-256 over the canonical document", () => {
    for (const doc of [{ guardrails: [] }, DOC]) {
      const expected = createHash('sha256').update(canonical(doc), 'utf8').digest('hex');
      expect(loadPolicy(doc).policyHash).toBe(`sha256:${expected}`);
    }
  });
});
