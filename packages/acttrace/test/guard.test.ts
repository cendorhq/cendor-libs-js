import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/** guard() enforcement on core's interceptor seam. Mirrors tests/test_guard.py. No network. */
import {
  LLMCall,
  MISS,
  addInterceptor,
  bus,
  instrument,
  instrumentTool,
  removeInterceptor,
} from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, type Finding, Policy, PolicyViolation, guard, verify } from '../src/index.js';

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

let n = 0;
const tmpFile = (name = 'g.jsonl'): string =>
  join(mkdtempSync(join(tmpdir(), `guard-${n++}-`)), name);

interface FakeClient {
  chat: { completions: { create: (p: Record<string, unknown>) => Promise<unknown> } };
}
function client(calls: { n: number }): FakeClient {
  const c = {
    chat: {
      completions: {
        create: async () => {
          calls.n += 1;
          return { usage: { prompt_tokens: 1, completion_tokens: 1 } };
        },
      },
    },
  };
  return instrument(c) as unknown as FakeClient;
}
const msgs = (text: string): { role: string; content: string }[] => [
  { role: 'user', content: text },
];
type Dict = Record<string, unknown>;
const payloadOf = (e: { payload: unknown }): Dict => e.payload as Dict;

async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

it('blocks a disallowed call and records the flag', async () => {
  const path = tmpFile();
  const log = new AuditLog('s', { path });
  const calls = { n: 0 };
  const cl = client(calls);
  const g = guard(Policy.pci(), log);
  addInterceptor(g);
  let err: unknown;
  try {
    err = await capture(() =>
      cl.chat.completions.create({ model: 'gpt-4o', messages: msgs('card 4111 1111 1111 1111') }),
    );
  } finally {
    removeInterceptor(g);
    log.detach();
  }
  expect(err).toBeInstanceOf(PolicyViolation);
  expect((err as PolicyViolation).findings.map((f: Finding) => f.category)).toEqual([
    'credit_card',
  ]);
  expect(calls.n).toBe(0);
  const flags = log.entries.filter((e) => e.type === 'policy_flag');
  expect(flags.length).toBe(1);
  expect(payloadOf(flags[0]!).action).toBe('blocked');
  expect(payloadOf(flags[0]!).data).toEqual(['credit_card']);
  expect(log.entries.some((e) => e.type === 'llm_call')).toBe(false);
  expect(verify(path)[0]).toBe(true);
});

it('flag action proceeds and records', async () => {
  const path = tmpFile('f.jsonl');
  const log = new AuditLog('s', { path });
  const calls = { n: 0 };
  const cl = client(calls);
  const g = guard(Policy.default(), log);
  addInterceptor(g);
  try {
    await cl.chat.completions.create({
      model: 'gpt-4o',
      messages: msgs('card 4111 1111 1111 1111'),
    });
  } finally {
    removeInterceptor(g);
    log.detach();
  }
  expect(calls.n).toBe(1);
  const flags = log.entries.filter((e) => e.type === 'policy_flag');
  expect(
    flags.some(
      (f) =>
        payloadOf(f).action === 'flagged' &&
        JSON.stringify(payloadOf(f).data) === '["credit_card"]',
    ),
  ).toBe(true);
  expect(log.entries.some((e) => e.type === 'llm_call')).toBe(true);
});

it('redact-before-send scrubs the provider payload', async () => {
  const received: { messages?: unknown } = {};
  const c = {
    chat: {
      completions: {
        create: async (kwargs: Record<string, unknown>) => {
          received.messages = kwargs.messages;
          return { usage: { prompt_tokens: 1, completion_tokens: 1 } };
        },
      },
    },
  };
  const cl = instrument(c) as unknown as FakeClient;
  const log = new AuditLog('s', { path: tmpFile('r.jsonl') });
  const g = guard(Policy.default(), log);
  addInterceptor(g);
  try {
    await cl.chat.completions.create({
      model: 'gpt-4o',
      messages: msgs('mail me at alice@example.com'),
    });
  } finally {
    removeInterceptor(g);
    log.detach();
  }
  expect(JSON.stringify(received.messages)).not.toContain('alice@example.com');
  expect(JSON.stringify(received.messages)).toContain('<redacted>');
  const redacted = log.entries
    .filter((e) => e.type === 'policy_flag')
    .find((f) => JSON.stringify(payloadOf(f).data) === '["email"]');
  expect(payloadOf(redacted!).action).toBe('redacted');
});

