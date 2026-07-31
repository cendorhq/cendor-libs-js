/**
 * The interceptor chain's ordering contract (`@cendor/core` 3.3.0) — the D3 fix.
 *
 * **What changed.** A `Reroute` no longer ends the chain; only a returned *response* does. Before
 * this, `intercept` returned the first non-MISS result and a `Reroute` is a non-MISS result — so the
 * first interceptor that rewrote the request silently skipped every one registered after it.
 *
 * **Why it mattered, measured** (`plan/evidence-gapclose-2026-07-31/s6_probe_interceptor_chain.py`,
 * whose Python findings apply verbatim here — both ports had the identical `intercept`):
 *
 *     registration order      what fired     what the provider actually received
 *     clamp, then guard       clamp only     maxTokens applied, PII **UNREDACTED**
 *     guard, then clamp       guard only     redacted, and the token cap **never bound**
 *
 * Both failures are silent, both are in the dangerous direction, and which one you got depended on
 * the order two libraries happened to register in — which a user has no way to observe.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LLMCall,
  MISS,
  Reroute,
  addInterceptor,
  bus,
  instrument,
  removeInterceptor,
} from '../src/index.js';

const PII = 'my ssn is 123-45-6789';
const ARGS = { model: 'gpt-4o', messages: [{ role: 'user', content: PII }] };

let wire: Record<string, unknown>[];
let calls: LLMCall[];
let registered: ((e: unknown) => unknown)[];

function client() {
  return instrument({
    chat: {
      completions: {
        create: async (kwargs: Record<string, unknown>) => {
          wire.push(structuredClone(kwargs));
          return {
            usage: { prompt_tokens: 5, completion_tokens: 4 },
            choices: [{ message: { content: 'an answer' } }],
          };
        },
      },
    },
  });
}

function register(...fns: ((e: unknown) => unknown)[]): void {
  for (const fn of fns) {
    addInterceptor(fn);
    registered.push(fn);
  }
}

/** An interceptor that rewrites the request and records that it ran. */
function reroute(updates: Record<string, unknown>) {
  const ran: true[] = [];
  const fn = (call: unknown): unknown => {
    if (!(call instanceof LLMCall)) return MISS;
    ran.push(true);
    return new Reroute(updates);
  };
  return Object.assign(fn, { ran });
}

/** An interceptor that declines — it must be consulted on every call, before AND after a reroute. */
function observer() {
  const seen: LLMCall[] = [];
  const fn = (call: unknown): unknown => {
    if (call instanceof LLMCall) seen.push(call);
    return MISS;
  };
  return Object.assign(fn, { seen });
}

beforeEach(() => {
  bus._reset();
  wire = [];
  calls = [];
  registered = [];
  bus.subscribe((e) => {
    if (e instanceof LLMCall) calls.push(e);
  });
});
afterEach(() => {
  for (const fn of registered) removeInterceptor(fn);
  bus._reset();
});

describe('the ordering contract', () => {
  it('lets two reroutes both reach the provider', async () => {
    const clamp = reroute({ max_tokens: 16 });
    const redact = reroute({ messages: [{ role: 'user', content: 'my ssn is [REDACTED]' }] });
    register(clamp, redact);
    await client().chat.completions.create(ARGS);
    expect(clamp.ran).toHaveLength(1);
    expect(redact.ran).toHaveLength(1);
    expect(wire[0].max_tokens).toBe(16);
    expect(wire[0].messages).toEqual([{ role: 'user', content: 'my ssn is [REDACTED]' }]);
  });

  it('gives the same result in the reverse registration order', async () => {
    const redact = reroute({ messages: [{ role: 'user', content: 'my ssn is [REDACTED]' }] });
    const clamp = reroute({ max_tokens: 16 });
    register(redact, clamp);
    await client().chat.completions.create(ARGS);
    expect(wire[0].max_tokens).toBe(16);
    expect(wire[0].messages).toEqual([{ role: 'user', content: 'my ssn is [REDACTED]' }]);
  });

  it('shows a later interceptor the rerouted messages, not the originals', async () => {
    const redact = reroute({ messages: [{ role: 'user', content: 'clean' }] });
    const watcher = observer();
    register(redact, watcher);
    await client().chat.completions.create(ARGS);
    expect(watcher.seen[0].messages).toEqual([{ role: 'user', content: 'clean' }]);
  });

  it('shows a later interceptor the rerouted model', async () => {
    const downgrade = reroute({ model: 'gpt-4o-mini' });
    const watcher = observer();
    register(downgrade, watcher);
    await client().chat.completions.create(ARGS);
    expect(watcher.seen[0].model).toBe('gpt-4o-mini');
  });

  it('composes reroutes in registration order — the last write of a field wins', async () => {
    register(reroute({ model: 'gpt-4o-mini' }), reroute({ model: 'gpt-4.1-nano' }));
    await client().chat.completions.create(ARGS);
    expect(wire[0].model).toBe('gpt-4.1-nano');
  });

  it('applies three reroutes to three different fields', async () => {
    register(
      reroute({ max_tokens: 16 }),
      reroute({ model: 'gpt-4o-mini' }),
      reroute({ messages: [{ role: 'user', content: 'clean' }] }),
    );
    await client().chat.completions.create(ARGS);
    expect(wire[0]).toMatchObject({
      max_tokens: 16,
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'clean' }],
    });
  });

  it('records the rerouted flag once on a single LLMCall', async () => {
    register(reroute({ max_tokens: 16 }), reroute({ model: 'gpt-4o-mini' }));
    await client().chat.completions.create(ARGS);
    expect(calls).toHaveLength(1);
    expect(calls[0].metadata.rerouted).toBe(true);
  });
});

