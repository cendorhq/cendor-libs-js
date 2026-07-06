/**
 * Cross-language conformance: prove Python-produced cassette artifacts interoperate with the JS port.
 * If any of these fail the port is wrong — never weaken the assertion.
 */
import { bus, instrument, instrumentTool } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _hash, _redact, using } from '../src/index.js';
import { type PyValue, parsePreserving } from '../src/pyjson.js';
import { fixturePath, loadFixture, readFixture } from './_fixtures.js';

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

interface Manifest {
  replays: Array<{
    file: string;
    kind: 'llm' | 'tool' | 'stream';
    request?: { model: string; messages: Array<Record<string, unknown>>; stream?: boolean };
    tool?: string;
    args?: unknown[];
    expect: { path?: string; value?: unknown; joinedDeltaContent?: string };
  }>;
}

describe('cassette fixture: manifest replays', () => {
  const manifest = loadFixture<Manifest>('cassette/manifest.json');

  for (const r of manifest.replays) {
    it(`replays ${r.file} (${r.kind})`, async () => {
      const path = fixturePath(`cassette/${r.file}`);

      if (r.kind === 'llm') {
        let called = false;
        const client = instrument({
          chat: {
            completions: {
              create: async () => {
                called = true;
                throw new Error('the live client must not be called on replay');
              },
            },
          },
        });
        const content = await using(path, { mode: 'replay' }, async () => {
          const resp = (await client.chat.completions.create({
            model: r.request!.model,
            messages: r.request!.messages,
          })) as { choices: Array<{ message: { content: string } }> };
          return resp.choices[0]!.message.content;
        });
        expect(content).toBe(r.expect.value);
        expect(called).toBe(false);
        return;
      }

      if (r.kind === 'tool') {
        let ran = false;
        const search = instrumentTool(r.tool!)(async (..._a: unknown[]) => {
          ran = true;
          return { hits: [] };
        }) as (...a: unknown[]) => Promise<unknown>;
        const out = await using(path, { mode: 'replay' }, async () => search(...(r.args ?? [])));
        expect(out).toEqual(r.expect.value);
        expect(ran).toBe(false);
        return;
      }

      // stream
      let called = false;
      const client = instrument({
        chat: {
          completions: {
            create: async () => {
              called = true;
              throw new Error('the live client must not be called on replay');
            },
          },
        },
      });
      const joined = await using(path, { mode: 'replay' }, async () => {
        const stream = (await client.chat.completions.create({
          model: r.request!.model,
          messages: r.request!.messages,
          stream: true,
        })) as AsyncIterable<{ choices: Array<{ delta: { content: string } }> }>;
        let out = '';
        for await (const c of stream) {
          if (c.choices && c.choices.length > 0) out += c.choices[0]!.delta.content;
        }
        return out;
      });
      expect(joined).toBe(r.expect.joinedDeltaContent);
      expect(called).toBe(false);
    });
  }
});

describe('cassette fixture: hashes.json (golden request hashes)', () => {
  it('_hash(request) matches every golden vector', () => {
    // parsePreserving keeps ints as ints (a:1 -> "1") so canonical hashing matches Python exactly.
    const doc = parsePreserving(readFixture('cassette/hashes.json')) as {
      cases: Array<{ request: PyValue; hash: string }>;
    };
    expect(doc.cases.length).toBeGreaterThan(0);
    for (const c of doc.cases) {
      expect(_hash(c.request)).toBe(String(c.hash));
    }
    // The canonical golden vector.
    const golden = doc.cases[0]!;
    expect(_hash(golden.request)).toBe(
      'd222f427e82aa9f76a8cf7224131cbc9698c7680acfc88f77499c69cbc0ec99f',
    );
  });
});

describe('cassette fixture: redaction.json (built-in scrubber)', () => {
  const doc = loadFixture<{ cases: Array<{ input: string; output: string }> }>(
    'cassette/redaction.json',
  );
  for (const [i, c] of doc.cases.entries()) {
    it(`redacts case ${i}: ${JSON.stringify(c.input).slice(0, 40)}`, () => {
      expect(_redact(c.input)).toBe(c.output);
    });
  }
});
