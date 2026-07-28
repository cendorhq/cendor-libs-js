import { context, trace as otelTrace } from '@opentelemetry/api';
/**
 * `trace()` is a REAL span (@cendor/core 0.16.0) — one scope is one trace. TS mirror of cendor-libs'
 * `tests/test_trace_span.py`.
 *
 * Before this release the scope only stamped an ambient id, so every call inside still arrived as its
 * own root span: a scope around a chat call and a tool call produced TWO traces sharing one
 * `cendor.traceId`. In a monitor that meant one logical unit of work rendered as two unrelated rows,
 * its governance fanned out to both, and per-run governance counts doubled.
 *
 * Rails these tests exist for:
 *  * rail 2/3 — the scope binds through `context.with` (AsyncLocalStorage `run()`), never `enterWith`.
 *    `enterWith` only scopes as intended on node >= 24; on node 20/22 it leaks into concurrent flows
 *    and is not restored on exit. That leg is verified in docker on the supported Node versions; this
 *    file pins the semantics.
 *  * rail 4 — attribution is asserted with TWO OVERLAPPING scopes and a client that takes real time.
 *    An instant stub finishes scope A before scope B starts, so nothing ever interleaves and every
 *    cross-scope defect stays invisible.
 *  * rail 5 — a libs `trace()` inside an SDK run must not open a competing root, and a run-less call
 *    must not be adopted into a scope. Both directions.
 */
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus, currentTraceId, instrument, instrumentTool, otel, trace } from '../src/index.js';
import { _resetAutoTelemetry, _resetOTelApiCache } from '../src/otel.js';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let ctxManager: AsyncLocalStorageContextManager;

/** A fake chat client. `delayMs` makes the call take real time — the only way two scopes on two
 * concurrent flows actually overlap (an instant stub serializes and proves nothing). */
function fakeClient(delayMs = 0): { chat: { completions: { create: (o: unknown) => unknown } } } {
  return {
    chat: {
      completions: {
        create: async () => {
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          return { usage: { prompt_tokens: 10, completion_tokens: 4 } };
        },
      },
    },
  };
}

const spans = (prefix?: string): ReadableSpan[] =>
  exporter.getFinishedSpans().filter((s) => (prefix ? s.name.startsWith(prefix) : true));
const byTrace = (list: ReadableSpan[]): Map<string, ReadableSpan[]> => {
  const out = new Map<string, ReadableSpan[]>();
  for (const s of list) {
    const key = s.spanContext().traceId;
    out.set(key, [...(out.get(key) ?? []), s]);
  }
  return out;
};

beforeEach(() => {
  for (const k of ['CENDOR_TELEMETRY', 'CENDOR_TRACE_SPAN', 'CENDOR_DEBUG_TELEMETRY']) {
    Reflect.deleteProperty(process.env, k);
  }
  bus._reset();
  _resetAutoTelemetry();
  _resetOTelApiCache();
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  otelTrace.setGlobalTracerProvider(provider);
  // A registered context manager is what makes an active span propagate. `NodeSDK` /
  // `NodeTracerProvider.register()` install one in a real app; a bare `setGlobalTracerProvider`
  // does not, which is the documented honest limit (no propagation ⇒ no parenting, never an error).
  ctxManager = new AsyncLocalStorageContextManager();
  ctxManager.enable();
  context.setGlobalContextManager(ctxManager);
});
afterEach(async () => {
  bus._reset();
  _resetAutoTelemetry();
  await provider.shutdown();
  ctxManager.disable();
  context.disable();
  otelTrace.disable();
});

