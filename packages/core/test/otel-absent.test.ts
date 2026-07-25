/**
 * The local-first rail, pinned: with `@opentelemetry/api` NOT installed, every OTel touchpoint is a
 * silent no-op and behaviour is byte-identical.
 *
 * `@opentelemetry/api` is a devDependency of this package (the auto-wiring tests need a real
 * provider), so absence is simulated at the only place the code loads it — `createRequire` from
 * `node:module`. The mock lets every other module id through, so nothing else changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  return {
    ...actual,
    createRequire: (from: string | URL) => {
      const real = actual.createRequire(from);
      return Object.assign((id: string) => {
        if (id.startsWith('@opentelemetry')) {
          const err = new Error(`Cannot find module '${id}'`) as Error & { code?: string };
          err.code = 'MODULE_NOT_FOUND';
          throw err;
        }
        return real(id);
      }, real);
    },
  };
});

const { LLMCall, Usage, bus, otel } = await import('../src/index.js');

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

describe('OTel absent', () => {
  it('span() yields null and still runs the callback', () => {
    let seen: unknown = 'unset';
    const result = otel.span('gpt-4o', { provider: 'openai' }, (s) => {
      seen = s;
      return 'ok';
    });
    expect(seen).toBeNull();
    expect(result).toBe('ok');
  });

  it('useSpanEmitter() subscribes nothing and returns a no-op disposer', () => {
    const before = bus._subscriberCount();
    const off = otel.useSpanEmitter();
    expect(bus._subscriberCount()).toBe(before); // zero bus cost — nothing is wired
    expect(() => off()).not.toThrow();
    bus.emit(
      new LLMCall({
        id: 'x',
        provider: 'openai',
        model: 'gpt-4o',
        messages: [],
        usage: new Usage(1, 1),
      }),
    );
  });

  it('the live-spans latch still counts (the global fallback) and never throws', () => {
    expect(() => {
      otel.enterLiveSpans();
      otel.exitLiveSpans();
    }).not.toThrow();
  });

  it('ingest() is unaffected — it never needed OTel', () => {
    const call = otel.ingest({
      'gen_ai.system': 'openai',
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.usage.input_tokens': 1000,
      'gen_ai.usage.output_tokens': 500,
    });
    expect(call.cost?.amount.toString()).toBe('0.0075');
  });
});
