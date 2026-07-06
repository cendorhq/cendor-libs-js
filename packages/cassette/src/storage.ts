/**
 * Pluggable cassette storage. Core cassette logic talks to the {@link CassetteStorage} interface
 * only; the fs adapter lazily requires `node:fs`/`node:path` (via `createRequire`) so importing the
 * package never forces Node built-ins into a browser bundle. A browser could implement an
 * IndexedDB-backed `CassetteStorage` (its job — testing — is mostly a Node concern, so fs + memory
 * are the shipped adapters).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** A cassette file backend: read the whole cassette, write it, and test existence. */
export interface CassetteStorage {
  read(): string | null;
  write(text: string): void;
  exists(): boolean;
}

/** In-memory cassette storage (browser/tests). Pass the same instance to record then replay. */
export function memoryStorage(initial: string | null = null): CassetteStorage {
  let buffer = initial;
  return {
    read: () => buffer,
    write: (text: string) => {
      buffer = text;
    },
    exists: () => buffer !== null,
  };
}

interface NodeFs {
  readFileSync(path: string, enc: string): string;
  writeFileSync(path: string, data: string, enc: string): void;
  existsSync(path: string): boolean;
  mkdirSync(path: string, opts: { recursive: boolean }): void;
}
interface NodePath {
  dirname(p: string): string;
}

let fs: NodeFs | undefined;
let pathMod: NodePath | undefined;
function nodeFs(): NodeFs {
  if (fs === undefined) fs = require('node:fs') as NodeFs;
  return fs;
}
function nodePath(): NodePath {
  if (pathMod === undefined) pathMod = require('node:path') as NodePath;
  return pathMod;
}

/** Filesystem-backed cassette storage (the Node default). */
export function fsStorage(path: string): CassetteStorage {
  return {
    read: () => (nodeFs().existsSync(path) ? nodeFs().readFileSync(path, 'utf8') : null),
    write: (text: string) => {
      const dir = nodePath().dirname(path);
      nodeFs().mkdirSync(dir, { recursive: true });
      nodeFs().writeFileSync(path, text, 'utf8');
    },
    exists: () => nodeFs().existsSync(path),
  };
}

/** Resolve a path string to fs storage, or pass a storage object through unchanged. */
export function resolveStorage(target: string | CassetteStorage): CassetteStorage {
  return typeof target === 'string' ? fsStorage(target) : target;
}
