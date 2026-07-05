/**
 * Shared test helpers. Mirrors the Python tests' `SimpleNamespace`-based fake clients, adapted to
 * the TS core: `instrument()` is async, so `create` returns a Promise and callers must `await`.
 */
import { instrument } from '@cendor/core';

/** A duck-typed OpenAI-shaped client (only the fields `instrument()` detects). */
export interface FakeClient {
  chat: { completions: { create: (params: Record<string, unknown>) => Promise<unknown> } };
}

export interface MakeClientOptions {
  /** Fake usage the `create` returns (defaults to the classic 1000-in/500-out = $0.0075 call). */
  usage?: Record<string, unknown>;
  /** Called with the (possibly rerouted/clamped) request kwargs each call actually received. */
  onCreate?: (params: Record<string, unknown>) => void;
}

/** Build an instrumented fake OpenAI client whose `create` returns fixed fake usage. */
export function makeClient(opts: MakeClientOptions = {}): FakeClient {
  const usage = opts.usage ?? { prompt_tokens: 1000, completion_tokens: 500 };
  const client = {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          opts.onCreate?.(params);
          return { usage };
        },
      },
    },
  };
  return instrument(client) as unknown as FakeClient;
}

export interface CallOptions {
  n?: number;
  model?: string;
  content?: string;
}

/** Make `n` sequential (awaited) chat-completion calls through an instrumented client. */
export async function callN(client: FakeClient, opts: CallOptions = {}): Promise<void> {
  const n = opts.n ?? 1;
  const model = opts.model ?? 'gpt-4o';
  const content = opts.content ?? 'x';
  for (let i = 0; i < n; i++) {
    await client.chat.completions.create({ model, messages: [{ role: 'user', content }] });
  }
}

/** `[0, 1, ..., n-1]`. */
export function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
