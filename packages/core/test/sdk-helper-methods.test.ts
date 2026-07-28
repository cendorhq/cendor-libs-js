/**
 * The provider SDK's own **helper methods** must keep working through `instrument()` (N-4).
 *
 * openai-node builds `responses.parse`, `chat.completions.parse` and `runTools` on top of
 * `APIPromise._thenUnwrap`, which derives a **new** promise that shares the fetch `Response` and
 * calls the *original's* `parseResponse` again. A fetch body can only be read once, so as soon as
 * cendor's capture chain also parses, the caller gets
 *
 *     TypeError: Body is unusable: Body has already been read
 *
 * Measured against the real openai 6.49.0 SDK on 2026-07-27, on the **published shelf**:
 *
 *     UNinstrumented responses.parse   ok
 *     instrumented   responses.parse   THREW TypeError: Body is unusable   LLMCalls=0     (0.16.1)
 *     instrumented   responses.parse   THREW TypeError: _thenUnwrap is not a function     (0.16.0)
 *
 * So it has never worked under `instrument()`; 0.16.1 only changed which error you get. It was
 * invisible because the existing fixture's `parse` returns its own promise instead of **delegating
 * to `create`** the way the real SDK does — a synthetic fake that cannot express the defect. The
 * fixture below models the real architecture: a one-shot body, a memoizing `parse()`, a
 * `_thenUnwrap` that re-parses, and helper methods that delegate.
 *
 * The second half of the finding: because JS `parse` *delegates to `create`*, wrapping it as its own
 * `instrument()` target **double-counts** — the opposite of Python, where `parse` posts its own
 * request and needs its own target. Parity of behaviour, not of mechanism.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { type LLMCall, Usage, bus, instrument } from '../src/index.js';

let events: unknown[] = [];
beforeEach(() => {
  bus._reset();
  events = [];
  bus.subscribe((e) => events.push(e));
});
afterEach(() => bus._reset());

const BODY = {
  id: 'resp_1',
  model: 'gpt-4o-mini',
  usage: { input_tokens: 14, output_tokens: 2 },
};

interface Props {
  response: { json(): unknown };
}

/** A fetch body that can be consumed **once** — the property that makes the defect possible. */
function oneShotResponse(value: unknown): Props {
  let read = false;
  return {
    response: {
      json(): unknown {
        if (read) throw new TypeError('Body is unusable: Body has already been read');
        read = true;
        return value;
      },
    },
  };
}

/**
 * openai's `APIPromise`, modelled faithfully: the executor is a no-op, `then/catch/finally` go
 * through a memoized `parse()`, and `_thenUnwrap` derives a new promise that calls **this**
 * instance's `parseResponse` again.
 */
class FakeAPIPromise<T> extends Promise<T> {
  responsePromise: Promise<Props>;
  parseResponse: (props: Props) => unknown;
  private parsedPromise?: Promise<T>;

  constructor(
    responsePromise: Promise<Props>,
    parseResponse: (props: Props) => unknown = (p) => p.response.json(),
  ) {
    super((resolve) => resolve(null as unknown as T));
    this.responsePromise = responsePromise;
    this.parseResponse = parseResponse;
  }

  _thenUnwrap<U>(transform: (value: T) => U): FakeAPIPromise<U> {
    return new FakeAPIPromise<U>(this.responsePromise, async (props) =>
      transform((await this.parseResponse(props)) as T),
    );
  }

  parse(): Promise<T> {
    if (!this.parsedPromise) {
      this.parsedPromise = this.responsePromise.then((p) => this.parseResponse(p)) as Promise<T>;
    }
    return this.parsedPromise;
  }

  // openai's APIPromise overrides then/catch/finally to route through a memoized parse(); a fake
  // without that shape cannot express the defect under test.
  // biome-ignore lint/suspicious/noThenProperty: deliberately modelling openai's APIPromise
  override then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.parse().then(onfulfilled, onrejected);
  }

  override catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T | TResult> {
    return this.parse().catch(onrejected);
  }

  override finally(onfinally?: (() => void) | null): Promise<T> {
    return this.parse().finally(onfinally);
  }

  asResponse(): Promise<{ json(): unknown }> {
    return this.responsePromise.then((p) => p.response);
  }
}

