import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * Behavioral parity with cendor-cassette's Python suite (adapted to TS calling conventions:
 * instrumented clients are async; tools take positional args, not kwargs).
 */
import { bus, instrument, instrumentTool } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CassetteError,
  _drift,
  _hash,
  cosine,
  drift,
  embeddingScorer,
  localEmbeddingScorer,
  promote,
  semanticDrift,
  semanticMatch,
  use,
  using,
} from '../src/index.js';

let dir: string;
beforeEach(() => {
  bus._reset();
  dir = mkdtempSync(join(tmpdir(), 'cassette-'));
});
afterEach(() => {
  bus._reset();
  rmSync(dir, { recursive: true, force: true });
});
const p = (name: string) => join(dir, name);

// --------------------------------------------------------------------------- fakes

interface Counter {
  llm: number;
}

type Client = {
  chat: { completions: { create: (k: Record<string, unknown>) => Promise<unknown> } };
};

function makeClient(counter: Counter): Client {
  return instrument({
    chat: {
      completions: {
        create: async (_k: Record<string, unknown>) => {
          counter.llm += 1;
          return {
            choices: [{ message: { content: 'Sure, here is a refund.' } }],
            usage: { prompt_tokens: 12, completion_tokens: 8 },
          };
        },
      },
    },
  });
}

function clientReturning(text: string, counter: { n: number }): Client {
  return instrument({
    chat: {
      completions: {
        create: async (_k: Record<string, unknown>) => {
          counter.n += 1;
          return {
            choices: [{ message: { content: text } }],
            usage: { prompt_tokens: 5, completion_tokens: 5 },
          };
        },
      },
    },
  });
}

function clientFor(answer: string): Client {
  return instrument({
    chat: {
      completions: {
        create: async (_k: Record<string, unknown>) => ({
          choices: [{ message: { content: answer } }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        }),
      },
    },
  });
}

async function askContent(client: Client, model: string, content: string): Promise<string> {
  const resp = (await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content }],
  })) as { choices: Array<{ message: { content: string } }> };
  return resp.choices[0]!.message.content;
}

const delta = (text: string) => ({ choices: [{ delta: { content: text } }], usage: null });
const usageChunk = (pt: number, ct: number) => ({
  choices: [] as unknown[],
  usage: { prompt_tokens: pt, completion_tokens: ct },
});

function streamClient(chunks: unknown[]): Client {
  return instrument({
    chat: {
      completions: {
        create: async (_k: Record<string, unknown>) => {
          async function* gen(): AsyncGenerator<unknown> {
            for (const c of chunks) yield c;
          }
          return gen();
        },
      },
    },
  });
}

async function joinStream(client: Client, kwargs: Record<string, unknown>): Promise<string> {
  const stream = (await client.chat.completions.create(kwargs)) as AsyncIterable<{
    choices: Array<{ delta: { content: string } }>;
  }>;
  let out = '';
  for await (const c of stream) {
    if (c.choices && c.choices.length > 0) out += c.choices[0]!.delta.content;
  }
  return out;
}

// --------------------------------------------------------------------------- record / replay

describe('record then replay', () => {
  it('auto: records on first use, replays on second', async () => {
    const path = p('run.json');
    const counter: Counter = { llm: 0 };
    const runAgent = () => askContent(makeClient(counter), 'gpt-4o', 'I was double charged');

    const recorded = await use(path, { mode: 'auto' })(runAgent)();
    expect(recorded).toBe('Sure, here is a refund.');
    expect(counter.llm).toBe(1);
    expect(() => readFileSync(path, 'utf-8')).not.toThrow();

    counter.llm = 0;
    const replayed = await use(path, { mode: 'auto' })(runAgent)();
    expect(replayed).toBe('Sure, here is a refund.');
    expect(counter.llm).toBe(0);
  });

  it('using(): records then replays a block', async () => {
    const path = p('cm.json');
    const counter: Counter = { llm: 0 };
    const call = () => askContent(makeClient(counter), 'gpt-4o', 'double charged');

    const first = await using(path, { mode: 'auto' }, call);
    expect(first).toBe('Sure, here is a refund.');
    expect(counter.llm).toBe(1);

    counter.llm = 0;
    const second = await using(path, { mode: 'auto' }, call);
    expect(second).toBe('Sure, here is a refund.');
    expect(counter.llm).toBe(0);
  });

  it('replay of an unknown call raises CassetteError', async () => {
    const path = p('empty.json');
    writeFileSync(path, '{"version": 1, "entries": []}', 'utf-8');
    const counter: Counter = { llm: 0 };
    const run = () => askContent(makeClient(counter), 'gpt-4o', 'hi');
    await expect(use(path, { mode: 'replay' })(run)()).rejects.toBeInstanceOf(CassetteError);
  });

  it('records and replays tool calls (body skipped on replay)', async () => {
    const path = p('tools.json');
    const counter = { tool: 0 };
    const runAgent = () => {
      const search = instrumentTool('search')(async (query: string) => {
        counter.tool += 1;
        return { hits: [`doc about ${query}`] };
      }) as (q: string) => Promise<unknown>;
      return search('refunds');
    };

    const out1 = await use(path, { mode: 'auto' })(runAgent)();
    expect(out1).toEqual({ hits: ['doc about refunds'] });
    expect(counter.tool).toBe(1);

    counter.tool = 0;
    const out2 = await use(path, { mode: 'auto' })(runAgent)();
    expect(out2).toEqual({ hits: ['doc about refunds'] });
    expect(counter.tool).toBe(0);
  });
});

