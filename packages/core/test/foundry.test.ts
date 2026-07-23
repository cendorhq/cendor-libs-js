// Foundry correlation adapter (GLR-11b1) — the scoped agent + conversation stamp. Fake clients whose
// run methods construct a bus event (as an instrumented call inside the scope would) let us assert the
// stamp lands. Attribution-only: no @azure/ai-agents at runtime (the adapter is duck-typed on .runs).
import { afterEach, describe, expect, it } from 'vitest';
import { _providerCount, _resetAmbient, applyAmbient } from '../src/ambient.js';
import { foundryAgentScope, observeFoundryAgents } from '../src/foundry.js';
import { LLMCall } from '../src/index.js';

afterEach(() => {
  _resetAmbient();
});

function callInScope(): LLMCall {
  const call = new LLMCall({ id: 'c1', provider: 'azure', model: 'gpt-4o', messages: [] });
  applyAmbient(call);
  return call;
}

// mirrors azure @azure/ai-agents RunsOperations: create(threadId, assistantId, options)
function fakeClient() {
  return {
    runs: {
      create(_threadId: string, _agentId: string) {
        return callInScope();
      },
      createAndPoll(_threadId: string, _agentId: string) {
        return callInScope();
      },
      createThreadAndRun(_agentId: string) {
        return callInScope();
      },
    },
  };
}

describe('foundryAgentScope', () => {
  it('stamps agent + conversation_id for the duration', () => {
    const call = foundryAgentScope('asst_123', 'thread_abc', () => callInScope());
    expect(call.metadata.agent).toBe('asst_123');
    expect(call.metadata.conversation_id).toBe('thread_abc');
  });

  it('clears after the scope exits', () => {
    foundryAgentScope('asst_123', 'thread_abc', () => undefined);
    const after = callInScope();
    expect(after.metadata.agent).toBeUndefined();
    expect(after.metadata.conversation_id).toBeUndefined();
  });

  it('persists across awaits (async scope)', async () => {
    const call = await foundryAgentScope('asst_9', 'thread_x', async () => {
      await Promise.resolve();
      return callInScope();
    });
    expect(call.metadata.agent).toBe('asst_9');
    expect(call.metadata.conversation_id).toBe('thread_x');
  });

  it('never overwrites explicit values', () => {
    const call = foundryAgentScope('asst_123', 'thread_abc', () => {
      const c = new LLMCall({ id: 'c1', provider: 'azure', model: 'gpt-4o', messages: [] });
      c.metadata.agent = 'explicit';
      applyAmbient(c);
      return c;
    });
    expect(call.metadata.agent).toBe('explicit');
    expect(call.metadata.conversation_id).toBe('thread_abc'); // still supplied (not pre-set)
  });
});

describe('observeFoundryAgents', () => {
  it('wraps create / createAndPoll and stamps from the args', () => {
    const client = observeFoundryAgents(fakeClient());
    const c1 = client.runs.create('thread_abc', 'asst_9') as LLMCall;
    expect(c1.metadata.agent).toBe('asst_9');
    expect(c1.metadata.conversation_id).toBe('thread_abc');
    const c2 = client.runs.createAndPoll('thread_y', 'asst_y') as LLMCall;
    expect(c2.metadata.agent).toBe('asst_y');
    expect(c2.metadata.conversation_id).toBe('thread_y');
  });

  it('createThreadAndRun stamps the agent (thread created server-side)', () => {
    const client = observeFoundryAgents(fakeClient());
    const c = client.runs.createThreadAndRun('asst_z') as LLMCall;
    expect(c.metadata.agent).toBe('asst_z');
    expect(c.metadata.conversation_id).toBeUndefined();
  });

  it('is idempotent + registers exactly one provider', () => {
    const client = fakeClient();
    observeFoundryAgents(client);
    observeFoundryAgents(client);
    const c = client.runs.create('t', 'a') as LLMCall;
    expect(c.metadata.agent).toBe('a');
    expect(_providerCount()).toBe(1);
  });

  it('registers nothing until attached', () => {
    expect(_providerCount()).toBe(0);
    foundryAgentScope('a', 't', () => undefined);
    expect(_providerCount()).toBe(1);
  });

  it('throws on a non-client', () => {
    expect(() => observeFoundryAgents({} as { runs?: undefined })).toThrow(TypeError);
  });
});