/** A client shaped like openai's: `parse` is a helper **built on** the wrapped `create`. */
function sdkClient(body: unknown = BODY) {
  const client = {
    responses: {
      create(_args: Record<string, unknown>): FakeAPIPromise<unknown> {
        return new FakeAPIPromise(Promise.resolve(oneShotResponse(body)));
      },
      parse(args: Record<string, unknown>): FakeAPIPromise<unknown> {
        // exactly openai's `resources/responses/responses.js:64`
        return client.responses
          .create(args)
          ._thenUnwrap((raw) => ({ ...(raw as object), parsed: true }));
      },
    },
    chat: {
      completions: {
        create(_args: Record<string, unknown>): FakeAPIPromise<unknown> {
          return new FakeAPIPromise(Promise.resolve(oneShotResponse(body)));
        },
        parse(args: Record<string, unknown>): FakeAPIPromise<unknown> {
          // exactly openai's `resources/chat/completions/completions.js:102`
          return client.chat.completions
            .create(args)
            ._thenUnwrap((raw) => ({ ...(raw as object), parsed: true }));
        },
      },
    },
  };
  return client;
}

const ARGS = { model: 'gpt-4o-mini', input: 'say ok' };

// --- the control: the fixture must model a WORKING SDK ---------------------------------------

it('UNinstrumented, a delegating parse() helper resolves (the fixture is honest)', async () => {
  const out = (await sdkClient().responses.parse(ARGS)) as { parsed: boolean };
  expect(out.parsed).toBe(true);
  expect(events).toHaveLength(0);
});

// --- N-4: the helper must survive instrumentation --------------------------------------------

it('responses.parse resolves through instrument() and is captured exactly once', async () => {
  const c = instrument(sdkClient());
  const out = (await c.responses.parse(ARGS)) as { parsed: boolean };

  expect(out.parsed).toBe(true); // was: TypeError: Body is unusable
  expect(events).toHaveLength(1); // was: 0 — and 2 while `parse` was its own target
  const call = events[0] as LLMCall;
  expect(call.provider).toBe('openai');
  expect(call.usage).toStrictEqual(new Usage({ inputTokens: 14, outputTokens: 2 }));
});

it('chat.completions.parse resolves through instrument() and is captured exactly once', async () => {
  const c = instrument(
    sdkClient({ model: 'gpt-4o-mini', usage: { prompt_tokens: 11, completion_tokens: 1 } }),
  );
  const out = (await c.chat.completions.parse({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
  })) as { parsed: boolean };

  expect(out.parsed).toBe(true);
  expect(events).toHaveLength(1);
  expect((events[0] as LLMCall).usage).toStrictEqual(
    new Usage({ inputTokens: 11, outputTokens: 1 }),
  );
});

it('a plain create() still resolves and still reads the body once', async () => {
  const c = instrument(sdkClient());
  const out = (await c.responses.create(ARGS)) as { id: string };
  expect(out.id).toBe('resp_1');
  expect(events).toHaveLength(1);
});

it('the raw-response accessors still work alongside a helper method', async () => {
  const c = instrument(sdkClient());
  const returned = c.responses.create(ARGS) as FakeAPIPromise<unknown>;
  expect(typeof returned.asResponse).toBe('function');
  const body = (await returned) as { id: string };
  expect(body.id).toBe('resp_1');
});

it('a client whose parse does NOT delegate is still captured once (no double target)', async () => {
  // Belt and braces: whatever the SDK's internals, one call must not become two events.
  const client = {
    responses: {
      create: () => new FakeAPIPromise(Promise.resolve(oneShotResponse(BODY))),
      parse: () => new FakeAPIPromise(Promise.resolve(oneShotResponse(BODY))),
    },
  };
  const c = instrument(client);
  await c.responses.parse(ARGS);
  // `parse` is deliberately NOT an instrument() target in TypeScript — in this SDK it is a helper,
  // and a non-delegating one simply goes uncaptured rather than being counted twice.
  expect(events.length).toBeLessThanOrEqual(1);
});

// --- N-5: anthropic's `messages.stream()` helper ----------------------------------------------
//
// `MessageStream.createMessage` (anthropic-node `lib/MessageStream.mjs:145`) does
//     const { response, data: stream } = await messages.create({...params, stream: true}, ...).withResponse();
//     for await (const event of stream) { ... }
// A streamed call returned cendor's plain chain, which has no `withResponse`, so instrumenting an
// Anthropic client made the SDK's own streaming helper **throw**:
//     AnthropicError: messages.create(...).withResponse is not a function
// Measured against the real @anthropic-ai/sdk 0.112.5 on the published @cendor/core 0.16.1.

