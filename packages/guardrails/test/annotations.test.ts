/**
 * A2 — annotation-parity evidence: the reserved GuardrailDecision.metadata keys (severity / detected
 * / filtered / redacted / citation / license). No shape change — a check attaches them via
 * Verdict.metadata and the engine merges them under Context.metadata (which still wins). Adapters
 * populate them from a vendor result. No network — fake clients. Mirrors Python
 * `tests/test_annotations.py`. docs/specs/bus-events.md "Reserved annotation keys".
 */
import { bus } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Context,
  GuardrailDecision,
  GuardrailTripped,
  Verdict,
  apply,
  applyAsync,
  defineGuardrail,
  evaluateAsync,
  rules,
} from '../src/index.js';

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

function collect(): GuardrailDecision[] {
  const out: GuardrailDecision[] = [];
  bus.subscribe((e) => {
    if (e instanceof GuardrailDecision) out.push(e);
  });
  return out;
}

describe('Verdict.metadata → decision.metadata', () => {
  it('a verdict annotation lands on the decision', () => {
    const decs = collect();
    const g = defineGuardrail(
      () => new Verdict('flag', 'risky', null, { severity: 'high', detected: true }),
      { stage: 'input' },
    );
    apply([g], 'input', 'text');
    expect(decs.at(-1)?.metadata).toEqual({ severity: 'high', detected: true });
  });

  it('context metadata wins over verdict metadata on a clash', () => {
    const decs = collect();
    const g = defineGuardrail(
      () => new Verdict('flag', 'x', null, { severity: 'low', detected: true }),
      { stage: 'input' },
    );
    const ctx: Context = { stage: 'input', metadata: { severity: 'high' } };
    apply([g], 'input', 'text', ctx);
    expect(decs.at(-1)?.metadata).toEqual({ severity: 'high', detected: true });
  });

  it('defaults to empty metadata when the verdict sets none', () => {
    const decs = collect();
    apply([defineGuardrail(() => new Verdict('flag', 'x'), { stage: 'input' })], 'input', 'text');
    expect(decs.at(-1)?.metadata).toEqual({});
  });

  it('static guardrail metadata (policy_hash) composes with a verdict annotation', () => {
    const decs = collect();
    const g = defineGuardrail(() => new Verdict('flag', 'x', null, { detected: true }), {
      stage: 'input',
      metadata: { policy_hash: 'sha256:abc' },
    });
    apply([g], 'input', 'text');
    expect(decs.at(-1)?.metadata).toEqual({ policy_hash: 'sha256:abc', detected: true });
  });
});

describe('adapters populate reserved keys', () => {
  const moderationClient = (flagged: boolean, categories: Record<string, boolean>) => ({
    moderations: { create: () => ({ results: [{ flagged, categories }] }) },
  });

  it('openaiModeration sets detected + filtered', async () => {
    const decs = collect();
    const client = moderationClient(true, { violence: true, hate: false });
    await expect(
      applyAsync([rules.openaiModeration(client, { action: 'block' })], 'input', 'text'),
    ).rejects.toBeInstanceOf(GuardrailTripped);
    expect(decs.at(-1)?.metadata.detected).toBe(true);
    expect(decs.at(-1)?.metadata.filtered).toBe(true);
  });

  it('openaiModeration flag action is annotate-only (filtered false)', async () => {
    const decs = collect();
    const client = moderationClient(true, { violence: true });
    await applyAsync([rules.openaiModeration(client, { action: 'flag' })], 'input', 'text');
    expect(decs.at(-1)?.metadata.detected).toBe(true);
    expect(decs.at(-1)?.metadata.filtered).toBe(false);
  });

  it('bedrockGuardrail intervened sets detected + filtered', async () => {
    const decs = collect();
    const client = {
      applyGuardrail: () => ({ action: 'GUARDRAIL_INTERVENED', actionReason: 'blocked topic' }),
    };
    await expect(
      applyAsync([rules.bedrockGuardrail(client, 'gr-1', { action: 'block' })], 'input', 'text'),
    ).rejects.toBeInstanceOf(GuardrailTripped);
    expect(decs.at(-1)?.metadata.detected).toBe(true);
    expect(decs.at(-1)?.metadata.filtered).toBe(true);
  });

  it('bedrockGuardrail redact sets redacted', async () => {
    const decs = collect();
    const client = {
      applyGuardrail: () => ({
        action: 'GUARDRAIL_INTERVENED',
        actionReason: 'pii',
        outputs: [{ text: 'masked ****' }],
      }),
    };
    const { payload } = await evaluateAsync(
      [rules.bedrockGuardrail(client, 'gr-1', { action: 'redact', stage: 'output' })],
      'output',
      'raw',
    );
    expect(payload).toBe('masked ****');
    expect(decs.at(-1)?.metadata.redacted).toBe(true);
  });

  it('azureContentSafety sets detected', async () => {
    const decs = collect();
    const client = { shieldPrompt: () => ({ userPromptAnalysis: { attackDetected: true } }) };
    await expect(
      applyAsync([rules.azureContentSafety(client, { action: 'block' })], 'input', 'attack'),
    ).rejects.toBeInstanceOf(GuardrailTripped);
    expect(decs.at(-1)?.metadata.detected).toBe(true);
  });

  it('modelArmor sets detected', async () => {
    const decs = collect();
    const resp = {
      sanitizationResult: {
        filterMatchState: 'MATCH_FOUND',
        filterResults: { pi_and_jailbreak: { matchState: 'MATCH_FOUND' } },
      },
    };
    const client = { sanitizeUserPrompt: () => resp, sanitizeModelResponse: () => resp };
    await expect(
      applyAsync([rules.modelArmor(client, 'projects/p/locations/l/templates/t')], 'input', 'x'),
    ).rejects.toBeInstanceOf(GuardrailTripped);
    expect(decs.at(-1)?.metadata.detected).toBe(true);
  });
});
