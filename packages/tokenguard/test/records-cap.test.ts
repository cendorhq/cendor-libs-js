/** The in-memory spend buffer is bounded (FIFO). Mirrors test_records_cap.py. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as tokenguard from '../src/index.js';
import { configure, dropped, report } from '../src/index.js';
import { type FakeClient, makeClient } from './_helpers.js';

async function emit(client: FakeClient, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'x' }],
    });
  }
}

describe('records cap', () => {
  beforeEach(() => tokenguard.reset());
  afterEach(() => tokenguard.reset());

  it('evicts the oldest and counts drops', async () => {
    configure({ maxRecords: 5 });
    const client = makeClient({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
    await emit(client, 12);

    expect(report().total().amount.greaterThan(0)).toBe(true); // still aggregates the window
    expect(dropped()).toBe(7); // 12 calls, cap 5 → 7 oldest evicted
    expect(report([]).rows[0]!.calls).toBe(5); // buffer reflects only the retained 5 rows
  });

  it('is unbounded when the cap is disabled', async () => {
    configure({ maxRecords: null });
    const client = makeClient({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
    await emit(client, 20);
    expect(dropped()).toBe(0);
    expect(report([]).rows[0]!.calls).toBe(20);
  });

  it('reset restores the default cap and clears drops', async () => {
    configure({ maxRecords: 2 });
    const client = makeClient({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
    await emit(client, 5);
    expect(dropped()).toBe(3);

    tokenguard.reset();
    expect(dropped()).toBe(0); // cleared
    await emit(client, 5); // default cap is high → no drops
    expect(dropped()).toBe(0);
  });
});