// --------------------------------------------------------------------------- redaction

describe('redaction', () => {
  it('scrubs secrets on record', async () => {
    const path = p('secret.json');
    const counter: Counter = { llm: 0 };
    await use(path, { mode: 'record' })(() =>
      askContent(makeClient(counter), 'gpt-4o', 'my key is sk-ABCDEFGH12345678 and a@b.com'),
    )();
    const text = readFileSync(path, 'utf-8');
    expect(text).not.toContain('sk-ABCDEFGH12345678');
    expect(text).not.toContain('a@b.com');
    expect(text).toContain('<redacted>');
  });

  it('scrubs modern secret formats', async () => {
    const path = p('secret2.json');
    const secrets = [
      'sk-ant-api03-ABCDEFGH12345678',
      'sk-proj-ABCDEFGH12345678',
      `AKIA${'A'.repeat(16)}`,
      `AIza${'b'.repeat(35)}`,
      `eyJ${'a'.repeat(15)}.${'b'.repeat(15)}.${'c'.repeat(15)}`,
    ];
    await use(path, { mode: 'record' })(() =>
      askContent(makeClient({ llm: 0 }), 'gpt-4o', secrets.join(' ')),
    )();
    const text = readFileSync(path, 'utf-8');
    for (const raw of secrets) expect(text).not.toContain(raw);
    expect(text).toContain('<redacted>');
  });

  it('does not scrub plain hyphenated prose', async () => {
    const path = p('plain.json');
    const sentence = 'a well-known best-practice for multi-region fail-over';
    await use(path, { mode: 'record' })(() =>
      askContent(makeClient({ llm: 0 }), 'gpt-4o', sentence),
    )();
    const text = readFileSync(path, 'utf-8');
    expect(text).toContain(sentence);
    expect(text).not.toContain('<redacted>');
  });

  it('redact:false preserves long ids verbatim', async () => {
    const path = p('raw.json');
    const longId = 'abcdef0123456789abcdef0123456789abcd'; // 36 chars — default would redact
    const client = instrument({
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: longId } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        },
      },
    });
    await use(path, { mode: 'record', redact: false })(() => askContent(client, 'gpt-4o', 'go'))();
    expect(readFileSync(path, 'utf-8')).toContain(longId);
  });

  it('redacts stored request but keeps a real sha256 hash', async () => {
    const path = p('sec.json');
    await use(path, { mode: 'record' })(() =>
      askContent(makeClient({ llm: 0 }), 'gpt-4o', 'token sk-ABCDEFGH12345678'),
    )();
    const payload = JSON.parse(readFileSync(path, 'utf-8'));
    const stored = JSON.stringify(payload.entries[0].request);
    expect(stored).not.toContain('sk-ABCDEFGH12345678');
    expect(payload.entries[0].request_hash).toHaveLength(64);
  });
});

// --------------------------------------------------------------------------- un-redacted hashing