it('without audit still enforces (blocks)', async () => {
  const calls = { n: 0 };
  const cl = client(calls);
  const g = guard(Policy.strict());
  addInterceptor(g);
  let err: unknown;
  try {
    err = await capture(() =>
      cl.chat.completions.create({
        model: 'gpt-4o',
        messages: msgs('key sk-ant-api03-ABCDEFGH12345678'),
      }),
    );
  } finally {
    removeInterceptor(g);
  }
  expect(err).toBeInstanceOf(PolicyViolation);
  expect(calls.n).toBe(0);
});

it('clean call proceeds untouched', async () => {
  const calls = { n: 0 };
  const cl = client(calls);
  const g = guard(Policy.strict());
  addInterceptor(g);
  try {
    await cl.chat.completions.create({ model: 'gpt-4o', messages: msgs('how do refunds work?') });
  } finally {
    removeInterceptor(g);
  }
  expect(calls.n).toBe(1);
});

it('custom on_block exception class', async () => {
  class Blocked extends Error {}
  const calls = { n: 0 };
  const cl = client(calls);
  const g = guard(Policy.pci(), null, Blocked);
  addInterceptor(g);
  let err: unknown;
  try {
    err = await capture(() =>
      cl.chat.completions.create({ model: 'gpt-4o', messages: msgs('card 4111 1111 1111 1111') }),
    );
  } finally {
    removeInterceptor(g);
  }
  expect(err).toBeInstanceOf(Blocked);
  expect(calls.n).toBe(0);
});

it('custom on_block factory gets the findings', async () => {
  class RuntimeError extends Error {}
  const seen: { cats?: string[] } = {};
  const makeExc = (findings: Finding[]): Error => {
    seen.cats = findings.map((f) => f.category);
    return new RuntimeError('blocked by factory');
  };
  const calls = { n: 0 };
  const cl = client(calls);
  const g = guard(Policy.pci(), null, makeExc);
  addInterceptor(g);
  let err: unknown;
  try {
    err = await capture(() =>
      cl.chat.completions.create({ model: 'gpt-4o', messages: msgs('card 4111 1111 1111 1111') }),
    );
  } finally {
    removeInterceptor(g);
  }
  expect(err).toBeInstanceOf(RuntimeError);
  expect(seen.cats).toEqual(['credit_card']);
});

it('blocks tool-call arguments', () => {
  const path = tmpFile('t.jsonl');
  const log = new AuditLog('s', { path });
  const ran = { n: 0 };
  const g = guard(Policy.pci(), log);
  const charge = instrumentTool('charge')((_card: string) => {
    ran.n += 1;
    return 'charged';
  }) as (card: string) => string;
  addInterceptor(g);
  try {
    expect(() => charge('4111 1111 1111 1111')).toThrow(PolicyViolation);
  } finally {
    removeInterceptor(g);
    log.detach();
  }
  expect(ran.n).toBe(0);
  const flags = log.entries.filter((e) => e.type === 'policy_flag');
  expect(flags.length).toBeGreaterThan(0);
  expect(payloadOf(flags[0]!).action).toBe('blocked');
  expect(verify(path)[0]).toBe(true);
});

it('redact on tool arguments is record-only (tool still runs)', () => {
  const log = new AuditLog('s', { path: tmpFile('tr.jsonl') });
  const ran = { n: 0 };
  const g = guard(Policy.default(), log);
  const notify = instrumentTool('notify')((_to: string) => {
    ran.n += 1;
    return 'sent';
  }) as (to: string) => string;
  addInterceptor(g);
  try {
    notify('alice@example.com');
  } finally {
    removeInterceptor(g);
    log.detach();
  }
  expect(ran.n).toBe(1);
  const note = log.entries
    .filter((e) => e.type === 'policy_flag')
    .find((f) => String(payloadOf(f).reason ?? '').includes('tool arguments unchanged'));
  expect(note).toBeDefined();
  expect(payloadOf(note!).action).toBe('flagged');
  expect(payloadOf(note!).data).toEqual(['email']);
});

