// First-class **aws-sdk-v3** Bedrock capture — `client.send(new ConverseCommand({...}))`.
//
// The gap this closes was the most surprising one in the JS port, and cendor-testsuits recorded it as
// a challenge on every single live run: aws-sdk v3 exposes no `client.converse(...)`, so a libs-only
// TypeScript Bedrock app got **zero** capture — no budget, no guard, no audit, no cassette, measured
// at 0 LLMCalls (`plan/evidence-gapclose-2026-07-31/s2_probe_bedrock_awssdkv3.mjs`, run against the
// real @aws-sdk/client-bedrock-runtime 3.1100.0 with a stubbed transport).
//
// `send` is shared by every AWS command, so the capture is keyed on TWO things: the client is
// identified once (`config.serviceId === 'Bedrock Runtime'`), and the command is identified per call
// (its constructor name). Everything else — another AWS command, `InvokeModelCommand`, an S3 client —
// must pass through completely untouched, which is what most of this file asserts.
//
// Also pinned here: `Reroute({ model })` lands on **`modelId`** (S2b). Before that fix a downgrade
// wrote a generic `model` member Converse does not have, so the provider billed the ORIGINAL model
// while the LLMCall, the budget ledger and the audit chain all recorded the cheap one.
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

const CHUNK_GAP_MS = 15;

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
});

// --------------------------------------------------------------------------- fakes
//
// These mirror the shapes measured on the real SDK: a client whose `config.serviceId` is
// "Bedrock Runtime" and a polymorphic `send` that receives command objects whose class name carries
// the operation and whose `input` carries the request.

/** A command object indistinguishable (to a duck-typer) from the real SDK's. */
function command(name: string, input: unknown): { input: unknown } {
  const Cls = { [name]: class {} }[name] as new () => object;
  const cmd = new Cls() as { input: unknown };
  cmd.input = input;
  return cmd;
}

const CONVERSE_RESPONSE = {
  output: { message: { role: 'assistant', content: [{ text: 'hi' }] } },
  stopReason: 'end_turn',
  usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
};

interface FakeClient {
  config: { serviceId: string };
  send(command: unknown, ...rest: unknown[]): Promise<unknown>;
  sent: unknown[];
}

function fakeBedrock(response: unknown = CONVERSE_RESPONSE): FakeClient {
  const sent: unknown[] = [];
  return {
    config: { serviceId: 'Bedrock Runtime' },
    sent,
    async send(cmd: unknown) {
      // Record the request AS THE CLIENT SEES IT — this is "what reached the wire".
      sent.push(structuredClone((cmd as { input: unknown }).input));
      return response;
    },
  };
}

const INPUT = {
  modelId: 'eu.amazon.nova-2-lite-v1:0',
  messages: [{ role: 'user', content: [{ text: 'hi' }] }],
  inferenceConfig: { maxTokens: 16 },
};

function converse(input: unknown = INPUT) {
  return command('ConverseCommand', input);
}

// --------------------------------------------------------------------------- capture

describe('aws-sdk-v3 Bedrock capture', () => {
  it('emits one LLMCall for send(ConverseCommand) with real usage', async () => {
    const client = instrument(fakeBedrock());
    const out = await client.send(converse());
    expect(calls).toHaveLength(1);
    expect(calls[0].provider).toBe('bedrock'); // the internal `bedrock_send` tag never leaks
    expect(calls[0].model).toBe('eu.amazon.nova-2-lite-v1:0');
    expect(calls[0].usage.inputTokens).toBe(11);
    expect(calls[0].usage.outputTokens).toBe(7);
    expect(out).toBe(CONVERSE_RESPONSE); // the SDK's response is handed back untouched
  });

  it('detects the client by constructor name when config carries no serviceId', async () => {
    // A config that never resolved a serviceId (or a hand-rolled client) still has the class name.
    class BedrockRuntimeClient {
      sent: unknown[] = [];
      async send(cmd: unknown): Promise<unknown> {
        this.sent.push((cmd as { input: unknown }).input);
        return CONVERSE_RESPONSE;
      }
    }
    const client = instrument(new BedrockRuntimeClient());
    await client.send(converse());
    expect(calls).toHaveLength(1);
  });

  it('captures send(ConverseStreamCommand) as an always-stream target', async () => {
    // Real cadence between events: a generator that yields everything instantly cannot tell a
    // per-chunk observer apart from a post-hoc one (org rail).
    async function* events(): AsyncGenerator<unknown> {
      yield { messageStart: { role: 'assistant' } };
      await new Promise((r) => setTimeout(r, CHUNK_GAP_MS));
      yield { contentBlockDelta: { delta: { text: 'hi' } } };
      await new Promise((r) => setTimeout(r, CHUNK_GAP_MS));
      yield { metadata: { usage: { inputTokens: 11, outputTokens: 7 } } };
    }
    const client = instrument(fakeBedrock({ stream: events() }));
    const response = (await client.send(command('ConverseStreamCommand', INPUT))) as {
      stream: AsyncIterable<unknown>;
    };
    // The iterable arrives as the `stream` member — iterating it is what settles the call.
    const seen: unknown[] = [];
    for await (const ev of response.stream) seen.push(ev);
    expect(seen).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(calls[0].usage.inputTokens).toBe(11);
    expect(calls[0].usage.outputTokens).toBe(7);
  });
});