describe('un-redacted hashing disambiguates', () => {
  it('distinct long-token requests replay to distinct entries (reversed order)', async () => {
    const path = p('collide.json');
    const tokA = 'A'.repeat(40);
    const tokB = 'B'.repeat(40);

    await use(path, { mode: 'record' })(async () => {
      await askContent(clientFor('answer A'), 'gpt-4o', `session ${tokA}`);
      await askContent(clientFor('answer B'), 'gpt-4o', `session ${tokB}`);
    })();

    const out: Record<string, string> = {};
    await use(path, { mode: 'replay' })(async () => {
      const live = clientFor('LIVE');
      out.b = await askContent(live, 'gpt-4o', `session ${tokB}`); // reversed
      out.a = await askContent(live, 'gpt-4o', `session ${tokA}`);
    })();
    expect(out.a).toBe('answer A');
    expect(out.b).toBe('answer B');
  });

  it('now-redacted modern tokens still hash + replay distinctly', async () => {
    const path = p('keys.json');
    const tokA = `sk-ant-api03-${'A'.repeat(20)}`;
    const tokB = `sk-ant-api03-${'B'.repeat(20)}`;

    await use(path, { mode: 'record' })(async () => {
      await askContent(clientFor('A'), 'gpt-4o', `key ${tokA}`);
      await askContent(clientFor('B'), 'gpt-4o', `key ${tokB}`);
    })();

    const stored = readFileSync(path, 'utf-8');
    expect(stored).not.toContain(tokA);
    expect(stored).not.toContain(tokB);
    const payload = JSON.parse(stored);
    const hashes = new Set(payload.entries.map((e: { request_hash: string }) => e.request_hash));
    expect(hashes.size).toBe(2);

    const out: Record<string, string> = {};
    await use(path, { mode: 'replay' })(async () => {
      const live = clientFor('LIVE');
      out.b = await askContent(live, 'gpt-4o', `key ${tokB}`);
      out.a = await askContent(live, 'gpt-4o', `key ${tokA}`);
    })();
    expect(out.a).toBe('A');
    expect(out.b).toBe('B');
  });
});

// --------------------------------------------------------------------------- promote

describe('promote', () => {
  it('promotes an llm JSONL trace to a replayable cassette', async () => {
    const trace = p('trace.jsonl');
    writeFileSync(
      trace,
      `${JSON.stringify({
        kind: 'llm',
        request: {
          provider: 'openai',
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
        },
        response: {
          choices: [{ message: { content: 'promoted answer' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      })}\n`,
      'utf-8',
    );
    const cass = p('from_trace.json');
    expect(promote(trace, cass)).toBe(1);

    const counter: Counter = { llm: 0 };
    const answer = await use(cass, { mode: 'replay' })(() =>
      askContent(makeClient(counter), 'gpt-4o', 'hi'),
    )();
    expect(answer).toBe('promoted answer');
    expect(counter.llm).toBe(0);
  });

  it('promotes a tool JSONL trace (positional args) and replays it', async () => {
    const trace = p('ttrace.jsonl');
    writeFileSync(
      trace,
      `${JSON.stringify({
        kind: 'tool',
        request: { name: 'search', arguments: { args: ['refund'], kwargs: {} } },
        response: { hits: 3 },
      })}\n`,
      'utf-8',
    );
    const cass = p('tool.json');
    expect(promote(trace, cass)).toBe(1);

    const ran = { n: 0 };
    const search = instrumentTool('search')(async (_q: string) => {
      ran.n += 1;
      return { hits: 999 };
    }) as (q: string) => Promise<unknown>;

    const result = await using(cass, { mode: 'replay' }, () => search('refund'));
    expect(result).toEqual({ hits: 3 });
    expect(ran.n).toBe(0);
  });
});

// --------------------------------------------------------------------------- rerecord

describe('rerecord', () => {
  it('detects drift without overwriting the cassette', async () => {
    const path = p('r.json');
    await use(path, { mode: 'record' })(() =>
      askContent(clientReturning('first answer', { n: 0 }), 'gpt-4o', 'q'),
    )();
    const before = readFileSync(path, 'utf-8');

    const live = { n: 0 };
    await use(path, { mode: 'rerecord' })(() =>
      askContent(clientReturning('second answer', live), 'gpt-4o', 'q'),
    )();

    expect(live.n).toBe(1); // rerecord ran the live client
    const d = drift();
    expect(d).toHaveLength(1);
    expect(d[0]!.kind).toBe('llm');
    expect(readFileSync(path, 'utf-8')).toBe(before); // NOT overwritten
  });
});

// --------------------------------------------------------------------------- pluggable normalizer

