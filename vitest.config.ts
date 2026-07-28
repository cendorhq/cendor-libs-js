import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // Measured 2026-07-28: with the default 5000ms, a parallel run failed 1–15 files with
    // `Test timed out in 5000ms` and ZERO assertion failures — a different set every run, and it
    // reproduced on a pristine checkout, so it is worker contention on cold module imports (the
    // suite reports `import 183s` parallel vs `27s` serial), not a hanging test. Serial runs are
    // 899/899 green.
    //
    // This became load-bearing when `release.yml` gained a `verify` job: a flaky test now blocks a
    // publish. The timeout is the wrong knob to leave at a default that the import cost alone can
    // exhaust — no test here legitimately needs seconds of wall clock, so a generous ceiling
    // removes the false failure without hiding a real hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.d.ts'],
    },
  },
});
