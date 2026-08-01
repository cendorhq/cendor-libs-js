#!/usr/bin/env node
/**
 * Regenerate `packages/core/src/prices-snapshot.ts` from the Python `cendor-core` snapshot.
 *
 *     node scripts/sync-prices.mjs           # regenerate
 *     node scripts/sync-prices.mjs --check   # fail if it is stale, write nothing
 *
 * ⚠️ **The source is the sibling Python file, not the feed.** `cendor-libs` runs
 * `scripts/sync_prices.py` against `cendorhq/cendor-prices` and applies the curation policy; this
 * script embeds that result VERBATIM, so the two languages physically cannot ship different rates.
 * Going to the feed twice would let one regeneration land a day apart from the other and silently
 * split the parity fixtures.
 *
 * Run order: `cendor-libs` sync_prices.py -> this -> `pnpm fixtures` (the cross-language
 * conformance fixtures read the Python snapshot too).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PY_SNAPSHOT = resolve(
  ROOT,
  '../cendor-libs/packages/cendor-core/src/cendor/core/prices.json',
);
const TS_SNAPSHOT = resolve(ROOT, 'packages/core/src/prices-snapshot.ts');

const HEADER = `/**
 * The bundled offline price snapshot, embedded verbatim from the Python \`cendor-core\`
 * \`prices.json\` so cost estimation works with zero network and zero filesystem access
 * (edge/browser-safe). Parsed through {@link parseDecimalJson} so rates stay exact \`Decimal\`s.
 * Refresh a live table with \`prices.refresh(...)\`. Format is pinned by the price-dataset spec
 * (\`prices/1\`).
 *
 * GENERATED — do not hand-edit. \`node scripts/sync-prices.mjs\` regenerates it from the sibling
 * Python snapshot, which \`cendor-libs/scripts/sync_prices.py\` generates from the cendor-prices
 * feed. Editing this file by hand splits the two languages' rates.
 */
export const PRICES_JSON = \``;

function render(json) {
  // The JSON is embedded in a template literal, so a backtick or a `${` in it would break the file.
  // Neither occurs in a price table today; escape anyway rather than trust that it never will.
  const safe = json.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return `${HEADER}${safe.trimEnd()}\`;\n`;
}

/**
 * `--verify`: validate the COMMITTED `prices-snapshot.ts` on its own, with no sibling checkout.
 *
 * CI clones this repo alone, so `--check` (which diffs against the Python file) cannot run there
 * and the snapshot would reach every consumer having passed no gate at all in this repo. This
 * asserts the shape the library depends on: it parses, it is datable, and no model carries a zero
 * or missing input rate — the shape that makes `estimate()` report $0.00 as a fact and a USD cap
 * silently never bind.
 */
function verifyCommitted() {
  const ts = readFileSync(TS_SNAPSHOT, 'utf8');
  // Anchor on the assignment, not on the first backtick in the file: the JSDoc header quotes
  // `cendor-core` and several other identifiers, so `indexOf('`')` grabbed a comment and the gate
  // reported "embedded JSON does not parse" — a FALSE failure that would have read as a real one
  // to anyone checking only the exit code.
  const marker = 'export const PRICES_JSON = `';
  const at = ts.indexOf(marker);
  const start = at === -1 ? -1 : at + marker.length - 1;
  const end = ts.lastIndexOf('`');
  if (start === -1 || end <= start) {
    console.error(`prices-snapshot.ts: could not find ${marker.trim()}`);
    return 1;
  }
  // Undo `render()`'s escaping, in the reverse order it applied it. `String.fromCharCode(92)` is
  // a backslash written without one, so this stays readable next to the template-literal syntax.
  const BS = String.fromCharCode(92);
  const json = ts
    .slice(start + 1, end)
    .split(`${BS}\``)
    .join('`')
    .split(`${BS}\${`)
    .join('${')
    .split(BS + BS)
    .join(BS);
  let data;
  try {
    data = JSON.parse(json);
  } catch (e) {
    console.error(`prices-snapshot.ts: embedded JSON does not parse — ${e.message}`);
    return 1;
  }
  const problems = [];
  const rows = Object.keys(data.models ?? {}).length;
  if (rows < 100) problems.push(`only ${rows} rows — the generated snapshot should carry hundreds`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data._updated))) {
    problems.push(`_updated is "${data._updated}" — the snapshot must be datable`);
  }
  for (const [id, rates] of Object.entries(data.models ?? {})) {
    if (rates.input === undefined) problems.push(`${id} has no input rate`);
    else if (Number(rates.input) <= 0) problems.push(`${id} has a zero/negative input rate`);
  }
  console.log(`prices-snapshot.ts: ${rows} rows, _updated=${data._updated}`);
  if (problems.length) {
    for (const p of problems.slice(0, 10)) console.error(`  FAIL ${p}`);
    return 1;
  }
  console.log('prices-snapshot.ts: PASS');
  return 0;
}

if (process.argv.includes('--verify')) process.exit(verifyCommitted());

const py = readFileSync(PY_SNAPSHOT, 'utf8');
const next = render(py);
const check = process.argv.includes('--check');

if (check) {
  let current = '';
  try {
    current = readFileSync(TS_SNAPSHOT, 'utf8');
  } catch {
    /* missing counts as stale */
  }
  // Compare on content, not on bytes: a CRLF checkout must not read as drift.
  const norm = (s) => s.replace(/\r\n/g, '\n');
  if (norm(current) !== norm(next)) {
    console.error(
      'prices-snapshot.ts is STALE against the Python snapshot. Run `node scripts/sync-prices.mjs`.',
    );
    process.exit(1);
  }
  const rows = Object.keys(JSON.parse(py).models).length;
  console.log(`prices-snapshot.ts: in sync with the Python snapshot (${rows} rows)`);
  process.exit(0);
}

writeFileSync(TS_SNAPSHOT, next, 'utf8');
const parsed = JSON.parse(py);
console.log(
  `wrote packages/core/src/prices-snapshot.ts: ${Object.keys(parsed.models).length} rows, ` +
    `_updated=${parsed._updated}`,
);
console.log('next: `pnpm fixtures` to refresh the cross-language conformance fixtures');
