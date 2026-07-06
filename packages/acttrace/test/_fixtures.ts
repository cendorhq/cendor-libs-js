import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type PyValue, parsePreserving } from '../src/pyjson.js';

/** Absolute path to a committed cross-language fixture under the repo-root `fixtures/` directory. */
export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url));
}

/** Load + JSON.parse a fixture (fine when int/float distinctions do not matter). */
export function loadJson<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(fixturePath(name), 'utf-8')) as T;
}

/** Load a fixture with the number-preserving parser (bigint ints, PyFloat floats). */
export function loadPreserved(name: string): PyValue {
  return parsePreserving(readFileSync(fixturePath(name), 'utf-8'));
}

/** Raw UTF-8 bytes of a fixture. */
export function loadText(name: string): string {
  return readFileSync(fixturePath(name), 'utf-8');
}
