/**
 * The G20 live-spans latch is CONTEXT-LOCAL (P1 / W0.5), matching Python's ContextVar.
 *
 * It used to be a module-global counter, so one open `liveSpans` scope made the core span emitter
 * stand down for **every** concurrent async context in the process — a TS app mixing an SDK run with
 * concurrent libs-only calls lost the flat spans for the latter — and an unclosed handle (the JS API
 * needs an explicit `close()`) stuck the latch forever, silently killing the emitter process-wide.
 *
 * These tests use `useSpanEmitter(tracer)`'s explicit-tracer form, so they need no OTel SDK.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LLMCall, Usage, bus } from '../src/index.js';
import { enterLiveSpans, exitLiveSpans, useSpanEmitter } from '../src/otel.js';

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

describe('live-spans latch', () => {
  it('a scope open in one async flow does not suppress a concurrent flow', async () => {
    const { names, tracer } = recorder();
    dispose = useSpanEmitter(tracer);

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const flowA = (async () => {
      // The await FIRST is deliberate: an async function body runs synchronously in its CALLER's
      // async context, so entering before it would (correctly, per ContextVar semantics) also bind
      // the caller. This flow owns its own context from here on.
      await Promise.resolve();
      enterLiveSpans();
      await gate; // hold the scope open while flow B runs
      bus.emit(call('inside-scope')); // the SDK owns this one — the emitter must stand down
      exitLiveSpans();
    })();

    const flowB = (async () => {
      await Promise.resolve();
      bus.emit(call('libs-only')); // never entered a scope → must still get a flat span
    })();

    await flowB;
    release();
    await flowA;

    expect(names).toEqual(['chat libs-only']);
  });

  it('an unclosed scope does not suppress a LATER independent flow', async () => {
    const { names, tracer } = recorder();
    dispose = useSpanEmitter(tracer);

    await (async () => {
      await Promise.resolve();
      enterLiveSpans(); // leaked on purpose — no exitLiveSpans()
      bus.emit(call('leaked'));
    })();

    await (async () => {
      await Promise.resolve();
      bus.emit(call('after-leak'));
    })();

    expect(names).toEqual(['chat after-leak']);
  });

  it('nesting still counts, and the scope re-opens the emitter on the last exit', async () => {
    const { names, tracer } = recorder();
    dispose = useSpanEmitter(tracer);
    await (async () => {
      await Promise.resolve();
      enterLiveSpans();
      enterLiveSpans();
      exitLiveSpans();
      bus.emit(call('still-nested')); // depth 1 — suppressed
      exitLiveSpans();
      bus.emit(call('reopened')); // depth 0 — emitted
      exitLiveSpans(); // an extra close must not drive the depth negative
      bus.emit(call('after-extra-exit'));
    })();
    expect(names).toEqual(['chat reopened', 'chat after-extra-exit']);
  });

  it("a scope entered inside a flow suppresses that flow's own descendants (ContextVar parity)", async () => {
    const { names, tracer } = recorder();
    dispose = useSpanEmitter(tracer);
    await (async () => {
      await Promise.resolve();
      enterLiveSpans();
      // A child started INSIDE the scope is part of the region the user wrapped — Python's
      // ContextVar behaves the same way, so this is parity, not leakage.
      await (async () => {
        bus.emit(call('child-inside'));
      })();
      exitLiveSpans();
    })();
    expect(names).toEqual([]);
  });
});
