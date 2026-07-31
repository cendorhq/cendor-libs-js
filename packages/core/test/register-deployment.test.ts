/**
 * S4 — `prices.registerDeployment(name, { like })`: price an Azure/Foundry deployment name.
 *
 * THE GAP (recorded verbatim by the external black-box suite as "would improve DX"): on Azure the id a
 * call reports is the **deployment name the user chose**, not a model id. It is therefore in no price
 * table, `LLMCall.cost` is `null`, tokenguard records `$0`, and a USD budget silently never binds.
 *
 * This is an EXPLICIT mapping, and that distinction is load-bearing: automatic `-preview` / `-latest`
 * alias guessing was considered and REJECTED (a confidently wrong price is worse than an honest
 * `null`). Nothing here is inferred from the deployment's name.
 */
import { describe, expect, it } from 'vitest';
import {
  UnknownModelError,
  _reset,
  estimate,
  register,
  registerDeployment,
} from '../src/prices.js';

function fresh(): void {
  _reset();
}

describe('@cendor/core — prices.registerDeployment (S4)', () => {
  it('prices a deployment like its base model', () => {
    fresh();
    registerDeployment('prod-gpt4o-eastus', { like: 'gpt-4o' });
    const direct = estimate('gpt-4o', 1000, { outputTokens: 500 });
    const viaDeployment = estimate('prod-gpt4o-eastus', 1000, { outputTokens: 500 });
    expect(viaDeployment.amount.toString()).toBe(direct.amount.toString());
    expect(viaDeployment.amount.greaterThan(0)).toBe(true);
  });

  it('returns the stored per-token rates', () => {
    fresh();
    const rates = registerDeployment('dep', { like: 'gpt-4o' });
    expect(rates.input.greaterThan(0)).toBe(true);
    expect(
      Object.keys(rates).every((k) => ['input', 'output', 'cached', 'cache_write'].includes(k)),
    ).toBe(true);
  });

  it('returns a copy — mutating it does not change the table', () => {
    fresh();
    const rates = registerDeployment('dep', { like: 'gpt-4o' });
    const before = estimate('dep', 1000, { outputTokens: 0 }).amount.toString();
    rates.input = rates.input.plus(999);
    expect(estimate('dep', 1000, { outputTokens: 0 }).amount.toString()).toBe(before);
  });

  // --- NEGATIVE CONTROL: an unknown base must THROW, never register a silent nothing. ---
  it('throws on an unknown base model instead of registering nothing', () => {
    fresh();
    expect(() => registerDeployment('dep', { like: 'not-a-real-model-anywhere' })).toThrow(
      UnknownModelError,
    );
    expect(() => estimate('dep', 1000)).toThrow(UnknownModelError); // nothing half-registered
  });

  it('cannot even be handed an inputless base here — TS register() rejects one first', () => {
    // The `input === undefined` guard inside registerDeployment is defensive-only in TypeScript:
    // `register()` runs every rate through `new Dec(...)`, so an entry with no `input` throws on the
    // way IN and can never reach the table. Python's `register()` stores the dict verbatim, so the
    // state IS reachable there and its twin (test_register_deployment.py) asserts the guard. Pinning
    // the asymmetry rather than writing a test that only appears to cover it.
    fresh();
    expect(() =>
      register('output-only', { input: undefined as never, output: '0.00001' }),
    ).toThrow();
    expect(() => estimate('output-only', 1000)).toThrow(UnknownModelError);
  });

  it('copies the base rates rather than re-deriving a subset', () => {
    fresh();
    register('rich-base', { input: '0.000001', output: '0.000002', cached: '0.0000005' });
    const rates = registerDeployment('dep', { like: 'rich-base' });
    // Compare numerically — decimal.js switches to exponent notation ('5e-7') below 1e-6.
    expect(rates.input.equals('0.000001')).toBe(true);
    expect(rates.output?.equals('0.000002')).toBe(true);
    expect(rates.cached?.equals('0.0000005')).toBe(true);
    // The spread copies whatever keys the entry has, so a future rate category rides along. The
    // Python twin proves that with a key neither language knows (`some_future_rate`), which this
    // typed surface cannot express.
  });

  // --- NEGATIVE CONTROL: nothing is inferred from the NAME. ---
  it('leaves a model-ish deployment name unpriced until it is registered', () => {
    fresh();
    expect(() => estimate('gpt-4o-my-company-preview', 1000)).toThrow(UnknownModelError);
  });

  it('accepts a dated or decorated base id for `like`', () => {
    fresh();
    registerDeployment('dep-dated', { like: 'gpt-4o-2024-08-06' });
    expect(estimate('dep-dated', 1000, { outputTokens: 500 }).amount.toString()).toBe(
      estimate('gpt-4o', 1000, { outputTokens: 500 }).amount.toString(),
    );
  });

  // --- Copy-at-registration semantics, asserted rather than assumed. ---
  it('does not reprice an already-registered deployment when the base reprices', () => {
    fresh();
    registerDeployment('dep', { like: 'gpt-4o' });
    const atRegistration = estimate('dep', 1000, { outputTokens: 0 }).amount.toString();

    register('gpt-4o', { input: '999', output: '999' }); // base reprices

    expect(estimate('dep', 1000, { outputTokens: 0 }).amount.toString()).toBe(atRegistration);
    expect(estimate('gpt-4o', 1000, { outputTokens: 0 }).amount.toString()).not.toBe(
      atRegistration,
    );
    // Re-registering is how you opt in to the new rates.
    registerDeployment('dep', { like: 'gpt-4o' });
    expect(estimate('dep', 1000, { outputTokens: 0 }).amount.toString()).toBe(
      estimate('gpt-4o', 1000, { outputTokens: 0 }).amount.toString(),
    );
  });

  it('overrides a snapshot entry with the same id, like register()', () => {
    fresh();
    registerDeployment('gpt-4o-mini', { like: 'gpt-4o' });
    expect(estimate('gpt-4o-mini', 1000, { outputTokens: 500 }).amount.toString()).toBe(
      estimate('gpt-4o', 1000, { outputTokens: 500 }).amount.toString(),
    );
  });
});
