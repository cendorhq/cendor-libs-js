/**
 * Pluggable acttrace chain storage. Core logic uses the {@link ChainStorage} interface; the fs
 * adapter lazily requires `node:fs` so importing the package never forces Node built-ins into a
 * bundle. acttrace is server-side (signing keys never belong in a browser), so fs + memory are the
 * shipped adapters; a Workers-KV/other backend can implement the same interface.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** A tamper-evident-chain backend: truncate-open, append durable lines, and re-read the full chain. */
export interface ChainStorage {
  appendLine(line: string): void;
  readLines(): string[];
  close(): void;
}

/** In-memory chain storage (browser/tests). */
export function memoryChainStorage(): ChainStorage {
  const lines: string[] = [];
  return {
    appendLine: (line: string) => {
      lines.push(line);
    },
    readLines: () => lines.map((l) => l.replace(/\n$/, '')),
    close: () => {},
  };
}

interface NodeFs {
  readFileSync(path: string, enc: string): string;
  existsSync(path: string): boolean;
  mkdirSync(path: string, opts: { recursive: boolean }): void;
  openSync(path: string, flags: string): number;
  writeSync(fd: number, data: string): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
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

/**
 * Filesystem chain storage (the Node default): truncate-open on creation, `write`+`fsync` each line
 * for durability, re-read the full chain from disk on demand (so a bounded in-memory log can still
 * export/verify the complete file).
 */
export function fsChainStorage(path: string): ChainStorage {
  nodeFs().mkdirSync(nodePath().dirname(path), { recursive: true });
  let fd: number | null = nodeFs().openSync(path, 'w');
  return {
    appendLine: (line: string) => {
      if (fd === null) {
        // handle closed: append-open, write, close (matches the reference fallback)
        const f = nodeFs().openSync(path, 'a');
        nodeFs().writeSync(f, line);
        nodeFs().fsyncSync(f);
        nodeFs().closeSync(f);
        return;
      }
      nodeFs().writeSync(fd, line);
      nodeFs().fsyncSync(fd);
    },
    readLines: () => {
      const text = nodeFs().existsSync(path) ? nodeFs().readFileSync(path, 'utf8') : '';
      return text.split('\n').filter((l) => l.length > 0);
    },
    close: () => {
      if (fd !== null) {
        nodeFs().closeSync(fd);
        fd = null;
      }
    },
  };
}

/** Read all non-empty lines from a path (for `verify()` / CLI). */
export function fsReadLines(path: string): string[] {
  const f = require('node:fs') as NodeFs;
  const text = f.readFileSync(path, 'utf8');
  return text.split('\n');
}
