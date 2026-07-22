/**
 * GLR-6 — acttrace reads run/decision context from the *event* (captured pre-flight), not delivery-
 * time ambient reads (F5/F6): a streamed call finalized outside the run/decision scope is still
 * chained under the right decision and joined to the right run; a BudgetEvent's traceId flows into
 * the audit entry's run_id (the monitor's dual-key join).
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bus, instrument, trace } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/index.js';

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

let dirCounter = 0;
function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), `acttrace-gl-${dirCounter++}-`)), 'audit.jsonl');
}
type Dict = Record<string, unknown>;

function streamingClient() {
  const chunks = [
    { choices: [{ delta: { content: 'hi' } }], usage: null },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
  return instrument({
    chat: { completions: { create: async () => chunks } },
  }) as unknown as {
    chat: { completions: { create: (p: unknown) => Promise<AsyncIterable<unknown>> } };
  };
}

describe('GLR-6 run/decision linkage', () => {
  it('a stream drained after the run + decision scopes keeps decision_id + run_id', async () => {
    const log = new AuditLog('s', { path: tmpFile() });
    const client = streamingClient();
    let stream: AsyncIterable<unknown> | undefined;
    let decisionId: string | undefined;
    await trace('run-1', async () => {
      await log.decision(async (d) => {
        decisionId = d.id;
        stream = await client.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'x' }],
          stream: true,
        });
        // not drained here — the run + decision scopes will have exited by drain time
      });
    });
    for await (const _chunk of stream as AsyncIterable<unknown>) {
      // drain out of scope
    }
    log.detach();
    const llm = log.entries.find((e) => e.type === 'llm_call');
    expect(llm).toBeDefined();
    const p = llm?.payload as Dict;
    // The 'decision' entry's id is what the llm_call must carry (RED before the fix: null / '').
    const decision = log.entries.find((e) => e.type === 'decision');
    expect(p.decision_id).toBe((decision?.payload as Dict).decision_id);
    expect(p.run_id).toBe('run-1');
    // sanity: decisionId captured
    expect(typeof decisionId).toBe('string');
  });

  it('a budget_event carries run_id from BudgetEvent.traceId', async () => {
    const path = tmpFile();
    const log = new AuditLog('s', { path });
    // Duck-typed BudgetEvent shape (no tokenguard import), emitted outside any trace scope: the
    // run link must come from the event's traceId, not the (empty) delivery-time currentTraceId().
    bus.emit({
      action: 'blocked',
      reason: 'cap',
      projectedUsd: '0.02',
      capUsd: '0.01',
      model: 'gpt-4o',
      tags: {},
      traceId: 'run-9',
    });
    log.detach();
    const rows = readFileSync(path, 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Dict);
    const be = rows.find((r) => (r.payload as Dict)?.action === 'blocked');
    expect(be).toBeDefined();
    expect((be?.payload as Dict).run_id).toBe('run-9');
  });
});