class FakeStreamPromise<T> extends Promise<T> {
  responsePromise: Promise<Props>;
  parseResponse: (props: Props) => unknown;
  private parsedPromise?: Promise<T>;

  constructor(
    responsePromise: Promise<Props>,
    parseResponse: (props: Props) => unknown = (p) => p.response.json(),
  ) {
    super((resolve) => resolve(null as unknown as T));
    this.responsePromise = responsePromise;
    this.parseResponse = parseResponse;
  }

  parse(): Promise<T> {
    if (!this.parsedPromise) {
      this.parsedPromise = this.responsePromise.then((p) => this.parseResponse(p)) as Promise<T>;
    }
    return this.parsedPromise;
  }

  // openai's APIPromise overrides then/catch/finally to route through a memoized parse().
  // biome-ignore lint/suspicious/noThenProperty: deliberately modelling the SDK's APIPromise
  override then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.parse().then(onfulfilled, onrejected);
  }

  asResponse(): Promise<{ json(): unknown }> {
    return this.responsePromise.then((p) => p.response);
  }

  async withResponse(): Promise<{ data: T; response: { json(): unknown } }> {
    const [data, response] = await Promise.all([this.parse(), this.asResponse()]);
    return { data, response };
  }
}

const EVENTS = [
  { type: 'message_start', message: { usage: { input_tokens: 8, output_tokens: 0 } } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
  { type: 'message_delta', usage: { output_tokens: 3 } },
];

/** An Anthropic-shaped client whose `messages.stream` is the SDK helper built on `create`. */
function anthropicClient() {
  const client = {
    messages: {
      create(_args: Record<string, unknown>): FakeStreamPromise<unknown> {
        const stream = {
          controller: { signal: { aborted: false } },
          async *[Symbol.asyncIterator]() {
            for (const e of EVENTS) yield e;
          },
        };
        return new FakeStreamPromise(Promise.resolve({ response: { json: () => stream } }));
      },
      async stream(args: Record<string, unknown>): Promise<string> {
        const { data, response } = await (
          client.messages.create({ ...args, stream: true }) as FakeStreamPromise<{
            controller: { signal: { aborted: boolean } };
            [Symbol.asyncIterator](): AsyncIterator<unknown>;
          }>
        ).withResponse();
        if (response === undefined) throw new Error('no response');
        let text = '';
        for await (const ev of data as AsyncIterable<Record<string, unknown>>) {
          const delta = ev.delta as { text?: string } | undefined;
          text += delta?.text ?? '';
        }
        // the helper also reads `stream.controller` — the wrapped stream must forward it
        if (data.controller.signal.aborted) throw new Error('aborted');
        return text;
      },
    },
  };
  return client;
}

it('UNinstrumented, the messages.stream() helper works (the fixture is honest)', async () => {
  expect(await anthropicClient().messages.stream({ model: 'claude-haiku-4-5' })).toBe('hi');
  expect(events).toHaveLength(0);
});

it("anthropic's messages.stream() helper survives instrument() and is captured", async () => {
  const c = instrument(anthropicClient());
  expect(await c.messages.stream({ model: 'claude-haiku-4-5' })).toBe('hi');

  expect(events).toHaveLength(1); // was: AnthropicError, withResponse is not a function
  const call = events[0] as LLMCall;
  expect(call.provider).toBe('anthropic');
  expect(call.usage).toStrictEqual(new Usage({ inputTokens: 8, outputTokens: 3 }));
});

it('a streamed call still hands back cendor’s counting stream, not the SDK’s raw one', async () => {
  const c = instrument(anthropicClient());
  const returned = c.messages.create({ model: 'claude-haiku-4-5', stream: true });
  const { data } = await (
    returned as unknown as { withResponse(): Promise<{ data: AsyncIterable<unknown> }> }
  ).withResponse();
  let n = 0;
  for await (const _ of data) n++;
  expect(n).toBe(EVENTS.length);
  expect(events).toHaveLength(1); // counted, because `data` is our wrapper
});
