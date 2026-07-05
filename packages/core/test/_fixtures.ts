import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Load a committed cross-language conformance fixture from the repo-root `fixtures/` directory. */
export function loadFixture<T = unknown>(name: string): T {
  const url = new URL(`../../../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf-8')) as T;
}
