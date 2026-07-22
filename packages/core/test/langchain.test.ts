import type { Serialized } from '@langchain/core/load/serializable';
import type { LLMResult } from '@langchain/core/outputs';
import { afterEach, describe, expect, it } from 'vitest';
import { _resetAmbient } from '../src/ambient.js';
import { LLMCall, ToolCall, addAmbientProvider, bus, prices } from '../src/index.js';
import { CendorCallbackHandler } from '../src/langchain.js';

/** Collect every event emitted on the bus for the duration of a test. */
function collect(): { events: unknown[]; stop: () => void } {
  const events: unknown[] = [];
  const sub = (e: unknown) => events.push(e);
  bus.subscribe(sub);
  return { events, stop: () => bus.unsubscribe(sub) };
}

/** A chat-model `LLMResult` carrying `usage_metadata` (as `@langchain/openai` produces). */
function chatResult(
  usageMetadata: Record<string, unknown>,
  modelName?: string,
  llmOutput?: Record<string, unknown>,
): LLMResult {
  return {
    generations: [
      [
        {
          text: 'hi',
          message: {
            usage_metadata: usageMetadata,
            response_metadata: modelName ? { model_name: modelName } : {},
          },
        },
      ],
    ],
    llmOutput: llmOutput ?? {},
  } as unknown as LLMResult;
}

const tool = (name: string): Serialized => ({ name }) as unknown as Serialized;

