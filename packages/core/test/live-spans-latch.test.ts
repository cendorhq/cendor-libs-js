/**
 * The G20 live-spans latch — two mechanisms, each asserted for what it actually guarantees.
 *
 * `enterLiveSpans()` / `exitLiveSpans()` are callback-less (a `liveSpans()` handle is closed by hand),
 * so they move a module counter and the stand-down is **process-wide while open**. `_withLiveSpansDepth`
 * is the scoped form the SDK's automatic run scope uses; it is `AsyncLocalStorage.run`-based and is
 * therefore correct on **every** supported Node.
 *
 * Why this file does not test a context-local `enterWith`: measured 2026-07-25 in docker, node 20.20 /
 * 22.23 (legacy AsyncLocalStorage) both LEAK an `enterWith` into concurrent flows *and* fail to restore
 * it on the matching exit — a closed scope would leave the emitter suppressed for the rest of the
 * process. Only node ≥ 24 (AsyncContextFrame) behaves as that design needed. `run()` is correct
 * everywhere, so the scoped path uses only that and these tests pin the honest contract.
 *
 * These tests use `useSpanEmitter(tracer)`'s explicit-tracer form, so they need no OTel SDK.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LLMCall, Usage, bus } from '../src/index.js';
import {
  _withLiveSpansDepth,
  enterLiveSpans,
  exitLiveSpans,
  liveSpansActive,
  useSpanEmitter,
} from '../src/otel.js';

function recorder(): { names: string[]; tracer: { startSpan: (name: string) => unknown } } {
  const names: string[] = [];
  const tracer = {
    startSpan: (name: string) => {
      names.push(name);
      return { setAttribute: () => {}, end: () => {} };
    },
  };
  return { names, tracer };
}

const call = (model: string): LLMCall =>
  new LLMCall({ id: model, provider: 'openai', model, messages: [], usage: new Usage(1, 1) });

let dispose: () => void;
beforeEach(() => bus._reset());
afterEach(() => {
  dispose?.();
  bus._reset();
});

describe('the manual latch (enterLiveSpans / exitLiveSpans)', () => {
  it('stands the emitter down while open and restores it on close', () => {
    const { names, tracer } = recorder();
    dispose = useSpanEmitter(tracer);
    enterLiveSpans();
    bus.emit(call('inside-scope')); // the SDK owns this one
    exitLiveSpans();
    bus.emit(call('after-close'));
    expect(names).toEqual(['chat after-close']);
  });

  it('nests, and an extra close cannot drive the depth negative', () => {
    const { names, tracer } = recorder();
    dispose = useSpanEmitter(tracer);
    enterLiveSpans();
    enterLiveSpans();
    exitLiveSpans();
    bus.emit(call('still-nested')); // depth 1 — suppressed
    exitLiveSpans();
    bus.emit(call('reopened')); // depth 0 — emitted
    exitLiveSpans(); // one too many
    bus.emit(call('after-extra-exit'));
    expect(names).toEqual(['chat reopened', 'chat after-extra-exit']);
  });

  it('is process-wide while open — the honest limit of a hand-closed handle', async () => {
    const { names, tracer } = recorder();
    dispose = useSpanEmitter(tracer);
    enterLiveSpans();
    await (async () => {
      await Promise.resolve();
      bus.emit(call('concurrent-flow')); // suppressed too: there is no scope to bind to
    })();
    exitLiveSpans();
    expect(names).toEqual([]);
    // …which is exactly why the SDK's automatic run scope uses the scoped form below.
  });
});

describe('the scoped latch (_withLiveSpansDepth — the automatic run scope)', () => {
  it('suppresses only inside the callback, on every supported Node', async () => {
    const { names, tracer } = recorder();
    dispose = useSpanEmitter(tracer);
    await _withLiveSpansDepth(async () => {
      bus.emit(call('inside-scope'));
      await Promise.resolve();
      bus.emit(call('still-inside'));
    });
    bus.emit(call('after-scope'));
    expect(names).toEqual(['chat after-scope']);
    expect(liveSpansActive()).toBe(false);
  });

  it('does not suppress a concurrent flow that never entered', async () => {
    const { names, tracer } = recorder();
    dispose = useSpanEmitter(tracer);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inScope = _withLiveSpansDepth(async () => {
      await gate;
      bus.emit(call('inside-scope'));
    });
    const sibling = (async () => {
      await Promise.resolve();
      bus.emit(call('libs-only')); // a concurrent libs-only call keeps its flat span
    })();
    await sibling;
    release();
    await inScope;
    expect(names).toEqual(['chat libs-only']);
  });

  it('two concurrent scopes do not leak into each other or past themselves', async () => {
    const { names, tracer } = recorder();
    dispose = useSpanEmitter(tracer);
    await Promise.all([
      _withLiveSpansDepth(async () => {
        await Promise.resolve();
        bus.emit(call('run-a'));
      }),
      _withLiveSpansDepth(async () => {
        await Promise.resolve();
        bus.emit(call('run-b'));
      }),
    ]);
    bus.emit(call('after-both'));
    expect(names).toEqual(['chat after-both']);
    expect(liveSpansActive()).toBe(false);
  });

  it('a throwing callback still unwinds the depth', async () => {
    const { names, tracer } = recorder();
    dispose = useSpanEmitter(tracer);
    await expect(
      _withLiveSpansDepth(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    bus.emit(call('after-throw'));
    expect(names).toEqual(['chat after-throw']);
  });
});