// --------------------------------------------------------------------------- negative controls

describe('aws-sdk-v3 Bedrock: what must stay untouched', () => {
  it('passes an unrelated AWS command straight through, emitting nothing', async () => {
    const client = instrument(fakeBedrock({ asyncInvokeSummaries: [] }));
    const cmd = command('ListAsyncInvokesCommand', { maxResults: 10 });
    const out = await client.send(cmd);
    expect(calls).toHaveLength(0);
    expect(out).toEqual({ asyncInvokeSummaries: [] });
    // The command object itself must not have been rewritten.
    expect(cmd.input).toEqual({ maxResults: 10 });
  });

  it('does not capture InvokeModelCommand (its body is opaque per-model JSON)', async () => {
    const client = instrument(fakeBedrock({ body: '{}' }));
    await client.send(command('InvokeModelCommand', { modelId: INPUT.modelId, body: '{}' }));
    expect(calls).toHaveLength(0);
  });

  it('leaves a non-Bedrock aws-sdk client entirely alone', async () => {
    const s3 = {
      config: { serviceId: 'S3' },
      send: async () => ({ ok: true }),
    };
    const returned = instrument(s3);
    // `instrument()` documents that unknown clients come back untouched — not wrapped-but-passthrough.
    expect((returned.send as { [k: symbol]: unknown })[Symbol.for('cendor.wrapped')]).toBeFalsy();
    await returned.send();
    expect(calls).toHaveLength(0);
  });

  it('emits nothing when the call fails (capture is best-effort, not a billing guarantee)', async () => {
    const client = instrument({
      config: { serviceId: 'Bedrock Runtime' },
      send: async () => {
        throw new Error('AccessDeniedException');
      },
    });
    await expect(client.send(converse())).rejects.toThrow('AccessDeniedException');
    expect(calls).toHaveLength(0);
  });

  it('is idempotent — instrument() twice still emits once', async () => {
    const client = fakeBedrock();
    instrument(client);
    instrument(client);
    await client.send(converse());
    expect(calls).toHaveLength(1);
  });

  it('does not double-count under a synthetic converse() over an instrumented client', async () => {
    // Exactly `@cendor/sdk`'s Bedrock provider shape, with the inner v3 client ALSO instrumented —
    // what a user who called instrument() themselves and then handed the client to an Agent gets.
    // One HTTP request must mean one LLMCall and therefore one budget charge.
    const inner = instrument(fakeBedrock());
    const synthetic = instrument({
      converse: (input: unknown) => inner.send(converse(input)),
    });
    await synthetic.converse(INPUT);
    expect(calls).toHaveLength(1);
    expect(calls[0].provider).toBe('bedrock');
  });

  it('still captures when only the inner v3 client is instrumented', async () => {
    // The mirror of the case above: the guard must not suppress a genuinely un-nested call.
    const inner = instrument(fakeBedrock());
    const plain = { converse: (input: unknown) => inner.send(converse(input)) };
    await plain.converse(INPUT);
    expect(calls).toHaveLength(1);
  });

  it('keeps two concurrent sends independent (the depth guard must not swallow one)', async () => {
    // The nesting guard is a counter held across a synchronous window only. Two overlapping calls
    // through clients with real latency must both be captured — a zero-latency stub would finish the
    // first before the second began and prove nothing (org rail).
    function slow(ms: number): FakeClient {
      const sent: unknown[] = [];
      return {
        config: { serviceId: 'Bedrock Runtime' },
        sent,
        async send(cmd: unknown) {
          sent.push(structuredClone((cmd as { input: unknown }).input));
          await new Promise((r) => setTimeout(r, ms));
          return { ...CONVERSE_RESPONSE, usage: { inputTokens: 5, outputTokens: 3 } };
        },
      };
    }
    const a = instrument(slow(30));
    const b = instrument(slow(10));
    await Promise.all([
      a.send(converse({ ...INPUT, modelId: 'model-a' })),
      b.send(converse({ ...INPUT, modelId: 'model-b' })),
    ]);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.model).sort()).toEqual(['model-a', 'model-b']);
  });
});