describe('trace() opens a real parent span', () => {
  it('a scope over two calls is ONE trace with ordered children', async () => {
    const client = instrument(fakeClient());
    const readFile = instrumentTool('read_file')((p: string) => `read ${p}`);
    await trace('fs-tool', async () => {
      await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'x' }],
      });
      readFile('a');
    });

    const all = spans();
    expect(byTrace(all).size, `one scope must be ONE trace: ${all.map((s) => s.name)}`).toBe(1);
    expect(all.map((s) => s.name).sort()).toEqual([
      'cendor.trace fs-tool',
      'chat gpt-4o-mini',
      'execute_tool read_file',
    ]);

    const parent = all.find((s) => s.name === 'cendor.trace fs-tool') as ReadableSpan;
    expect(parent.parentSpanContext, 'the scope span is the root').toBeUndefined();
    expect(parent.attributes['cendor.run.id']).toBe('fs-tool');
    expect(parent.attributes['cendor.scope']).toBe('trace');
    const children = all.filter((s) => s !== parent);
    for (const child of children) {
      expect(
        child.parentSpanContext?.spanId,
        `${child.name} must be a CHILD of the scope span`,
      ).toBe(parent.spanContext().spanId);
    }
    // …and the children are ordered, not left to timestamp luck.
    expect(Object.fromEntries(children.map((c) => [c.name, c.attributes['cendor.step']]))).toEqual({
      'chat gpt-4o-mini': 1,
      'execute_tool read_file': 2,
    });
    // The ambient id is still stamped on every event — `cendor.trace_id` correlation is unaffected.
    expect(children.every((c) => c.attributes['cendor.trace_id'] === 'fs-tool')).toBe(true);
  });

  it('a call OUTSIDE a scope is still its own root', async () => {
    const client = instrument(fakeClient());
    await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'x' }],
    });
    const all = spans();
    expect(all.map((s) => s.name)).toEqual(['chat gpt-4o-mini']);
    expect(all[0]?.parentSpanContext).toBeUndefined();
    expect(
      all[0]?.attributes['cendor.step'],
      'a step ordinal only means something in a scope',
    ).toBeUndefined();
    expect(all[0]?.attributes['cendor.trace_id']).toBeFalsy();
  });

  it('nesting is a no-op for the inner scope', async () => {
    const client = instrument(fakeClient());
    await trace('outer', async () => {
      await trace('inner', async () => {
        await client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'x' }],
        });
      });
    });
    const all = spans();
    expect(
      all.filter((s) => s.name.startsWith('cendor.trace ')).map((s) => s.name),
      'no second root for the inner scope',
    ).toEqual(['cendor.trace outer']);
    expect(byTrace(all).size).toBe(1);
    // The ambient id still follows the innermost binding (unchanged, pre-0.16 behaviour).
    expect(all.find((s) => s.name.startsWith('chat '))?.attributes['cendor.trace_id']).toBe(
      'inner',
    );
  });

  // ----------------------------------------------------------------- rail 4: OVERLAPPING scopes

  it('two OVERLAPPING scopes each render their own call exactly once', async () => {
    const client = instrument(fakeClient(60));
    const work = (id: string, model: string): Promise<unknown> =>
      trace(id, () =>
        client.chat.completions.create({ model, messages: [{ role: 'user', content: 'x' }] }),
      );
    // Started together, so each scope is open while the other's call is in flight.
    await Promise.all([work('scope-a', 'gpt-4o-mini'), work('scope-b', 'claude-sonnet-5')]);

    const groups = byTrace(spans());
    expect(groups.size, 'two scopes must be two traces').toBe(2);
    const ids = new Set<string>();
    for (const members of groups.values()) {
      expect(members.length, `scope + 1 call per trace: ${members.map((m) => m.name)}`).toBe(2);
      const parent = members.find((m) => m.name.startsWith('cendor.trace ')) as ReadableSpan;
      const child = members.find((m) => m !== parent) as ReadableSpan;
      const rid = String(parent.attributes['cendor.run.id']);
      ids.add(rid);
      expect(child.attributes['cendor.trace_id'], 'a call was attributed to the OTHER scope').toBe(
        rid,
      );
      expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
      expect(child.attributes['cendor.step']).toBe(1);
    }
    expect([...ids].sort()).toEqual(['scope-a', 'scope-b']);
    // Exactly two chat spans: neither call was rendered twice nor dropped.
    expect(spans('chat ').length).toBe(2);
  });

  it('a scope and a concurrent UNSCOPED call do not contaminate each other', async () => {
    const client = instrument(fakeClient(60));
    await Promise.all([
      trace('scoped', () =>
        client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'x' }],
        }),
      ),
      client.chat.completions.create({
        model: 'gpt-4.1-nano',
        messages: [{ role: 'user', content: 'y' }],
      }),
    ]);
    const loose = spans().find((s) => s.name === 'chat gpt-4.1-nano') as ReadableSpan;
    expect(
      loose.parentSpanContext,
      'an unscoped call was ADOPTED into the concurrent scope',
    ).toBeUndefined();
    expect(loose.attributes['cendor.trace_id']).toBeFalsy();
    expect(loose.attributes['cendor.step']).toBeUndefined();
    const inside = spans().find((s) => s.name === 'chat gpt-4o-mini') as ReadableSpan;
    expect(inside.parentSpanContext).toBeDefined();
    expect(inside.attributes['cendor.trace_id']).toBe('scoped');
  });

  // ------------------------------------------- rail 5: inside an SDK run, attach — never compete

  it('inside an SDK run the scope opens NO competing root', async () => {
    const client = instrument(fakeClient());
    const runTracer = otelTrace.getTracer('cendor.sdk');
    otel.enterLiveSpans(); // what the SDK's liveSpans does to the core emitter
    let runTraceId = '';
    try {
      await runTracer.startActiveSpan('agent.run', async (root) => {
        runTraceId = root.spanContext().traceId;
        await trace('libs-inside-a-run', async () => {
          await client.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'x' }],
          });
        });
        root.end();
      });
    } finally {
      otel.exitLiveSpans();
    }
    const all = spans();
    expect(
      all.filter((s) => s.name.startsWith('cendor.trace ')),
      'a libs trace() opened a competing root inside an SDK run',
    ).toEqual([]);
    expect(byTrace(all).size, "the run's trace must stay the only trace").toBe(1);
    expect(all[0]?.spanContext().traceId).toBe(runTraceId);
  });

  // --------------------------------------------------------------------------- the switches

  it('CENDOR_TRACE_SPAN=off restores the pre-0.16 shape', async () => {
    process.env.CENDOR_TRACE_SPAN = 'off';
    expect(otel.traceSpanEnabled()).toBe(false);
    const client = instrument(fakeClient());
    await trace('no-span', () =>
      client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'x' }],
      }),
    );
    const all = spans();
    expect(all.map((s) => s.name)).toEqual(['chat gpt-4o-mini']);
    expect(
      all[0]?.parentSpanContext,
      'with the switch off the call is a root again',
    ).toBeUndefined();
    expect(all[0]?.attributes['cendor.trace_id'], 'the ambient id is still stamped').toBe(
      'no-span',
    );
  });

  it('the span can be forced off per scope', async () => {
    const client = instrument(fakeClient());
    await trace(
      'explicit-off',
      () =>
        client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'x' }],
        }),
      { span: false },
    );
    expect(spans('cendor.trace ')).toEqual([]);
  });

  it('CENDOR_TELEMETRY=off opens no scope span', async () => {
    process.env.CENDOR_TELEMETRY = 'off';
    expect(otel.traceSpanEnabled()).toBe(false);
    const client = instrument(fakeClient());
    await trace('telemetry-off', () =>
      client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'x' }],
      }),
    );
    expect(spans('cendor.trace ')).toEqual([]);
  });

  it('an exception inside the scope still closes it, and the next scope opens', async () => {
    const client = instrument(fakeClient());
    await expect(
      trace('boom', async () => {
        await client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'x' }],
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(spans().some((s) => s.name === 'cendor.trace boom')).toBe(true);
    expect(currentTraceId(), 'the ambient id is restored').toBe('');
    await trace('after', () =>
      client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'x' }],
      }),
    );
    expect(spans().some((s) => s.name === 'cendor.trace after')).toBe(true);
  });
});
