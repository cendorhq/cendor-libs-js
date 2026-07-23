// openai-agents adapter (GLR-11c) — the scoped agent-name stamp. A fake EventEmitter drives the
// SDK's lifecycle events in order; the adapter's AsyncLocalStorage scope must land metadata.agent on
// events constructed inside a turn. No @openai/agents at runtime — the adapter is structurally typed.
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { _providerCount, _resetAmbient, applyAmbient } from '../src/ambient.js';
import { LLMCall } from '../src/index.js';
import { _currentAgent, observeOpenAIAgents } from '../src/openai-agents.js';

afterEach(() => {
  _resetAmbient();
});

function providerCount(): number {
  return _providerCount();
}

function modelCall(): LLMCall {
  const call = new LLMCall({ id: 'c1', provider: 'openai', model: 'gpt-4o', messages: [] });
  applyAmbient(call);
  return call;
}

/** A minimal stand-in for the SDK's Runner/Agent event emitter (has `.on` / `.off`). */
class FakeRunner extends EventEmitter {}
const agent = (name: string) => ({ name });

describe('observeOpenAIAgents', () => {
  it('stamps the agent name for the duration of a turn', () => {
    const runner = new FakeRunner();
    observeOpenAIAgents(runner as unknown as { on: FakeRunner['on'] });
    runner.emit('agent_start', {}, agent('Billing'));
    const call = modelCall();
    runner.emit('agent_end', {}, agent('Billing'), 'done');
    expect(call.metadata.agent).toBe('Billing');
  });

  it('re-stamps on handoff to the next agent', () => {
    const runner = new FakeRunner();
    observeOpenAIAgents(runner as unknown as { on: FakeRunner['on'] });
    runner.emit('agent_start', {}, agent('Triage'));
    const first = modelCall();
    runner.emit('agent_handoff', {}, agent('Triage'), agent('Refunds')); // Runner payload: (ctx, from, to)
    const second = modelCall();
    expect(first.metadata.agent).toBe('Triage');
    expect(second.metadata.agent).toBe('Refunds');
  });

  it('handles the Agent-level handoff payload (ctx, nextAgent)', () => {
    const a = new FakeRunner();
    observeOpenAIAgents(a as unknown as { on: FakeRunner['on'] });
    a.emit('agent_start', {}, agent('Alpha'));
    a.emit('agent_handoff', {}, agent('Beta')); // Agent payload: (ctx, next) — last named arg wins
    expect(_currentAgent()).toBe('Beta');
  });

  it('clears the stamp after agent end', () => {
    const runner = new FakeRunner();
    observeOpenAIAgents(runner as unknown as { on: FakeRunner['on'] });
    runner.emit('agent_start', {}, agent('Billing'));
    runner.emit('agent_end', {}, agent('Billing'), 'done');
    const call = modelCall();
    expect(call.metadata.agent).toBeUndefined();
  });

  it('never overwrites an explicit agent', () => {
    const runner = new FakeRunner();
    observeOpenAIAgents(runner as unknown as { on: FakeRunner['on'] });
    runner.emit('agent_start', {}, agent('Billing'));
    const call = new LLMCall({ id: 'c1', provider: 'openai', model: 'gpt-4o', messages: [] });
    call.metadata.agent = 'explicit';
    applyAmbient(call);
    expect(call.metadata.agent).toBe('explicit');
  });

  it('registers nothing on import; observe registers exactly one (idempotent) provider', () => {
    expect(providerCount()).toBe(0);
    const r1 = new FakeRunner();
    observeOpenAIAgents(r1 as unknown as { on: FakeRunner['on'] });
    expect(providerCount()).toBe(1);
    const r2 = new FakeRunner();
    observeOpenAIAgents(r2 as unknown as { on: FakeRunner['on'] });
    expect(providerCount()).toBe(1); // same provider function — deduped
  });

  it('the disposer removes the listeners', () => {
    const runner = new FakeRunner();
    const dispose = observeOpenAIAgents(
      runner as unknown as { on: FakeRunner['on']; off: FakeRunner['off'] },
    );
    expect(runner.listenerCount('agent_start')).toBe(1);
    dispose();
    expect(runner.listenerCount('agent_start')).toBe(0);
    expect(runner.listenerCount('agent_handoff')).toBe(0);
    expect(runner.listenerCount('agent_end')).toBe(0);
  });
});