// --------------------------------------------------------------------------- governance

describe('aws-sdk-v3 Bedrock: governance reaches the wire', () => {
  it('blocks pre-flight, before any request is sent', async () => {
    const client = instrument(fakeBedrock());
    const blocker = (call: unknown): unknown => {
      if (call instanceof LLMCall) throw new Error('budget: blocked');
      return MISS;
    };
    addInterceptor(blocker);
    try {
      await expect(client.send(converse())).rejects.toThrow('budget: blocked');
    } finally {
      removeInterceptor(blocker);
    }
    expect(client.sent).toHaveLength(0); // NEGATIVE CONTROL: nothing reached the client
    expect(calls).toHaveLength(0);
  });

  it('applies a redact-before-send Reroute to the command the client receives', async () => {
    const client = instrument(fakeBedrock());
    const redactor = (call: unknown): unknown =>
      call instanceof LLMCall
        ? new Reroute({ messages: [{ role: 'user', content: [{ text: '[REDACTED]' }] }] })
        : MISS;
    addInterceptor(redactor);
    try {
      await client.send(converse());
    } finally {
      removeInterceptor(redactor);
    }
    expect(client.sent[0]).toMatchObject({
      messages: [{ role: 'user', content: [{ text: '[REDACTED]' }] }],
    });
    expect(calls[0].metadata.rerouted).toBe(true);
  });

  it('routes a downgrade onto modelId, not a stray model member (S2b)', async () => {
    const client = instrument(fakeBedrock());
    const downgrade = (call: unknown): unknown =>
      call instanceof LLMCall ? new Reroute({ model: 'eu.amazon.nova-2-micro-v1:0' }) : MISS;
    addInterceptor(downgrade);
    try {
      await client.send(converse());
    } finally {
      removeInterceptor(downgrade);
    }
    const sent = client.sent[0] as Record<string, unknown>;
    expect(sent.modelId).toBe('eu.amazon.nova-2-micro-v1:0'); // the provider actually downgrades
    expect(sent.model).toBeUndefined(); // and no member Converse does not have is sent
    expect(calls[0].model).toBe('eu.amazon.nova-2-micro-v1:0'); // records agree with the wire
  });

  it('leaves the command untouched when no interceptor rewrites anything', async () => {
    const client = instrument(fakeBedrock());
    const cmd = converse();
    const original = cmd.input;
    await client.send(cmd);
    expect(cmd.input).toBe(original); // object identity preserved — no gratuitous copy
  });
});

// --------------------------------------------------------------------------- the boto path (S2b)

describe('boto-shaped Bedrock: the downgrade fix applies there too', () => {
  it('routes a downgrade onto modelId on a converse() client', async () => {
    const sent: unknown[] = [];
    const client = instrument({
      converse: async (input: Record<string, unknown>) => {
        sent.push(structuredClone(input));
        return CONVERSE_RESPONSE;
      },
    });
    const downgrade = (call: unknown): unknown =>
      call instanceof LLMCall ? new Reroute({ model: 'eu.amazon.nova-2-micro-v1:0' }) : MISS;
    addInterceptor(downgrade);
    try {
      await client.converse({ ...INPUT });
    } finally {
      removeInterceptor(downgrade);
    }
    expect(sent[0]).toMatchObject({ modelId: 'eu.amazon.nova-2-micro-v1:0' });
    expect((sent[0] as Record<string, unknown>).model).toBeUndefined();
  });

  it('still writes model for a provider whose kwarg IS model', async () => {
    // NEGATIVE CONTROL for the mapping table: openai/anthropic/gemini/ollama must be unaffected.
    const sent: unknown[] = [];
    const client = instrument({
      chat: {
        completions: {
          create: async (kwargs: Record<string, unknown>) => {
            sent.push(structuredClone(kwargs));
            return { usage: { prompt_tokens: 11, completion_tokens: 7 }, choices: [] };
          },
        },
      },
    });
    const downgrade = (call: unknown): unknown =>
      call instanceof LLMCall ? new Reroute({ model: 'gpt-4o-mini' }) : MISS;
    addInterceptor(downgrade);
    try {
      await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    } finally {
      removeInterceptor(downgrade);
    }
    expect(sent[0]).toMatchObject({ model: 'gpt-4o-mini' });
    expect((sent[0] as Record<string, unknown>).modelId).toBeUndefined();
  });
});
