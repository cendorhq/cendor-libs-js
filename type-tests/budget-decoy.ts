// Type-level regression test for the Type Teach "teeth" (see docs/for-ai-assistants.md).
//
// `budget` is CURRIED: `budget(cfg)(fn)`. A decoy overload types the two-argument shape
// `budget(cfg, fn)` as `never` so the common wrong guess is a compile error whose message points at
// the fix. This file pins that: if a refactor drops the decoy, the `@ts-expect-error` below turns
// into an "unused directive" error and CI fails — the trap can't silently re-open.
//
// Checked by `pnpm check:types` (a `tsc --noEmit` pass over type-tests/). It imports the built
// dist directly (the shape a consumer of `@cendor/tokenguard` gets), so it exercises the real
// decoy overload — run `pnpm build` first.
import { budget, withBudget } from '../packages/tokenguard/dist/index.js';

declare const fn: (q: string) => string;

/** The wrong shape must NOT typecheck. */
export function budgetDecoyMustError() {
  // @ts-expect-error `budget` is curried — write budget(cfg)(fn), not budget(cfg, fn).
  return budget({ usd: 1 }, fn);
}

/** The correct shapes must still typecheck. */
export function budgetCorrectShapes() {
  const decorated = budget({ usd: 1, onExceed: 'raise' })(fn);
  return { decorated, scoped: withBudget({ usd: 1 }, async () => 'ok') };
}
