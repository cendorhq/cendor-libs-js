// Ambient metadata seam (GLR-1) — the core-owned pre-emit capture point. Contract: never-throw,
// never-overwrite, registration order, zero-provider byte-identical no-op (the libs-standalone
// contract). Plus the GLR-8 ingest trace-id stamp, which rides the same seam.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetAmbient, applyAmbient } from '../src/ambient.js';
import {
  LLMCall,
  addAmbientProvider,
  bus,
  instrument,
  otel,
  removeAmbientProvider,
  trace,
} from '../src/index.js';

let calls: LLMCall[];
function collector(event: unknown): void {
  if (event instanceof LLMCall) calls.push(event);
}

beforeEach(() => {
  calls = [];
  bus.subscribe(collector);
});
afterEach(() => {
  bus._reset();
  _resetAmbient();
});

function newCall(): LLMCall {
  return new LLMCall({ id: 'x', provider: 'openai', model: 'gpt-4o', messages: [] });
}

describe('ambient seam — contract', () => {
  it('zero providers is a byte-identical no-op', () => {
    const call = newCall();
    call.metadata.request_kwargs = { model: 'gpt-4o' };
    const before = JSON.stringify(call.metadata);
    applyAmbient(call);
    expect(JSON.stringify(call.metadata)).toBe(before);
  });

  it('merges a provider bag into metadata', () => {
    addAmbientProvider(() => ({ agent: 'reviewer', conversation_id: 'c1' }));
    const call = newCall();
    applyAmbient(call);
    expect(call.metadata.agent).toBe('reviewer');
    expect(call.metadata.conversation_id).toBe('c1');
  });

  it('never overwrites an existing metadata key (explicit value wins)', () => {
    addAmbientProvider(() => ({ agent: 'from-provider', extra: 1 }));
    const call = newCall();
    call.metadata.agent = 'explicit';
    applyAmbient(call);
    expect(call.metadata.agent).toBe('explicit');
    expect(call.metadata.extra).toBe(1);
  });

  it('runs providers in registration order (first non-conflicting write wins)', () => {
    addAmbientProvider(() => ({ k: 'first' }));
    addAmbientProvider(() => ({ k: 'second' }));
    const call = newCall();
    applyAmbient(call);
    expect(call.metadata.k).toBe('first');
  });

  it('never throws — a broken provider is swallowed and later providers still run', () => {
    addAmbientProvider(() => {
      throw new Error('boom');
    });
    addAmbientProvider(() => ({ survived: true }));
    const call = newCall();
    expect(() => applyAmbient(call)).not.toThrow();
    expect(call.metadata.survived).toBe(true);
  });

  it('passes the event so a provider can key a WeakMap off it (non-serializable attach)', () => {
    const attached = new WeakMap<object, string>();
    addAmbientProvider((event) => {
      attached.set(event, 'frames');
      return undefined; // attach by reference, merge nothing
    });
    const call = newCall();
    applyAmbient(call);
    expect(attached.get(call)).toBe('frames');
    expect(Object.keys(call.metadata)).not.toContain('undefined');
  });

  it('removeAmbientProvider unregisters', () => {
    const p = addAmbientProvider(() => ({ agent: 'x' }));
    removeAmbientProvider(p);
    const call = newCall();
    applyAmbient(call);
    expect(call.metadata.agent).toBeUndefined();
  });
});

describe('ambient seam — through instrument()', () => {
  it('stamps ambient metadata onto an emitted LLMCall at construction', async () => {
    addAmbientProvider(() => ({ agent: 'writer' }));
    const client = {
      chat: {
        completions: {
          create: async (_p: unknown) => ({
            choices: [{ message: { content: 'hi' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        },
      },
    };
    instrument(client);
    await trace('run-1', async () => {
      await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].metadata.agent).toBe('writer');
    expect(calls[0].traceId).toBe('run-1');
  });
});

describe('otel.ingest() — GLR-8 trace-id stamp', () => {
  it('stamps the ambient trace id at construction so the ingested call joins its run', () => {
    let call: LLMCall | undefined;
    trace('run-42', () => {
      call = otel.ingest({
        'gen_ai.request.model': 'gpt-4o',
        'gen_ai.system': 'openai',
        'gen_ai.usage.input_tokens': 10,
        'gen_ai.usage.output_tokens': 3,
      });
    });
    expect(call?.traceId).toBe('run-42');
  });

  it('runs ambient providers on the ingested call', () => {
    addAmbientProvider(() => ({ agent: 'ingested-agent' }));
    const call = otel.ingest({ 'gen_ai.request.model': 'gpt-4o', 'gen_ai.system': 'openai' });
    expect(call.metadata.agent).toBe('ingested-agent');
  });
});
