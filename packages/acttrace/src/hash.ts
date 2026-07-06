/**
 * Synchronous SHA-256 + HMAC-SHA256, via `node:crypto`. acttrace hashes/signs inside a synchronous
 * bus subscriber (matching Python), so WebCrypto's async `subtle` is unusable. acttrace is a
 * server-side governance library (signing keys never belong in a browser), so `node:crypto` is the
 * correct dependency; it is also available in edge runtimes with `nodejs_compat`. Loaded via
 * `createRequire` so importing the package does not force `node:crypto` into a browser bundle.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface Hasher {
  update(data: string, enc: string): Hasher;
  digest(enc: string): string;
}
interface NodeCrypto {
  createHash(algo: string): Hasher;
  createHmac(algo: string, key: string | Uint8Array): Hasher;
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

let cryptoMod: NodeCrypto | undefined;
function nodeCrypto(): NodeCrypto {
  if (cryptoMod === undefined) cryptoMod = require('node:crypto') as NodeCrypto;
  return cryptoMod;
}

/** Lowercase-hex SHA-256 of the UTF-8 bytes of `text`. */
export function sha256Hex(text: string): string {
  return nodeCrypto().createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Lowercase-hex HMAC-SHA256 over the UTF-8 bytes of `text` under `key` (UTF-8 bytes of the passphrase). */
export function hmacSha256Hex(key: string | Uint8Array, text: string): string {
  return nodeCrypto().createHmac('sha256', key).update(text, 'utf8').digest('hex');
}

/** Constant-time string compare (both treated as UTF-8). Returns false on length mismatch. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ba.length !== bb.length) return false;
  return nodeCrypto().timingSafeEqual(ba, bb);
}
