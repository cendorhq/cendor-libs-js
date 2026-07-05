/**
 * Behavior/unit tests — the TS mirror of `tests/test_squeeze.py`. Compression is content-aware,
 * deterministic, and 100% reversible. No network.
 *
 * Token policy: these tests run on the REAL js-tiktoken counter (production reality), asserting
 * relationships/structure that hold under any monotone counter (roundtrip, `<= target`,
 * `count(small) < count(original)`, ordering, substrings, technique strings). The one test whose
 * *outcome* is genuinely tokenizer-sensitive (`prose keeps the key sentence`) forces the same
 * `ceil(len/4)` heuristic Python's autouse fixture used, via the public `tokens.register` API — no
 * Python token *numbers* are hardcoded.
 */
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Compressor } from '@cendor/core';
import { tokens } from '@cendor/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Fidelity,
  Handle,
  KeyError,
  MemoryStore,
  SQLiteStore,
  SqueezeCompressor,
  _backend,
  _splitSentences,
  compress,
  decompress,
  detect,
  useStore,
} from '../src/index.js';

const GPT4O = 'gpt-4o';
const TIMES = String.fromCharCode(0xd7); // U+00D7 ×

afterEach(() => tokens._reset());

/** Mirror Python's autouse `_heuristic_tokens` fixture: force the `ceil(len/4)` openai counter. */
function forceHeuristic(): void {
  tokens.register('openai', (t) => {
    const s = typeof t === 'string' ? t : '';
    return Math.ceil(Array.from(s).length / 4);
  });
}

const backendSize = (): number => (_backend() as MemoryStore).size;

describe('detection', () => {
  it('classifies json, logs, and prose', () => {
    expect(detect('{"a": 1}')).toBe('json');
    expect(detect('[1, 2, 3]')).toBe('json');
    const logs = Array.from(
      { length: 5 },
      (_, i) => `2026-06-01T00:00:0${i} INFO started worker`,
    ).join('\n');
    expect(detect(logs)).toBe('logs');
    expect(detect('The cat sat on the mat. It was a sunny day.')).toBe('prose');
  });

  it('detects code (python and js)', () => {
    expect(detect('def add(a, b):\n    # sum them\n    return a + b\n')).toBe('code');
    expect(detect('function f(x) {\n  return x * 2;\n}\n')).toBe('code');
  });
});

describe('json compression', () => {
  const pretty = [
    '{',
    '    "name": "alice",',
    '    "age": 30,',
    '    "note": null,',
    '    "tags": [',
    '        "x",',
    '        "y"',
    '    ],',
    '    "extra": null',
    '}',
  ].join('\n');

  it('is smaller and reversible; drops nulls', () => {
    const [small, handle] = compress(pretty, { kind: 'auto' });
    expect(detect(pretty)).toBe('json');
    expect(small.length).toBeLessThan(pretty.length);
    expect(small.includes('note')).toBe(false);
    expect(small.includes('null')).toBe(false);
    expect(handle.expand()).toBe(pretty);
  });

  it('lossless keeps nulls', () => {
    const [small] = compress('{"a": 1, "b": null}', { kind: 'json', fidelity: 'lossless' });
    expect(small.includes('null')).toBe(true);
  });

  it('structural truncate stays valid JSON (dict)', () => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < 40; i++) obj[`key_${i}`] = `value number ${i} with some padding text`;
    const original = JSON.stringify(obj);
    const [small, handle] = compress(original, { kind: 'json', targetTokens: 40, model: GPT4O });
    const parsed = JSON.parse(small); // must not throw — valid JSON despite the budget
    expect(typeof parsed).toBe('object');
    expect(Array.isArray(parsed)).toBe(false);
    expect(Object.keys(parsed).length).toBeLessThan(Object.keys(obj).length);
    expect(handle.expand()).toBe(original);
  });

  it('structural truncate stays valid JSON (list)', () => {
    const list = Array.from({ length: 40 }, (_, i) => ({ i, text: 'padding padding padding' }));
    const original = JSON.stringify(list);
    const [small] = compress(original, { kind: 'json', targetTokens: 40, model: GPT4O });
    const parsed = JSON.parse(small);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.length).toBeLessThan(40);
  });
});

