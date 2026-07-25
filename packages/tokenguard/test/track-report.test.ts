/** Attribution: track(...) tags ambient spend; report(groupBy) aggregates it. Mirrors test_track_report.py. */
import { Dec } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as tokenguard from '../src/index.js';
import { report, track, useSink } from '../src/index.js';
import { OTelSink, SQLiteSink } from '../src/sinks.js';
import { callN, makeClient } from './_helpers.js';

describe('track / report', () => {
  beforeEach(() => tokenguard.reset());
  afterEach(() => tokenguard.reset());

  it('groups by tags', async () => {
    const client = makeClient();
    await track({ feature: 'support', user_id: 'alice' }, async () => {
      await callN(client);
    });
    await track({ feature: 'support', user_id: 'bob' }, async () => {
      await callN(client);
    });
    await track({ feature: 'billing', user_id: 'alice' }, async () => {
      await callN(client);
    });

    const byFeature = new Map(report(['feature']).rows.map((r) => [r.tags.feature, r]));
    expect(byFeature.get('support')!.calls).toBe(2);
    expect(byFeature.get('support')!.usd.amount.equals(new Dec('0.015'))).toBe(true);
    expect(byFeature.get('billing')!.calls).toBe(1);

    const rows = [...report(['feature', 'user_id'])];
    expect(rows.length).toBe(3); // support/alice, support/bob, billing/alice
  });

  it('reports total and tokens', async () => {
    const client = makeClient();
    await track({ feature: 'x' }, async () => {
      await callN(client);
      await callN(client);
    });
    const r = report(['feature']);
    expect(r.total().amount.equals(new Dec('0.015'))).toBe(true);
    expect(r.rows[0]!.tokens).toBe(3000); // (1000 + 500) * 2
  });

  it('nested track merges tags', async () => {
    const client = makeClient();
    await track({ feature: 'support' }, async () =>
      track({ user_id: 'alice' }, async () => {
        await callN(client);
      }),
    );
    const row = report(['feature', 'user_id']).rows[0]!;
    expect(row.tags).toEqual({ feature: 'support', user_id: 'alice' });
  });

  it('assertUnder passes and fails', async () => {
    const client = makeClient();
    await track({ feature: 'support' }, async () => {
      await callN(client); // $0.0075
    });
    const r = report(['feature']);
    expect(r.assertUnder(0.01, { feature: 'support' })).toBe(true);
    expect(() => r.assertUnder(0.001, { feature: 'support' })).toThrow(/exceeds cap/);
  });

  it('track.report is the report alias', () => {
    expect(track.report).toBe(report);
  });

  it('SQLiteSink persists each row', async () => {
    const sink = new SQLiteSink(':memory:');
    expect(typeof sink.write).toBe('function'); // satisfies the core Sink protocol by shape
    useSink(sink);
    try {
      const client = makeClient();
      await track({ feature: 'support', user_id: 'alice' }, async () => {
        await callN(client);
        await callN(client);
      });
    } finally {
      useSink(null);
    }

    const rows = sink.rows();
    expect(rows.length).toBe(2); // one persisted row per call
    const [tagsJson, usd, , , reasoning, model] = rows[0]!;
    expect(model).toBe('gpt-4o');
    expect(new Dec(usd).equals(new Dec('0.0075'))).toBe(true); // Decimal stored as a string
    expect(reasoning).toBe(0);
    expect(tagsJson.replace(/ /g, '')).toContain('"feature":"support"');
    sink.close();
  });

  it('OTelSink writes are silent when no meter provider is registered', () => {
    // (The absent-`@opentelemetry/api` path is the same `return` — see otel-sink-lazy.test.ts for the
    // full ordering matrix now that the sink acquires its meter lazily.)
    const sink = new OTelSink();
    expect(() =>
      sink.write({ tags: {}, usd: '0.01', input_tokens: 1, output_tokens: 1, model: 'gpt-4o' }),
    ).not.toThrow();
  });
});