it('Policy.default() never blocks', async () => {
  const calls = { n: 0 };
  const cl = client(calls);
  const g = guard(Policy.default());
  addInterceptor(g);
  try {
    await cl.chat.completions.create({
      model: 'gpt-4o',
      messages: msgs('key sk-ant-api03-ABCDEFGH12345678 and card 4111 1111 1111 1111'),
    });
  } finally {
    removeInterceptor(g);
  }
  expect(calls.n).toBe(1);
});

it('ignores non-call events', () => {
  const g = guard(Policy.strict());
  expect(g({})).toBe(MISS);
  expect(g(new LLMCall({ id: 'x', provider: 'openai', model: 'm', messages: [] }))).toBe(MISS);
});

// --- dual-shape guard (0.6.0): scope form + resolveFindings -------------------------------------

describe('guard scope form (guard(opts, fn))', () => {
  it('installs for the callback and removes after (exactly once, enforcement scoped)', async () => {
    const calls = { n: 0 };
    const c = client(calls);

    await expect(
      guard({ policy: Policy.pci() }, async () => {
        await c.chat.completions.create({
          model: 'gpt-4o',
          messages: msgs('card 4111 1111 1111 1111'),
        });
      }),
    ).rejects.toBeInstanceOf(PolicyViolation);
    expect(calls.n).toBe(0); // blocked while scoped

    // enforcement is really gone after the scope
    await c.chat.completions.create({
      model: 'gpt-4o',
      messages: msgs('card 4111 1111 1111 1111'),
    });
    expect(calls.n).toBe(1);
  });

  it('removes the interceptor when the callback throws a non-policy error', async () => {
    const calls = { n: 0 };
    const c = client(calls);

    await expect(
      guard({ policy: Policy.pci() }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await c.chat.completions.create({
      model: 'gpt-4o',
      messages: msgs('card 4111 1111 1111 1111'),
    });
    expect(calls.n).toBe(1); // no leftover enforcement
  });

  it('returns the callback result and records on the audit log', async () => {
    const path = tmpFile();
    const audit = new AuditLog('s', { path });
    const calls = { n: 0 };
    const c = client(calls);

    const out = await guard({ policy: Policy.gdpr(), audit }, async () => {
      await c.chat.completions.create({
        model: 'gpt-4o',
        messages: msgs('email bob@acme.com'),
      });
      return 42;
    });
    audit.detach();

    expect(out).toBe(42);
    expect(calls.n).toBe(1); // redact-before-send proceeds
    const flags = audit.entries.filter((e) => e.type === 'policy_flag');
    expect(flags.length).toBe(1);
    expect(payloadOf(flags[0]).action).toBe('redacted');
  });

  it('raw interceptor form is unchanged (shape pin)', () => {
    const g = guard(Policy.strict());
    expect(typeof g).toBe('function');
    expect(g({})).toBe(MISS); // callable without installation, exactly as before
  });
});

describe('resolveFindings', () => {
  it('groups findings by their already-resolved actions', async () => {
    const { resolveFindings, scan } = await import('../src/index.js');
    const findings = scan('email bob@acme.com card 4111 1111 1111 1111', Policy.gdpr());
    const groups = resolveFindings(findings);
    const redacted = new Set(groups.redact.map((f: Finding) => f.category));
    expect(redacted.has('email')).toBe(true);
    expect(redacted.has('credit_card')).toBe(true);
    expect(groups.block.length).toBe(0);
  });

  it('re-resolves under another policy and re-stamps the action', async () => {
    const { resolveFindings, scan } = await import('../src/index.js');
    // scan wide under default (never blocks), enforce under pci (financial -> block)
    const findings = scan('card 4111 1111 1111 1111', Policy.default());
    expect(findings.every((f: Finding) => f.action !== 'block')).toBe(true);
    const groups = resolveFindings(findings, Policy.pci());
    expect(groups.block.map((f: Finding) => f.category)).toEqual(['credit_card']);
    expect(groups.block[0].action).toBe('block');
  });
});