describe('logs compression', () => {
  it('dedup collapses repeats', () => {
    const logs = Array.from({ length: 20 }, () => '2026-06-01T00:00:00Z INFO retry attempt').join(
      '\n',
    );
    const [small, handle] = compress(logs, { kind: 'logs' });
    expect(small.includes(`(${TIMES}20)`)).toBe(true);
    expect(tokens.count(small, GPT4O)).toBeLessThan(tokens.count(logs, GPT4O));
    expect(handle.expand()).toBe(logs);
  });

  it('normalizes ips, hex, and integers into one pattern', () => {
    const lines = [
      '2026-07-02T10:00:00Z GET /x from 10.0.0.1 req=deadbeef12345678 status 200',
      '2026-07-02T10:00:01Z GET /x from 10.0.0.2 req=cafebabe87654321 status 404',
      '2026-07-02T10:00:02Z GET /x from 192.168.1.5 req=0123456789abcdef status 500',
    ];
    const [small, handle] = compress(lines.join('\n'), { kind: 'logs' });
    expect(handle.restoreMap.patterns).toBe(1);
    expect(small.includes(`(${TIMES}3)`)).toBe(true);
    expect(small.includes('<ip>')).toBe(true);
    expect(small.includes('<hex>')).toBe(true);
    expect(small.includes('<n>')).toBe(true);
  });

  it('preserves chronological order under a target', () => {
    const logs = [
      '2026-06-01T00:00:01Z INFO alpha first',
      '2026-06-01T00:00:02Z INFO beta second',
      '2026-06-01T00:00:03Z ERROR gamma',
      '2026-06-01T00:00:04Z ERROR gamma',
      '2026-06-01T00:00:05Z ERROR gamma',
    ].join('\n');
    const [small] = compress(logs, { kind: 'logs', targetTokens: 1000 });
    expect(small.split('\n')[0]?.endsWith('INFO alpha first')).toBe(true);
    expect(tokens.count(small, GPT4O)).toBeLessThanOrEqual(1000);
  });
});

describe('code compression', () => {
  it('strips comments and blank lines, is reversible', () => {
    const src = 'def add(a, b):\n    # add two numbers\n    return a + b\n\n// trailing\n';
    const [small, handle] = compress(src, { kind: 'code' });
    expect(small.includes('# add two numbers')).toBe(false);
    expect(small.includes('// trailing')).toBe(false);
    expect(small.split('\n').includes('')).toBe(false); // blank lines gone
    expect(small.includes('return a + b')).toBe(true);
    expect(handle.expand()).toBe(src);
    expect(tokens.count(small, GPT4O)).toBeLessThan(tokens.count(src, GPT4O));
  });

  it('lossless keeps comments', () => {
    const src = 'def f():\n    # keep me\n    return 1\n';
    const [small] = compress(src, { kind: 'code', fidelity: 'lossless' });
    expect(small.includes('# keep me')).toBe(true);
  });

  it('comment stripping preserves string literals', () => {
    const src =
      'url = "https://example.com/path"  // trailing\nkey = "color #ff0000"\nreturn url\n';
    const [small, handle] = compress(src, { kind: 'code' });
    expect(small.includes('https://example.com/path')).toBe(true); // // inside a string
    expect(small.includes('#ff0000')).toBe(true); // # inside a string
    expect(small.includes('// trailing')).toBe(false);
    expect(handle.expand()).toBe(src);
  });

  it('keeps preprocessor and shebang', () => {
    const src = '#!/usr/bin/env python\n#include <stdio.h>\nx = 1  # a real comment\nreturn x\n';
    const [small] = compress(src, { kind: 'code' });
    expect(small.includes('#!/usr/bin/env python')).toBe(true);
    expect(small.includes('#include <stdio.h>')).toBe(true);
    expect(small.includes('# a real comment')).toBe(false);
  });
});

describe('prose compression', () => {
  it('extractive hits target tokens', () => {
    const text =
      'Refunds are processed within five business days. ' +
      'The weather today is mild and pleasant. ' +
      'Customers must contact support to request a refund. ' +
      'Our office cat is named Mittens. ' +
      'Refund eligibility depends on the purchase date.';
    const target = 20;
    const [small, handle] = compress(text, { kind: 'prose', targetTokens: target });
    expect(tokens.count(small, GPT4O)).toBeLessThanOrEqual(target);
    expect(small.length).toBeLessThan(text.length);
    expect(handle.expand()).toBe(text);
  });

  it('never exceeds target even with one dominant sentence', () => {
    const text =
      'refund refund refund refund refund refund refund refund refund refund policy here. ' +
      'The cat sat. A dog ran. Birds fly.';
    const [small, handle] = compress(text, { kind: 'prose', targetTokens: 5 });
    expect(tokens.count(small, GPT4O)).toBeLessThanOrEqual(5);
    expect(handle.expand()).toBe(text);
  });

  it('fidelity dial is monotone; lossless is a no-op', () => {
    const text = `${Array.from(
      { length: 12 },
      (_, i) => `Sentence ${i} about refunds and billing matters`,
    ).join('. ')}.`;
    const [lossless] = compress(text, { kind: 'prose', fidelity: 'lossless' });
    const [balanced] = compress(text, { kind: 'prose', fidelity: 'balanced' });
    const [aggressive] = compress(text, { kind: 'prose', fidelity: 'aggressive' });
    expect(lossless).toBe(text);
    const t = (s: string): number => tokens.count(s, GPT4O);
    expect(t(aggressive)).toBeLessThanOrEqual(t(balanced));
    expect(t(balanced)).toBeLessThanOrEqual(t(lossless));
  });

  it('keeps the obviously key sentence (sqrt-normalized scoring)', () => {
    // Outcome is tokenizer-sensitive: force the same heuristic Python's fixture used.
    forceHeuristic();
    const key =
      'The migration corrupts the billing ledger and double-charges every enterprise customer.';
    const filler = [
      'It was a nice day.',
      'We had a good time.',
      'That is all for now.',
      'So it goes here.',
      'Nothing to see.',
    ];
    const text = [filler[0], filler[1], key, filler[2], filler[3], filler[4]].join(' ');
    const [small] = compress(text, { kind: 'prose', targetTokens: 25, model: GPT4O });
    expect(small.includes('double-charges')).toBe(true);
    expect(small.includes('nice day')).toBe(false);
  });

  it('does not split on abbreviations or decimals', () => {
    expect(_splitSentences('Dr. Smith paid the bill.')).toEqual(['Dr. Smith paid the bill.']);
    expect(_splitSentences('Use e.g. a refund. Then stop.')).toEqual([
      'Use e.g. a refund.',
      'Then stop.',
    ]);
    expect(_splitSentences('It cost 3.5 million dollars. Wow.')).toEqual([
      'It cost 3.5 million dollars.',
      'Wow.',
    ]);
  });
});

