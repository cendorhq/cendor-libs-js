/**
 * A zero-config **local embedder** for the semantic checks — the TS counterpart to Python's
 * `cendor.guardrails.embeddings.local_embedder`.
 *
 * The similarity checks (`rules.customCategory` / `deniedTopics` / `groundedness` / `intent`) take a
 * **bring-your-own** `embed(text)`. `localEmbedder` closes the "but I have to wire an embedder first"
 * gap with a local, offline default backed by **transformers.js** (`@huggingface/transformers`,
 * WASM/WebGPU — works in Node, the browser, and edge). It is loaded **lazily** and is an **optional**
 * dependency (never bundled, never a hard requirement) — without it installed, the call raises a
 * clear, actionable error, exactly like Python's lazy `model2vec` import.
 *
 * **Cross-language note (parity 🚧 → ✓ with a caveat):** Python uses **model2vec** static embeddings
 * (a synchronous lookup); there is no maintained model2vec port for JS, so TS uses transformers.js
 * feature-extraction, which is **asynchronous**. So `localEmbedder()` returns an **async** `embed`,
 * which makes the semantic checks run on the async path — use them through `applyAsync` or the SDK
 * loop (`Agent`), not the synchronous `apply()` / `install()` seam. The default model is a small
 * sentence-transformer; the model is fetched from Hugging Face on first use and cached, never bundled.
 *
 * ```ts
 * import { rules, embeddings } from '@cendor/guardrails';
 *
 * const embed = await embeddings.localEmbedder();              // npm i @huggingface/transformers
 * const rail = rules.customCategory('code_requests',
 *   ['write a program', 'build an app'], embed, { action: 'flag' });
 * ```
 */
import type { Embed } from './semantic.js';

// The tiny slice of the transformers.js surface we use — typed locally so `@cendor/guardrails` keeps
// NO build-time dependency on the optional peer (the module is resolved only at runtime, lazily).
type FeatureExtractor = (
  text: string,
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Iterable<number> }>;
interface TransformersModule {
  pipeline: (
    task: string,
    model: string,
    opts?: Record<string, unknown>,
  ) => Promise<FeatureExtractor>;
}

/** The default transformers.js feature-extraction model — small, fast, mean-pooled sentence vectors. */
export const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

export interface LocalEmbedderOptions {
  /** A transformers.js feature-extraction model id (default `Xenova/all-MiniLM-L6-v2`). */
  model?: string;
  /** Passed to the transformers.js `pipeline(...)` (e.g. `{ dtype: 'q8' }`, `{ device: 'webgpu' }`). */
  pipelineOptions?: Record<string, unknown>;
}

/**
 * Build a free, offline **async** `embed(text) => Promise<number[]>` backed by transformers.js.
 *
 * Needs the optional peer `@huggingface/transformers` (`npm i @huggingface/transformers`); it is
 * lazy-imported on the first call, so importing `@cendor/guardrails` never pulls it in. The model is
 * loaded once and cached for the life of the returned function (mean-pooled + normalized vectors).
 * Because the embed is async, hand the result to `rules.customCategory` / `deniedTopics` /
 * `groundedness` / `intent` and gate through `applyAsync` or the SDK loop.
 *
 * There is **no catch-rate claim** — the embedding quality is the model's, not a cendor claim;
 * calibrate the similarity threshold on your own inputs.
 *
 * It is `embeddings.localEmbedder`, **not** `rules.localEmbedder` — and needs the
 * `@huggingface/transformers` optional peer.
 *
 * @example
 * ```ts
 * import { rules, embeddings } from '@cendor/guardrails';
 * const embed = await embeddings.localEmbedder();   // npm i @huggingface/transformers
 * const rail = rules.deniedTopics(embed, ['medical advice']);
 * ```
 */
export async function localEmbedder(opts: LocalEmbedderOptions = {}): Promise<Embed> {
  const model = opts.model ?? DEFAULT_MODEL;
  // A non-literal specifier so tsc resolves the optional peer only at runtime (no build-time dep).
  const spec: string = '@huggingface/transformers';
  let transformers: TransformersModule;
  try {
    transformers = (await import(spec)) as TransformersModule;
  } catch (err) {
    throw new Error(
      `localEmbedder needs the optional peer '@huggingface/transformers': npm i @huggingface/transformers (WASM/WebGPU — Node, browser, edge). Or pass your own embed(text) to the semantic rules. (import failed: ${(err as Error).message})`,
    );
  }
  const extractor = await transformers.pipeline('feature-extraction', model, opts.pipelineOptions);
  return async (text: string): Promise<number[]> => {
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data, (x) => Number(x));
  };
}
