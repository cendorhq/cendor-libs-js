// Type-level regression test: `decompress()` must accept the handle contextkit hands back.
//
// Why this exists. `contextkit`'s `BlockDecision.handle` is typed as core's `Compressor` PROTOCOL
// handle — `{ expand(): unknown }` — deliberately the smallest thing contextkit needs to know about
// whatever backend was registered. `@cendor/squeeze` exports its own richer, concrete `Handle`
// (`id`, `kind`, `originalRef`, `restoreMap`, …).
//
// Narrowing `decompress(handle: Handle)` to the concrete class meant the single most likely call —
// compress a block through contextkit, then restore it — did not compile, on objects that are
// identical at runtime. Measured 2026-08-01 while converting cendor-cookbook-js to TypeScript
// source. Python never had this: there `BlockDecision.handle` is `Any`.
//
// `decompress` now accepts either. This file pins both directions: if someone re-narrows the
// parameter, the protocol case stops compiling; if squeeze's own `Handle` ever stops satisfying it,
// the concrete case does.
//
// Checked by `pnpm check:types`. Imports the built dist — the shape a consumer actually gets — so
// run `pnpm build` first.
import { Block, Context } from '../packages/contextkit/dist/index.js';
import { SqueezeCompressor, compress, decompress } from '../packages/squeeze/dist/index.js';

/** The concrete handle squeeze produces must still work. */
export function decompressAcceptsSqueezesOwnHandle(): string {
  const [, handle] = compress('some long prose to shrink', { kind: 'prose', targetTokens: 32 });
  return decompress(handle);
}

/** A bare protocol handle — `{ expand(): unknown }` and nothing more — must work. */
export function decompressAcceptsAProtocolHandle(): string {
  const protocolHandle: { expand(): unknown } = { expand: () => 'the original' };
  return decompress(protocolHandle);
}

/**
 * The real path: contextkit reports a compressed decision, whose `handle` is the protocol type.
 * This is the call that used to be a compile error.
 */
export async function decompressAcceptsAContextkitDecision(): Promise<string | null> {
  const ctx = new Context({ budgetTokens: 64, model: 'gpt-4o', reserveOutput: 0 })
    .add(new Block('keep me', { role: 'system', pin: true, priority: 100 }))
    .add(
      new Block('a much longer block that will not fit'.repeat(20), {
        priority: 1,
        evict: 'compress',
      }),
    );
  await ctx.assemble();
  const cut = ctx.report().decisions.find((d) => d.action === 'compressed');
  if (!cut?.handle) return null;
  return decompress(cut.handle);
}

/** `SqueezeCompressor` must keep satisfying core's `Compressor` protocol. */
export function squeezeCompressorSatisfiesTheProtocol() {
  const backend: { compress(content: unknown, opts?: object): [string, { expand(): unknown }] } =
    new SqueezeCompressor();
  return backend;
}
