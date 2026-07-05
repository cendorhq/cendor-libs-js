/**
 * QueueSink moves durable sink I/O off the hot path; Sink.flush/close are optional. Mirrors
 * test_queue_sink.py, adapted to Node's single-threaded async drain loop (a daemon thread in
 * Python). `write` becomes async under bounded back-pressure, and the Python context-manager case
 * is expressed as try/finally + close().
 */
import { LLMCall, Usage, bus } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as tokenguard from '../src/index.js';
import { useSink } from '../src/index.js';
import { QueueSink, SQLiteSink } from '../src/sinks.js';
import { range } from './_helpers.js';

class ListSink {
  rows: unknown[] = [];
  write(entry: unknown): void {
    this.rows.push(entry);
  }
}

class LifecycleSink extends ListSink {
  flushed = 0;
  closed = 0;
  flush(): void {
    this.flushed += 1;
  }
  close(): void {
    this.closed += 1;
  }
}

class SlowSink {
  rows: unknown[] = [];
  async write(entry: unknown): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50)); // 50ms of "durable I/O" per row
    this.rows.push(entry);
  }
}

describe('QueueSink', () => {
  beforeEach(() => {
    bus._reset();
    tokenguard.reset();
  });
  afterEach(() => {
    bus._reset();
    tokenguard.reset();
  });

  it('drains on close in order', async () => {
    const inner = new ListSink();
    const q = new QueueSink(inner);
    for (let i = 0; i < 200; i++) q.write(i);
    await q.close();
    expect(inner.rows).toEqual(range(200)); // every row, in FIFO order
  });

  it('flush drains without closing', async () => {
    const inner = new ListSink();
    const q = new QueueSink(inner);
    for (let i = 0; i < 50; i++) q.write(i);
    await q.flush();
    expect(inner.rows).toEqual(range(50));
    q.write(50); // still usable after flush
    await q.flush();
    expect(inner.rows).toEqual(range(51));
    await q.close();
  });

  it('a slow inner sink does not block write', async () => {
    const inner = new SlowSink();
    const q = new QueueSink(inner);

    const t0 = performance.now();
    for (let i = 0; i < 20; i++) q.write(i);
    const enqueueElapsed = performance.now() - t0;

    expect(enqueueElapsed).toBeLessThan(500); // enqueuing returns fast
    expect(inner.rows.length).toBeLessThan(20); // proof the writes are asynchronous

    await q.flush(); // now block until the worker has drained everything
    expect(inner.rows).toEqual(range(20));
    await q.close();
  });

  it('close flushes then closes the inner sink (idempotent)', async () => {
    const inner = new LifecycleSink();
    const q = new QueueSink(inner);
    q.write('a');
    await q.close();
    expect(inner.rows).toEqual(['a']);
    expect(inner.flushed).toBe(1);
    expect(inner.closed).toBe(1);
    await q.close(); // idempotent — no second flush/close
    expect(inner.flushed).toBe(1);
    expect(inner.closed).toBe(1);
  });

  it('write after close raises', async () => {
    const q = new QueueSink(new ListSink());
    await q.close();
    expect(() => q.write('x')).toThrow();
  });

  it('drains on scope exit (context-manager parity via try/finally)', async () => {
    const inner = new ListSink();
    const q = new QueueSink(inner);
    try {
      for (let i = 0; i < 10; i++) q.write(i);
    } finally {
      await q.close();
    }
    expect(inner.rows).toEqual(range(10));
  });

  it('optional sink members are detected structurally', async () => {
    const writeOnly = { write: (_e: unknown) => {} };
    expect(typeof writeOnly.write).toBe('function'); // write-only still satisfies the protocol
    expect('flush' in writeOnly).toBe(false);

    const q = new QueueSink(new ListSink());
    expect(typeof q.write).toBe('function');
    expect(typeof q.flush).toBe('function');
    expect(typeof q.close).toBe('function');
    await q.close();
  });

  it('max_queue applies back-pressure without dropping', async () => {
    const inner = new ListSink();
    const q = new QueueSink(inner, { maxQueue: 4 });
    for (let i = 0; i < 50; i++) await q.write(i); // awaits room when full — never drops a row
    await q.close();
    expect(inner.rows).toEqual(range(50)); // all 50 preserved despite the small queue
  });

  it('wraps SQLite through the bus, off the hot path', async () => {
    const inner = new SQLiteSink(':memory:');
    const q = new QueueSink(inner);
    useSink(q);
    for (let i = 0; i < 5; i++) {
      bus.emit(
        new LLMCall({
          id: String(i),
          provider: 'openai',
          model: 'gpt-4o',
          messages: [],
          usage: new Usage({ inputTokens: 10, outputTokens: 5 }),
        }),
      );
    }
    await q.flush(); // drain the queue before reading back
    expect(inner.rows().length).toBe(5);
    useSink(null);
    await q.close();
  });
});