describe('pluggable normalizer', () => {
  it('ignores a volatile trailing token', async () => {
    const normalizer = (event: unknown) => {
      const anyEvent = event as {
        provider?: string;
        model?: string;
        messages?: Array<{ role: string; content: string }>;
        name?: string;
        arguments?: unknown;
      };
      if (anyEvent.messages) {
        const msgs = anyEvent.messages.map((m) => ({
          role: m.role,
          content: m.content.split('#')[0],
        }));
        return {
          kind: 'llm',
          provider: anyEvent.provider!,
          model: anyEvent.model!,
          messages: msgs,
        };
      }
      return { kind: 'tool', name: anyEvent.name!, arguments: anyEvent.arguments as never };
    };

    const path = p('norm.json');
    const counter: Counter = { llm: 0 };
    await use(path, { mode: 'record', normalizer })(() =>
      askContent(makeClient(counter), 'gpt-4o', 'hi #1'),
    )();

    counter.llm = 0;
    const out = await use(path, { mode: 'replay', normalizer })(() =>
      askContent(makeClient(counter), 'gpt-4o', 'hi #2'),
    )();
    expect(out).toBe('Sure, here is a refund.');
    expect(counter.llm).toBe(0);
  });
});

// --------------------------------------------------------------------------- semantic match

describe('semantic match + scorers', () => {
  it('lexical semanticMatch cases', () => {
    expect(semanticMatch('We can offer you a refund today', 'offer a refund')).toBe(true);
    expect(semanticMatch('identical', 'identical')).toBe(true);
    expect(semanticMatch('the sky is blue', 'process a tax return', 0.6)).toBe(false);
  });

  it('pluggable scorer', () => {
    expect(semanticMatch('anything', 'totally different', 0.6, () => 0.99)).toBe(true);
    expect(semanticMatch('identical', 'identical', 0.6, () => 0.0)).toBe(false);
  });

  it('cosine similarity', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1.0);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0.0);
    expect(cosine([], [1.0])).toBe(0.0);
  });

  it('embedding scorer with a BYO embed fn', () => {
    const vectors: Record<string, number[]> = {
      'refund issued': [1, 0, 0],
      'we processed your refund': [0.9, 0.1, 0],
      'the weather is sunny': [0, 0, 1],
    };
    const scorer = embeddingScorer((texts) => texts.map((t) => vectors[t]!));
    expect(semanticMatch('refund issued', 'we processed your refund', 0.6, scorer)).toBe(true);
    expect(semanticMatch('refund issued', 'the weather is sunny', 0.6, scorer)).toBe(false);
  });

  it('localEmbeddingScorer throws a helpful error (no bundled model in JS)', () => {
    expect(() => localEmbeddingScorer()).toThrow(/embedFn|embeddingScorer/);
  });

  it('semanticDrift filters reworded equivalents', () => {
    _drift.length = 0;
    _drift.push(
      {
        request_hash: 'a',
        kind: 'llm',
        recorded: 'Your refund has been processed successfully today',
        live: 'Your refund has been processed successfully today!',
      },
      {
        request_hash: 'b',
        kind: 'llm',
        recorded: 'Your refund has been processed',
        live: 'We are unable to offer a refund',
      },
    );
    const meaningful = semanticDrift(0.8);
    expect(meaningful).toHaveLength(1);
    expect(meaningful[0]!.request_hash).toBe('b');
    expect(meaningful[0]!.score as number).toBeLessThan(0.8);
    expect(drift()).toHaveLength(2);
  });
});

// --------------------------------------------------------------------------- response markers

describe('response type markers', () => {
  it('dict/plain-object response replays as a dict (marker "mapping")', async () => {
    const path = p('ollama.json');
    const client = instrument({
      chat: {
        completions: {
          create: async () => ({
            message: { content: 'local answer' },
            eval_count: 5,
            prompt_eval_count: 3,
          }),
        },
      },
    });
    const run = async () => {
      const resp = (await client.chat.completions.create({
        model: 'llama3',
        messages: [{ role: 'user', content: 'hi' }],
      })) as { message: { content: string } };
      return resp.message.content; // dict/index access
    };

    expect(await use(path, { mode: 'record' })(run)()).toBe('local answer');
    const payload = JSON.parse(readFileSync(path, 'utf-8'));
    expect(payload.entries[0].response_type).toBe('mapping');
    expect(await use(path, { mode: 'replay' })(run)()).toBe('local answer');
  });

  it('SDK-like class-instance response records marker "object"', async () => {
    const path = p('openai.json');
    class Resp {
      choices = [{ message: { content: 'Sure, here is a refund.' } }];
      usage = { prompt_tokens: 12, completion_tokens: 8 };
    }
    const client = instrument({
      chat: { completions: { create: async () => new Resp() } },
    });
    const run = () => askContent(client, 'gpt-4o', 'hi');

    expect(await use(path, { mode: 'record' })(run)()).toBe('Sure, here is a refund.');
    const payload = JSON.parse(readFileSync(path, 'utf-8'));
    expect(payload.entries[0].response_type).toBe('object');
    expect(await use(path, { mode: 'replay' })(run)()).toBe('Sure, here is a refund.');
  });
});