describe('what must NOT change', () => {
  const RECORDED = {
    usage: { prompt_tokens: 1, completion_tokens: 1 },
    choices: [{ message: { content: 'replayed' } }],
  };

  it('still short-circuits on a replayed response', async () => {
    const clamp = reroute({ max_tokens: 16 });
    register((call) => (call instanceof LLMCall ? RECORDED : MISS), clamp);
    const out = await client().chat.completions.create(ARGS);
    expect(out).toBe(RECORDED);
    expect(clamp.ran).toHaveLength(0); // a replay ends the chain
    expect(wire).toHaveLength(0); // and the provider is never called
  });

  it('does not call the provider when a reroute precedes a replay', async () => {
    register(reroute({ max_tokens: 16 }), (call) => (call instanceof LLMCall ? RECORDED : MISS));
    const out = await client().chat.completions.create(ARGS);
    expect(out).toBe(RECORDED);
    expect(wire).toHaveLength(0);
  });

  it('consults an observer both before and after a reroute', async () => {
    const before = observer();
    const after = observer();
    register(before, reroute({ max_tokens: 16 }), after);
    await client().chat.completions.create(ARGS);
    expect(before.seen).toHaveLength(1);
    expect(after.seen).toHaveLength(1);
  });

  it('still rejects when an interceptor throws, and sends nothing', async () => {
    const later = observer();
    register(() => {
      throw new Error('budget: blocked');
    }, later);
    await expect(client().chat.completions.create(ARGS)).rejects.toThrow('budget: blocked');
    expect(wire).toHaveLength(0);
    expect(later.seen).toHaveLength(0); // a throw is not a Reroute — it stops the chain
  });

  it('still rejects when an interceptor throws AFTER a reroute', async () => {
    register(reroute({ max_tokens: 16 }), () => {
      throw new Error('budget: blocked');
    });
    await expect(client().chat.completions.create(ARGS)).rejects.toThrow('budget: blocked');
    expect(wire).toHaveLength(0);
  });

  it('is unchanged with no interceptors registered', async () => {
    await client().chat.completions.create(ARGS);
    expect(wire[0].messages).toEqual(ARGS.messages);
    expect(wire[0].max_tokens).toBeUndefined();
  });

  it('switches a POSITIONAL call to the options form once anything reroutes it', async () => {
    // The legacy Gemini surface accepts `generateContent("hi")`. The pre-3.3.0 reroute branch always
    // re-invoked with the kwargs object; the merged single path has to keep doing that, or a redaction
    // would be applied and then not sent.
    const seen: unknown[][] = [];
    const gemini = instrument({
      generateContent: async (...args: unknown[]) => {
        seen.push(args);
        return { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4 }, text: 'ok' };
      },
      model: 'models/gemini-2.5-flash',
    });
    register(reroute({ messages: [{ role: 'user', content: 'clean' }] }));
    await gemini.generateContent('leak my ssn 123-45-6789');
    const first = seen[0][0] as Record<string, unknown>;
    expect(typeof first).toBe('object'); // not the original positional string
    expect(first.contents).toBeDefined(); // the rewritten request actually went
    expect(JSON.stringify(first)).not.toContain('123-45-6789');
  });

  it('keeps a positional call positional when nothing reroutes it', async () => {
    const seen: unknown[][] = [];
    const gemini = instrument({
      generateContent: async (...args: unknown[]) => {
        seen.push(args);
        return { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4 }, text: 'ok' };
      },
      model: 'models/gemini-2.5-flash',
    });
    await gemini.generateContent('hello');
    expect(seen[0][0]).toBe('hello'); // NEGATIVE CONTROL: the SDK's own call shape is preserved
  });
});
