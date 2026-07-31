/**
 * `@cendor/tokenguard/sinks` must be importable WITHOUT the optional native `better-sqlite3`.
 *
 * `better-sqlite3` is an `optionalDependency`, which means npm SKIPS it silently when it cannot be
 * installed and the overall install still succeeds. A **value** import of it at module scope
 * therefore makes the whole subpath unimportable in that (common) case — taking `QueueSink` and
 * `OTelSink`, neither of which touches SQLite, down with it.
 *
 * Measured 2026-07-31 while writing the cookbook's `libs/tokenguard-durable-spend` recipe, on a
 * clean `node:20-slim` container (linux-x64):
 *
 *   prebuild-install warn install No prebuilt binaries found
 *     (target=20.20.2 runtime=node arch=x64 libc= platform=linux)
 *   gyp ERR! find Python  Could not find any Python installation to use
 *   ...
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'better-sqlite3'
 *     imported from …/node_modules/@cendor/tokenguard/dist/sinks.js
 *
 * The same install succeeds on `node:22-slim` (a prebuild exists there), so the failure is
 * Node-version dependent — green on 22, red on 20, which is exactly the shape the node 20 + 22
 * matrix exists to catch.
 *
 * `@cendor/squeeze`'s `store.ts` already loaded the same package lazily (`import type` +
 * `createRequire` inside the constructor); this module did not. The test is a SOURCE assertion
 * because that is the only way to catch a regression without uninstalling a dependency mid-suite:
 * a value import is a syntactic property, so check the syntax.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { QueueSink } from '../src/sinks.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sinks.ts');

/** Top-level `import … from '<pkg>'` statements that are NOT `import type`. */
function eagerImports(source: string): string[] {
  const out: string[] = [];
  for (const line of source.split('\n')) {
    const m = /^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/.exec(line.trim());
    if (m) out.push(m[1]);
  }
  return out;
}

describe('sinks: the optional native dependency is loaded lazily', () => {
  const source = readFileSync(SRC, 'utf8');

  it('does not import better-sqlite3 eagerly at module scope', () => {
    expect(eagerImports(source)).not.toContain('better-sqlite3');
  });

  it('still imports it for TYPES only, so SQLiteSink stays fully typed', () => {
    expect(source).toMatch(/^import type BetterSqlite3 from 'better-sqlite3';$/m);
  });

  it('loads it inside SQLiteSink, not at import time', () => {
    expect(source).toMatch(/require\('better-sqlite3'\)/);
  });

  it('the eager-import detector actually detects one (negative control)', () => {
    expect(eagerImports("import Database from 'better-sqlite3';")).toContain('better-sqlite3');
    expect(eagerImports("import type Database from 'better-sqlite3';")).not.toContain(
      'better-sqlite3',
    );
  });

  it('QueueSink works with no SQLite anywhere in sight', async () => {
    const written: unknown[] = [];
    const sink = new QueueSink({
      write: (entry: unknown) => {
        written.push(entry);
      },
    });
    await sink.write({ usd: '0.01', model: 'gpt-4o' });
    await sink.flush();
    await sink.close();
    expect(written).toHaveLength(1);
  });
});
