/**
 * Smoke test for the `@cendor/libs` umbrella: it must re-export all seven Cendor libraries as
 * namespaces, each carrying at least one known public symbol. This is the only guard that a member
 * rename or a dropped `export * as` line would otherwise ship silently (the package has no code of
 * its own — see the report's M3 "umbrella: zero tests").
 */
import { describe, expect, it } from 'vitest';
import * as libs from '../src/index.js';

// One stable sentinel export per library — proof the namespace resolved to the real module.
const NAMESPACES: Array<[keyof typeof libs, string]> = [
  ['core', 'instrument'],
  ['tokenguard', 'budget'],
  ['contextkit', 'Context'],
  ['squeeze', 'compress'],
  ['guardrails', 'evaluate'],
  ['cassette', 'use'],
  ['acttrace', 'AuditLog'],
];

describe('@cendor/libs umbrella', () => {
  it('re-exports exactly the seven libraries', () => {
    expect(Object.keys(libs).sort()).toEqual(
      ['acttrace', 'cassette', 'contextkit', 'core', 'guardrails', 'squeeze', 'tokenguard'].sort(),
    );
  });

  for (const [ns, sentinel] of NAMESPACES) {
    it(`${String(ns)} is a namespace exposing \`${sentinel}\``, () => {
      const mod = libs[ns] as Record<string, unknown>;
      expect(mod).toBeTypeOf('object');
      expect(mod[sentinel]).toBeDefined();
    });
  }
});