describe('object input and decompress', () => {
  it('serializes object input and restores nulls in the stored original', () => {
    const [small, handle] = compress({ k: 'v', n: null }, { kind: 'auto' });
    expect(small.includes('null')).toBe(false);
    expect(JSON.parse(handle.expand())).toEqual({ k: 'v', n: null });
  });

  it('decompress matches expand', () => {
    const [, handle] = compress('hello world. goodbye world.', { kind: 'prose' });
    expect(decompress(handle)).toBe(handle.expand());
  });
});

describe('content-addressed store', () => {
  it('dedupes identical originals', () => {
    const before = backendSize();
    const [, h1] = compress('identical content here', { kind: 'prose' });
    const [, h2] = compress('identical content here', { kind: 'prose' });
    expect(h1.originalRef).toBe(h2.originalRef);
    expect(backendSize()).toBe(before + 1);
  });

  it('MemoryStore eviction cap drops the oldest', () => {
    const previous = useStore(new MemoryStore(2));
    try {
      const [, h1] = compress('first original content here', { kind: 'prose' });
      const [, h2] = compress('second original content here', { kind: 'prose' });
      const [, h3] = compress('third original content here', { kind: 'prose' });
      expect(backendSize()).toBe(2);
      expect(typeof h2.expand()).toBe('string');
      expect(typeof h3.expand()).toBe('string');
      expect(() => h1.expand()).toThrow(KeyError);
    } finally {
      useStore(previous);
    }
  });

  it('MemoryStore LRU refreshes on get', () => {
    const previous = useStore(new MemoryStore(2));
    try {
      const [, h1] = compress('first original content here', { kind: 'prose' });
      const [, h2] = compress('second original content here', { kind: 'prose' });
      h1.expand(); // touch h1 -> now most-recently-used, so h2 is coldest
      const [, h3] = compress('third original content here', { kind: 'prose' }); // evicts h2
      expect(typeof h1.expand()).toBe('string');
      expect(typeof h3.expand()).toBe('string');
      expect(() => h2.expand()).toThrow(KeyError);
    } finally {
      useStore(previous);
    }
  });
});

describe('SQLite backend', () => {
  it('persists and expands from a file store', () => {
    const path = join(tmpdir(), `ccr-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const store = new SQLiteStore(path);
    const previous = useStore(store);
    try {
      const original = '{"name": "alice", "age": 30, "note": null}';
      const [small, handle] = compress(original, { kind: 'json' });
      expect(small.length).toBeLessThan(original.length);
      expect(store.has(handle.originalRef)).toBe(true);
      expect(handle.expand()).toBe(original);
    } finally {
      useStore(previous);
      store.close();
      try {
        unlinkSync(path);
      } catch {
        /* best effort */
      }
    }
  });

  it('to_dict round-trips with a persistent store', () => {
    const store = new SQLiteStore(':memory:');
    const previous = useStore(store);
    try {
      const original = '{"a": 1, "b": null}';
      const [, handle] = compress(original, { kind: 'json' });
      const rebuilt = Handle.fromDict(handle.toDict());
      expect(rebuilt.expand()).toBe(original);
      expect(rebuilt.technique).toBe(handle.technique);
      expect(store.size).toBe(1);
    } finally {
      useStore(previous);
      store.close();
    }
  });
});

describe('protocol + determinism + validation', () => {
  it('satisfies core Compressor protocol by shape', () => {
    const c: Compressor = new SqueezeCompressor();
    expect(typeof c.compress).toBe('function');
    const [, handle] = new SqueezeCompressor().compress('a. b. c. d.', {
      targetTokens: 5,
      model: GPT4O,
    });
    expect(typeof handle.expand()).toBe('string');
  });

  it('handle id is deterministic', () => {
    const [, h1] = compress('{"a": 1, "b": null}', { kind: 'json' });
    const [, h2] = compress('{"a": 1, "b": null}', { kind: 'json' });
    expect(h1.id).toBe(h2.id);
    const [, other] = compress('{"a": 2}', { kind: 'json' });
    expect(other.id).not.toBe(h1.id);
  });

  it('rejects invalid fidelity', () => {
    expect(() => compress('x', { fidelity: 'ultra' as unknown as Fidelity })).toThrow();
  });
});