describe('CendorCallbackHandler', () => {
  afterEach(() => {
    bus._reset();
    prices._reset();
    _resetAmbient();
  });

  it('is a valid LangChain callback handler (duck-typed accept)', () => {
    const h = new CendorCallbackHandler();
    // LangChain accepts handlers via `copy`/`name`/`awaitHandlers`, not instanceof.
    expect(typeof h.copy).toBe('function');
    expect(typeof h.name).toBe('string');
    expect(h.name).toBe('CendorCallbackHandler');
    expect(typeof (h as { awaitHandlers: unknown }).awaitHandlers).toBe('boolean');
  });

  it('copy() returns the same instance so correlation state is shared', () => {
    const h = new CendorCallbackHandler();
    expect(h.copy()).toBe(h);
  });

  it('handleLLMEnd emits one LLMCall with usage, reasoning/cache breakdowns, and cost', () => {
    const { events, stop } = collect();
    const h = new CendorCallbackHandler();
    h.handleLLMEnd(
      chatResult(
        {
          input_tokens: 1000,
          output_tokens: 200,
          total_tokens: 1200,
          input_token_details: { cache_read: 100, cache_creation: 50 },
          output_token_details: { reasoning: 40 },
        },
        undefined,
        { model_name: 'gpt-4o' },
      ),
      'run-1',
    );
    stop();

    const calls = events.filter((e): e is LLMCall => e instanceof LLMCall);
    expect(calls).toHaveLength(1);
    const call = calls[0] as LLMCall;
    expect(call.provider).toBe('langchain');
    expect(call.model).toBe('gpt-4o');
    expect(call.messages).toEqual([]);
    expect(call.metadata.source).toBe('langchain');
    expect(call.metadata.cost_estimated).toBe(true);

    expect(call.usage).not.toBeNull();
    const u = call.usage as NonNullable<typeof call.usage>;
    expect(u.inputTokens).toBe(1000);
    expect(u.outputTokens).toBe(200);
    expect(u.cachedTokens).toBe(100);
    expect(u.reasoningTokens).toBe(40);
    expect(u.cacheWrite).toBe(50);

    // Cost matches an offline estimate for the same usage — cached ⊆ input, cacheWrite billed apart.
    const expected = prices.estimate('gpt-4o', 1000, {
      outputTokens: 200,
      cachedTokens: 100,
      cacheWriteTokens: 50,
    });
    expect(call.cost).not.toBeNull();
    expect((call.cost as NonNullable<typeof call.cost>).eq(expected)).toBe(true);
  });

  it('reads the model from a generation response_metadata when llmOutput lacks it', () => {
    const { events, stop } = collect();
    const h = new CendorCallbackHandler();
    h.handleLLMEnd(chatResult({ input_tokens: 10, output_tokens: 5 }, 'gpt-4o-mini'), 'run-2');
    stop();
    const call = events.find((e): e is LLMCall => e instanceof LLMCall) as LLMCall;
    expect(call.model).toBe('gpt-4o-mini');
  });

  it('falls back to llmOutput.tokenUsage (camelCase) when no usage_metadata is present', () => {
    const { events, stop } = collect();
    const h = new CendorCallbackHandler();
    const result = {
      generations: [[{ text: 'hi' }]],
      llmOutput: {
        model_name: 'gpt-4o',
        tokenUsage: { promptTokens: 30, completionTokens: 12, totalTokens: 42 },
      },
    } as unknown as LLMResult;
    h.handleLLMEnd(result, 'run-3');
    stop();
    const call = events.find((e): e is LLMCall => e instanceof LLMCall) as LLMCall;
    const u = call.usage as NonNullable<typeof call.usage>;
    expect(u.inputTokens).toBe(30);
    expect(u.outputTokens).toBe(12);
  });

  it('leaves cost null for an unknown model without throwing', () => {
    const { events, stop } = collect();
    const h = new CendorCallbackHandler();
    h.handleLLMEnd(
      chatResult({ input_tokens: 10, output_tokens: 5 }, undefined, {
        model_name: 'totally-made-up-model',
      }),
      'run-4',
    );
    stop();
    const call = events.find((e): e is LLMCall => e instanceof LLMCall) as LLMCall;
    expect(call.model).toBe('totally-made-up-model');
    expect(call.cost).toBeNull();
    expect(call.metadata.cost_estimated).toBeUndefined();
  });

  it('handleLLMError records a failed call with the error on metadata', () => {
    const { events, stop } = collect();
    const h = new CendorCallbackHandler();
    h.handleLLMError(new Error('rate limited'), 'run-5');
    stop();
    const call = events.find((e): e is LLMCall => e instanceof LLMCall) as LLMCall;
    expect(call.model).toBe('');
    expect(call.usage).toBeNull();
    expect(call.metadata.source).toBe('langchain');
    expect(call.metadata.error).toBe('rate limited');
  });

  it('bridges handleToolStart -> handleToolEnd into a ToolCall', () => {
    const { events, stop } = collect();
    const h = new CendorCallbackHandler();
    h.handleToolStart(tool('search'), 'weather in NYC', 'tool-1');
    h.handleToolEnd('sunny, 72F', 'tool-1');
    stop();
    const tcs = events.filter((e): e is ToolCall => e instanceof ToolCall);
    expect(tcs).toHaveLength(1);
    const tc = tcs[0] as ToolCall;
    expect(tc.name).toBe('search');
    expect(tc.arguments).toEqual({ input: 'weather in NYC' });
    expect(tc.result).toBe('sunny, 72F');
    expect(tc.metadata.source).toBe('langchain');
  });

  it('handleToolError emits a ToolCall marking the failure', () => {
    const { events, stop } = collect();
    const h = new CendorCallbackHandler();
    h.handleToolStart(tool('search'), 'q', 'tool-2');
    h.handleToolError(new Error('tool blew up'), 'tool-2');
    stop();
    const tc = events.find((e): e is ToolCall => e instanceof ToolCall) as ToolCall;
    expect(tc.name).toBe('search');
    expect(tc.metadata.error).toBe('tool blew up');
    expect(tc.result).toBeNull();
  });

  it('correlates nested runs under one root traceId', () => {
    const { events, stop } = collect();
    const h = new CendorCallbackHandler();
    // root chain -> child node -> (chat model, tool) — parentRunId is the 8th arg for chains.
    h.handleChainStart({} as Serialized, {}, 'root');
    h.handleChainStart(
      {} as Serialized,
      {},
      'node',
      undefined,
      undefined,
      undefined,
      undefined,
      'root',
    );
    h.handleChatModelStart({} as Serialized, [], 'llm-1', 'node');
    h.handleLLMEnd(chatResult({ input_tokens: 5, output_tokens: 3 }, 'gpt-4o'), 'llm-1', 'node');
    h.handleToolStart(tool('calc'), '2+2', 'tool-x', 'node');
    h.handleToolEnd('4', 'tool-x', 'node');
    stop();

    const call = events.find((e): e is LLMCall => e instanceof LLMCall) as LLMCall;
    const tc = events.find((e): e is ToolCall => e instanceof ToolCall) as ToolCall;
    expect(call.traceId).toBe('root');
    expect(tc.traceId).toBe('root');
  });

  it('a standalone model call uses its own run id as traceId', () => {
    const { events, stop } = collect();
    const h = new CendorCallbackHandler();
    h.handleChatModelStart({} as Serialized, [], 'solo');
    h.handleLLMEnd(chatResult({ input_tokens: 1, output_tokens: 1 }, 'gpt-4o'), 'solo');
    stop();
    const call = events.find((e): e is LLMCall => e instanceof LLMCall) as LLMCall;
    expect(call.traceId).toBe('solo');
  });

  it('recording never breaks the app even if a subscriber throws', () => {
    const h = new CendorCallbackHandler();
    bus.subscribe(() => {
      throw new Error('subscriber boom');
    });
    // The handler swallows the bus error internally — no throw escapes.
    expect(() =>
      h.handleLLMEnd(chatResult({ input_tokens: 1, output_tokens: 1 }, 'gpt-4o'), 'run-x'),
    ).not.toThrow();
  });

  // --- GLR-11a: agent/chain/node names onto metadata.agent -------------------------------------

  it('stamps a LangGraph node name (metadata.langgraph_node) onto metadata.agent', () => {
    const { events, stop } = collect();
    const h = new CendorCallbackHandler();
    // A node chain carrying the LangGraph node name in metadata, with a chat model under it.
    h.handleChainStart(
      {} as Serialized,
      {},
      'node',
      undefined,
      undefined,
      { langgraph_node: 'researcher' },
      undefined,
      undefined, // root
    );
    h.handleChatModelStart({} as Serialized, [], 'llm-1', 'node');
    h.handleLLMEnd(chatResult({ input_tokens: 5, output_tokens: 3 }, 'gpt-4o'), 'llm-1', 'node');
    stop();
    const call = events.find((e): e is LLMCall => e instanceof LLMCall) as LLMCall;
    expect(call.metadata.agent).toBe('researcher');
  });

  it('falls back to the run name when no explicit/node metadata is present', () => {
    const { events, stop } = collect();
    const h = new CendorCallbackHandler();
    h.handleChatModelStart(
      {} as Serialized,
      [],
      'solo',
      undefined,
      undefined,
      undefined,
      undefined,
      'summarizer', // runName
    );
    h.handleLLMEnd(chatResult({ input_tokens: 1, output_tokens: 1 }, 'gpt-4o'), 'solo');
    stop();
    const call = events.find((e): e is LLMCall => e instanceof LLMCall) as LLMCall;
    expect(call.metadata.agent).toBe('summarizer');
  });

  it('explicit metadata.agent wins over the node name / run name', () => {
    const { events, stop } = collect();
    const h = new CendorCallbackHandler();
    h.handleChatModelStart(
      {} as Serialized,
      [],
      'solo',
      undefined, // parentRunId
      undefined, // extraParams
      undefined, // tags
      { agent: 'explicit-agent', langgraph_node: 'researcher' }, // metadata (7th)
      'summarizer', // runName
    );
    h.handleLLMEnd(chatResult({ input_tokens: 1, output_tokens: 1 }, 'gpt-4o'), 'solo');
    stop();
    const call = events.find((e): e is LLMCall => e instanceof LLMCall) as LLMCall;
    expect(call.metadata.agent).toBe('explicit-agent');
  });

  it('an unnamed plain chain stamps no agent (no RunnableSequence noise)', () => {
    const { events, stop } = collect();
    const h = new CendorCallbackHandler();
    h.handleChatModelStart({} as Serialized, [], 'solo');
    h.handleLLMEnd(chatResult({ input_tokens: 1, output_tokens: 1 }, 'gpt-4o'), 'solo');
    stop();
    const call = events.find((e): e is LLMCall => e instanceof LLMCall) as LLMCall;
    expect(call.metadata.agent).toBeUndefined();
  });

  it('the handler-derived agent is not overwritten by an ambient provider (specific wins)', () => {
    const { events, stop } = collect();
    addAmbientProvider(() => ({ agent: 'ambient-agent' }));
    const h = new CendorCallbackHandler();
    h.handleChatModelStart(
      {} as Serialized,
      [],
      'solo',
      undefined, // parentRunId
      undefined, // extraParams
      undefined, // tags
      { agent: 'node-agent' }, // metadata (7th)
      undefined, // runName
    );
    h.handleLLMEnd(chatResult({ input_tokens: 1, output_tokens: 1 }, 'gpt-4o'), 'solo');
    stop();
    const call = events.find((e): e is LLMCall => e instanceof LLMCall) as LLMCall;
    expect(call.metadata.agent).toBe('node-agent');
  });
});
