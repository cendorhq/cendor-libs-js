import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Absolute path to a committed cross-language fixture under the repo-root `fixtures/` dir. */
export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url));
}

/** Load a committed fixture as parsed JSON (for string-only fixtures: manifest, redaction). */
export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFixture(name)) as T;
}

/** Raw UTF-8 text of a committed fixture (parse with parsePreserving where int/float matters). */
export function readFixture(name: string): string {
  return readFileSync(fixturePath(name), 'utf-8');
}
