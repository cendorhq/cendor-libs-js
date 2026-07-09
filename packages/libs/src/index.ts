/**
 * `@cendor/libs` — the umbrella meta-package. Installing it pulls all seven Cendor libraries;
 * importing it re-exports each as a namespace for one-import convenience. The TS mirror of the
 * `cendor-libs` meta-package. À la carte install of an individual `@cendor/<x>` remains the norm;
 * this is the "give me everything" convenience.
 */
export * as core from '@cendor/core';
export * as tokenguard from '@cendor/tokenguard';
export * as contextkit from '@cendor/contextkit';
export * as squeeze from '@cendor/squeeze';
export * as guardrails from '@cendor/guardrails';
export * as cassette from '@cendor/cassette';
export * as acttrace from '@cendor/acttrace';