// --------------------------------------------------------------------------- streaming

describe('streaming', () => {
  it('records then replays a stream', async () => {
    const path = p('stream.json');
    const chunks = [delta('Hel'), delta('lo'), usageChunk(10, 5)];
    const run = () =>
      joinStream(streamClient(chunks), {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });

    expect(await use(path, { mode: 'record' })(run)()).toBe('Hello');
    expect(await use(path, { mode: 'replay' })(run)()).toBe('Hello');
  });

  it('records then replays a second stream via using()', async () => {
    const path = p('astream.json');
    const chunks = [delta('Wor'), delta('ld'), usageChunk(10, 5)];
    const run = () =>
      joinStream(streamClient(chunks), {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });

    await using(path, { mode: 'record' }, async () => {
      expect(await run()).toBe('World');
    });
    await using(path, { mode: 'replay' }, async () => {
      expect(await run()).toBe('World');
    });
  });

  it('stream and non-stream do not collide (v2, two hashes)', async () => {
    const path = p('mix.json');
    const streamChunks = [delta('streamed'), usageChunk(1, 1)];
    await use(path, { mode: 'record' })(async () => {
      await askContent(makeClient({ llm: 0 }), 'gpt-4o', 'hi');
      await joinStream(streamClient(streamChunks), {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
    })();
    const payload = JSON.parse(readFileSync(path, 'utf-8'));
    expect(payload.version).toBe(2);
    const hashes = new Set(payload.entries.map((e: { request_hash: string }) => e.request_hash));
    expect(hashes.size).toBe(2);
  });
});

// --------------------------------------------------------------------------- versioning

describe('versioning', () => {
  it('unknown version raises a clean error mentioning version', async () => {
    const path = p('future.json');
    writeFileSync(path, '{"version": 99, "entries": []}', 'utf-8');
    const run = () => askContent(makeClient({ llm: 0 }), 'gpt-4o', 'hi');
    await expect(use(path, { mode: 'replay' })(run)()).rejects.toThrow(/version/);
  });

  it('a v1 cassette (no stream, no response_type) still replays', async () => {
    const req = {
      kind: 'llm',
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const v1 = {
      version: 1,
      entries: [
        {
          seq: 0,
          kind: 'llm',
          request_hash: _hash(req),
          request: req,
          response: { choices: [{ message: { content: 'legacy answer' } }] },
        },
      ],
    };
    const path = p('v1.json');
    writeFileSync(path, JSON.stringify(v1), 'utf-8');

    const counter: Counter = { llm: 0 };
    const answer = await use(path, { mode: 'replay' })(() =>
      askContent(makeClient(counter), 'gpt-4o', 'hi'),
    )();
    expect(answer).toBe('legacy answer');
    expect(counter.llm).toBe(0);
  });
});

// --------------------------------------------------------------------------- concurrency

describe('session isolation', () => {
  it('nested using() record blocks do not contaminate each other', async () => {
    const p1 = p('c1.json');
    const p2 = p('c2.json');

    await using(p1, { mode: 'record' }, async () => {
      await askContent(makeClient({ llm: 0 }), 'gpt-4o', 'one');
      await using(p2, { mode: 'record' }, async () => {
        await askContent(makeClient({ llm: 0 }), 'gpt-4o', 'two');
      });
    });

    const e1 = JSON.parse(readFileSync(p1, 'utf-8')).entries;
    const e2 = JSON.parse(readFileSync(p2, 'utf-8')).entries;
    expect(e1).toHaveLength(1);
    expect(e1[0].request.messages[0].content).toBe('one');
    expect(e2).toHaveLength(1);
    expect(e2[0].request.messages[0].content).toBe('two');
  });

  it('concurrent using() blocks (Promise.all) capture only their own events', async () => {
    const p1 = p('x1.json');
    const p2 = p('x2.json');
    await Promise.all([
      using(p1, { mode: 'record' }, async () => {
        await askContent(clientFor('one'), 'gpt-4o', 'alpha');
      }),
      using(p2, { mode: 'record' }, async () => {
        await askContent(clientFor('two'), 'gpt-4o', 'beta');
      }),
    ]);
    const e1 = JSON.parse(readFileSync(p1, 'utf-8')).entries;
    const e2 = JSON.parse(readFileSync(p2, 'utf-8')).entries;
    expect(e1).toHaveLength(1);
    expect(e1[0].request.messages[0].content).toBe('alpha');
    expect(e2).toHaveLength(1);
    expect(e2[0].request.messages[0].content).toBe('beta');
  });
});
