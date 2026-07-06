/**
 * Synchronous SHA-256, via `node:crypto`. The bus subscriber / interceptor path is synchronous
 * (matching Python), so hashing must be sync too — WebCrypto's `subtle` is async and unusable here.
 * `node:crypto` is available in Node and in edge runtimes with `nodejs_compat`; cassette's job is
 * offline testing, which runs in Node. Loaded via `createRequire` so importing the package does not
 * force `node:crypto` into a browser bundle that never records/replays.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface NodeCrypto {
  createHash(algo: string): { update(data: string, enc: string): { digest(enc: string): string } };
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
