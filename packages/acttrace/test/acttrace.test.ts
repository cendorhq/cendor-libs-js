/** Auto-populated, hash-chained, tamper-evident audit log. Mirrors tests/test_acttrace.py. */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LLMCall,
  MISS,
  Money,
  Usage,
  addInterceptor,
  bus,
  instrument,
  instrumentTool,
  removeInterceptor,
} from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditEntry, AuditLog, defaultRedactor, frameworks, main, verify } from '../src/index.js';

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

let dirCounter = 0;
function tmpFile(name = 'audit.jsonl'): string {
  const dir = mkdtempSync(join(tmpdir(), `acttrace-${dirCounter++}-`));
  return join(dir, name);
}

interface FakeClient {
  chat: { completions: { create: (params: Record<string, unknown>) => Promise<unknown> } };
}
function makeClient(
  usage: Record<string, unknown> = { prompt_tokens: 100, completion_tokens: 50 },
  onCreate?: () => void,
): FakeClient {
  const client = {
    chat: {
      completions: {
        create: async () => {
          onCreate?.();
          return { usage };
        },
      },
    },
  };
  return instrument(client) as unknown as FakeClient;
}

type Dict = Record<string, unknown>;
const payloadOf = (e: AuditEntry): Dict => e.payload as Dict;
function readRows(path: string): Dict[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Dict);
}

describe('auto-capture + chain', () => {
  it('auto-populates from instrumented calls', async () => {
    const log = new AuditLog('loan_triage', { riskTier: 'high', path: tmpFile() });
    try {
      const client = makeClient();
      await log.decision(
        async (d) => {
          await client.chat.completions.create({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'x' }],
          });
          d.record({ model: 'gpt-4o', prompt_id: 'triage@v3' });
          d.humanOversight('ops@bank', 'approved', 'manual check');
        },
        { input: { amount: 5000 }, actor: 'agent' },
      );
    } finally {
      log.detach();
    }
    const types = log.entries.map((e) => e.type);
    expect(types).toContain('decision');
    expect(types).toContain('llm_call');
    expect(types).toContain('human_oversight');
    const llm = log.entries.find((e) => e.type === 'llm_call')!;
    expect(payloadOf(llm).cost).not.toBeNull();
    expect(payloadOf(llm).decision_id).not.toBeNull();
  });

  it('chain verifies and detects tampering', async () => {
    const path = tmpFile();
    const log = new AuditLog('s', { path });
    try {
      await log.decision(async (d) => d.humanOversight('r', 'approved'), { input: 'app' });
    } finally {
      log.detach();
    }
    expect(verify(path)[0]).toBe(true);

    const lines = readFileSync(path, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    const row = JSON.parse(lines[1]!) as Dict;
    (row.payload as Dict).actor = 'HACKED';
    lines[1] = JSON.stringify(row);
    writeFileSync(path, `${lines.join('\n')}\n`);
    const [ok, detail] = verify(path);
    expect(ok).toBe(false);
    expect(detail).toContain('tampered');
  });

  // Ported from PY tests/test_acttrace.py::{test_cli_verify, test_cli_missing_file_exits_nonzero_cleanly}
  it('CLI main(["verify", path]) returns 0, then 1 after tampering', () => {
    const path = tmpFile();
    const log = new AuditLog('s', { path });
    log.detach();
    expect(main(['verify', path])).toBe(0);

    writeFileSync(path, readFileSync(path, 'utf-8').replace(/"system"/g, '"SYSTEM"'));
    expect(main(['verify', path])).toBe(1);
  });

  it('CLI main on a missing file exits non-zero cleanly (no throw)', () => {
    expect(main(['verify', join(tmpFile('sub'), 'nope.jsonl')])).toBe(1);
  });

  it('context_assembly is auto-captured by duck-type (no contextkit import)', async () => {
    const log = new AuditLog('s', { path: tmpFile() });
    try {
      await log.decision(
        async () => {
          bus.emit({
            model: 'gpt-4o',
            budget: 1000,
            used: 5,
            decisions: [
              {
                role: 'system',
                action: 'kept',
                tokens_before: 0,
                tokens_after: 5,
                note: '',
                handle: null,
              },
            ],
          });
        },
        { input: 'q' },
      );
    } finally {
      log.detach();
    }
    expect(log.entries.some((e) => e.type === 'context_assembly')).toBe(true);
  });
});

describe('export + control mapping', () => {
  async function oversightLog(): Promise<AuditLog> {
    const log = new AuditLog('s', { riskTier: 'high' });
    await log.decision(async (d) => d.humanOversight('r', 'approved'), { input: 'x' });
    log.detach();
    return log;
  }

  it('eu_ai_act export annotates + still verifies', async () => {
    const log = await oversightLog();
    const out = tmpFile('evidence.jsonl');
    log.export(out, 'eu_ai_act');
    const rows = readRows(out);
    expect(rows[0]).toHaveProperty('_meta');
    expect(String((rows[0]!._meta as Dict).disclaimer).toLowerCase()).toContain('not legal advice');
    const oversight = rows.find((r) => r.type === 'human_oversight')!;
    expect(oversight.controls).toEqual(['Art.14 human oversight', 'Art.26(5) deployer oversight']);
    expect(verify(out)[0]).toBe(true);
  });

  it('nist_rmf export annotates + summarizes', async () => {
    expect(frameworks()).toEqual(expect.arrayContaining(['eu_ai_act', 'nist_rmf']));
    const log = await oversightLog();
    const out = tmpFile('evidence.jsonl');
    log.export(out, 'nist_rmf');
    const rows = readRows(out);
    const meta = rows[0]!._meta as Dict;
    expect(meta.framework).toBe('nist_rmf');
    expect(meta.controls_covered).toContain('MANAGE-2.1');
    expect(rows.find((r) => r.type === 'human_oversight')!.controls).toEqual(['MANAGE-2.1']);
    expect(verify(out)[0]).toBe(true);
  });

  it('iso_42001 and gdpr frameworks annotate', async () => {
    expect(new Set(frameworks())).toEqual(new Set(['eu_ai_act', 'gdpr', 'iso_42001', 'nist_rmf']));
    const log = await oversightLog();

    const iso = tmpFile('iso.jsonl');
    log.export(iso, 'iso_42001');
    const irows = readRows(iso);
    expect((irows[0]!._meta as Dict).controls_covered).toContain('A.6.2.8 event logs');
    expect(irows.find((r) => r.type === 'human_oversight')!.controls).toEqual([
      'A.9.2 responsible use',
      'A.9.4 intended use',
    ]);
    expect(verify(iso)[0]).toBe(true);

    const gdpr = tmpFile('gdpr.jsonl');
    log.export(gdpr, 'gdpr');
    const grows = readRows(gdpr);
    expect(grows.find((r) => r.type === 'decision')!.controls).toContain(
      'Art.22 automated decision-making',
    );
    expect(verify(gdpr)[0]).toBe(true);
  });

  it('policy_flag control mapping (gdpr) surfaces Art.9', async () => {
    const log = new AuditLog('s');
    log.flag('special-category data', { action: 'blocked' });
    log.detach();
    const out = tmpFile('e.jsonl');
    log.export(out, 'gdpr');
    const rows = readRows(out);
    const flag = rows.find((r) => r.type === 'policy_flag')!;
    expect(flag.controls).toContain('Art.9 special-category data');
    expect((rows[0]!._meta as Dict).controls_covered).toContain('Art.9 special-category data');
  });

  it('unknown framework rejected', () => {
    const log = new AuditLog('s');
    log.detach();
    expect(() => log.export(tmpFile('x.jsonl'), 'iso_9000')).toThrow();
  });

  it('export meta summary counts', async () => {
    const log = new AuditLog('s', { riskTier: 'high' });
    await log.decision(
      async (d) => {
        d.humanOversight('r', 'approved');
        d.flag('out of scope', { action: 'blocked', severity: 'critical' });
      },
      { input: 'x' },
    );
    log.detach();
    const out = tmpFile('e.jsonl');
    log.export(out, 'eu_ai_act');
    const summary = (readRows(out)[0]!._meta as Dict).summary as Dict;
    expect(summary.decisions).toBe(1);
    expect(summary.human_oversight).toBe(1);
    expect(summary.policy_flags).toBe(1);
    expect(summary.flags_by_action).toEqual({ blocked: 1 });
    expect(summary.flags_by_severity).toEqual({ critical: 1 });
  });
});

describe('flags', () => {
  it('records a policy event and tags the active decision', async () => {
    const path = tmpFile('f.jsonl');
    const log = new AuditLog('s', { path });
    let did = '';
    try {
      log.flag('pii detected', { action: 'redacted', data: 'email' });
      await log.decision(
        async (d) => {
          d.flag('out of scope', { action: 'blocked', severity: 'critical' });
          did = d.id;
        },
        { input: 'x' },
      );
    } finally {
      log.detach();
    }
    const flags = log.entries.filter((e) => e.type === 'policy_flag');
    expect(flags.length).toBe(2);
    expect(payloadOf(flags[0]!).decision_id).toBeNull();
    expect(payloadOf(flags[0]!).action).toBe('redacted');
    expect(payloadOf(flags[1]!).decision_id).toBe(did);
    expect(payloadOf(flags[1]!).action).toBe('blocked');
    expect(verify(path)[0]).toBe(true);
  });

  it('decision flag returns an entry and normalizes casing', async () => {
    const log = new AuditLog('s');
    let entry: AuditEntry | undefined;
    await log.decision(
      async (d) => {
        entry = d.flag('nope', { action: 'BLOCKED', severity: 'Critical' });
      },
      { input: 'x' },
    );
    log.detach();
    expect(entry).toBeInstanceOf(AuditEntry);
    expect(payloadOf(entry!).action).toBe('blocked');
    expect(payloadOf(entry!).severity).toBe('critical');
  });

  it('preflight guard blocks a call and records the flag', async () => {
    const path = tmpFile('guard.jsonl');
    const log = new AuditLog('s', { path });
    const calls = { n: 0 };
    const client = makeClient({ prompt_tokens: 1, completion_tokens: 1 }, () => {
      calls.n += 1;
    });

    class PV extends Error {}
    const preflight = (call: unknown): unknown => {
      if (call instanceof LLMCall) {
        const text = call.messages
          .map((m) => (typeof m.content === 'string' ? m.content : ''))
          .join(' ');
        if (text.toLowerCase().includes('ssn')) {
          log.flag('special-category data in prompt', {
            action: 'blocked',
            severity: 'critical',
            data: 'ssn pattern',
          });
          throw new PV('must not send special-category data');
        }
      }
      return MISS;
    };
    addInterceptor(preflight);
    try {
      await expect(
        client.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'my ssn is x' }],
        }),
      ).rejects.toBeInstanceOf(PV);
    } finally {
      removeInterceptor(preflight);
      log.detach();
    }
    expect(calls.n).toBe(0);
    const flags = log.entries.filter((e) => e.type === 'policy_flag');
    expect(flags.length).toBe(1);
    expect(payloadOf(flags[0]!).action).toBe('blocked');
    expect(log.entries.some((e) => e.type === 'llm_call')).toBe(false);
    expect(verify(path)[0]).toBe(true);
  });
});

describe('redaction', () => {
  it('payload redaction is on by default', async () => {
    const path = tmpFile();
    const log = new AuditLog('s', { path });
    await log.decision(async () => {}, {
      input: { user_email: 'alice@example.com', api_key: 'sk-ABCDEFGH12345678' },
    });
    log.detach();
    const decision = log.entries.find((e) => e.type === 'decision')!;
    const blob = JSON.stringify(decision.payload);
    expect(blob).not.toContain('alice@example.com');
    expect(blob).not.toContain('sk-ABCDEFGH12345678');
    expect(blob).toContain('<redacted>');
    expect(verify(path)[0]).toBe(true);
    const did = payloadOf(decision).decision_id as string;
    expect(did).toBeTruthy();
    expect(did).not.toBe('<redacted>');
  });

  it('modern secret formats are redacted and flagged', async () => {
    const secrets = {
      anthropic: 'sk-ant-api03-ABCDEFGH12345678',
      openai_proj: 'sk-proj-ABCDEFGH12345678',
      aws: `AKIA${'A'.repeat(16)}`,
      google: `AIza${'b'.repeat(35)}`,
      jwt: `eyJ${'a'.repeat(15)}.${'b'.repeat(15)}.${'c'.repeat(15)}`,
    };
    const path = tmpFile();
    const log = new AuditLog('s', { path });
    await log.decision(async () => {}, { input: secrets });
    log.detach();
    const blob = JSON.stringify(log.entries.find((e) => e.type === 'decision')!.payload);
    for (const raw of Object.values(secrets)) expect(blob).not.toContain(raw);
    expect(blob).toContain('<redacted>');
    expect(verify(path)[0]).toBe(true);
    const flag = log.entries.find((e) => e.type === 'policy_flag')!;
    const cats = new Set(payloadOf(flag).data as string[]);
    for (const c of ['api_key', 'aws_key', 'google_api_key', 'jwt']) expect(cats.has(c)).toBe(true);
  });

  it('plain hyphenated text is not redacted', async () => {
    const sentence = 'a well-known best-practice for multi-region fail-over in us-east-1';
    const log = new AuditLog('s', { path: tmpFile() });
    await log.decision(async () => {}, { input: { note: sentence } });
    log.detach();
    const decision = log.entries.find((e) => e.type === 'decision')!;
    expect((payloadOf(decision).input as Dict).note).toBe(sentence);
    expect(log.entries.some((e) => e.type === 'policy_flag')).toBe(false);
  });

  it('redaction can be disabled', async () => {
    const log = new AuditLog('s', { path: tmpFile(), redact: false });
    await log.decision(async () => {}, { input: { user_email: 'bob@example.com' } });
    log.detach();
    const decision = log.entries.find((e) => e.type === 'decision')!;
    expect((payloadOf(decision).input as Dict).user_email).toBe('bob@example.com');
  });

  it('custom redactor scrubs domain-specific PII (composed with default)', async () => {
    const scrub = (obj: unknown): unknown => {
      const base = defaultRedactor(obj);
      const go = (o: unknown): unknown => {
        if (typeof o === 'string') return o.replace('ACCT-9988', '<account>');
        if (Array.isArray(o)) return o.map(go);
        if (o !== null && typeof o === 'object') {
          const r: Dict = {};
          for (const [k, v] of Object.entries(o)) r[k] = go(v);
          return r;
        }
        return o;
      };
      return go(base);
    };
    const path = tmpFile();
    const log = new AuditLog('bank', { path, redactor: scrub });
    await log.decision(async () => {}, {
      input: { note: 'wire from ACCT-9988 by carol@example.com' },
    });
    log.detach();
    const blob = JSON.stringify(log.entries.find((e) => e.type === 'decision')!.payload);
    expect(blob).not.toContain('ACCT-9988');
    expect(blob).not.toContain('carol@example.com');
    expect(blob).toContain('<account>');
    expect(blob).toContain('<redacted>');
    expect(verify(path)[0]).toBe(true);
  });

  it('auto-emits exactly one policy_flag (auto:true) for redacted PII', async () => {
    const path = tmpFile();
    const log = new AuditLog('s', { path });
    await log.decision(async () => {}, { input: { note: 'reach me at alice@example.com' } });
    log.detach();
    const flags = log.entries.filter((e) => e.type === 'policy_flag');
    expect(flags.length).toBe(1);
    expect(payloadOf(flags[0]!).action).toBe('redacted');
    expect(payloadOf(flags[0]!).data).toEqual(['email']);
    expect(payloadOf(flags[0]!).auto).toBe(true);
    expect(JSON.stringify(log.entries.find((e) => e.type === 'decision')!.payload)).not.toContain(
      'alice@example.com',
    );
    expect(verify(path)[0]).toBe(true);
  });

  it('auto-flag links a tool_call redaction to the active decision', async () => {
    const log = new AuditLog('s', { path: tmpFile() });
    let did = '';
    const notify = instrumentTool('notify')((_to: string) => 'sent') as (to: string) => string;
    await log.decision(
      async (d) => {
        notify('carol@example.com');
        did = d.id;
      },
      { input: 'go' },
    );
    log.detach();
    const flags = log.entries.filter((e) => e.type === 'policy_flag');
    expect(flags.length).toBe(1);
    expect(payloadOf(flags[0]!).data).toEqual(['email']);
    expect(payloadOf(flags[0]!).decision_id).toBe(did);
  });

  it('no auto-flag without PII or when disabled', async () => {
    const clean = new AuditLog('s', { path: tmpFile('clean.jsonl') });
    await clean.decision(async () => {}, { input: { q: 'how do refunds work?' } });
    clean.detach();
    expect(clean.entries.some((e) => e.type === 'policy_flag')).toBe(false);

    const off = new AuditLog('s', { path: tmpFile('off.jsonl'), flagOnRedact: false });
    await off.decision(async () => {}, { input: { e: 'dave@example.com' } });
    off.detach();
    expect(off.entries.some((e) => e.type === 'policy_flag')).toBe(false);
    expect(JSON.stringify(off.entries.find((e) => e.type === 'decision')!.payload)).not.toContain(
      'dave@example.com',
    );
  });

  it('a custom redactor does not auto-flag', async () => {
    const scrub = (obj: unknown): unknown => defaultRedactor(obj);
    const log = new AuditLog('s', { path: tmpFile(), redactor: scrub });
    await log.decision(async () => {}, { input: { e: 'erin@example.com' } });
    log.detach();
    expect(log.entries.some((e) => e.type === 'policy_flag')).toBe(false);
  });
});

describe('signing + completeness', () => {
  async function signedPack(key = 's3cret', n = 3): Promise<{ pack: string; head: string }> {
    const src = tmpFile('src.jsonl');
    const log = new AuditLog('loan', { riskTier: 'high', path: src, signingKey: key });
    for (let i = 0; i < n; i++) {
      await log.decision(async (d) => d.humanOversight('r', 'approved'), { input: `app ${i}` });
    }
    log.detach();
    const pack = tmpFile('pack.jsonl');
    log.export(pack, 'eu_ai_act');
    return { pack, head: log.head };
  }

  it('signed records verify with the key', async () => {
    const path = tmpFile('signed.jsonl');
    const log = new AuditLog('loan', { riskTier: 'high', path, signingKey: 's3cret' });
    await log.decision(async (d) => d.humanOversight('r', 'approved'), { input: 'app' });
    log.detach();
    expect(log.entries.every((e) => e.sig)).toBe(true);
    expect(verify(path, { key: 's3cret' })[0]).toBe(true);
    const [ok, detail] = verify(path, { key: 'wrong-key' });
    expect(ok).toBe(false);
    expect(detail).toContain('signature');
    expect(verify(path)[0]).toBe(true);
  });

  it('unsigned log fails when a key is required', async () => {
    const path = tmpFile('plain.jsonl');
    const log = new AuditLog('s', { path });
    log.detach();
    expect(verify(path)[0]).toBe(true);
    const [ok, detail] = verify(path, { key: 'expected' });
    expect(ok).toBe(false);
    expect(detail).toContain('signature');
  });

  it('detects tail truncation of an exported pack', async () => {
    const log = new AuditLog('s', { riskTier: 'high' });
    for (let i = 0; i < 3; i++) {
      await log.decision(async (d) => d.humanOversight('r', i < 2 ? 'approved' : 'REJECTED'), {
        input: `app ${i}`,
      });
    }
    log.detach();
    const pack = tmpFile('pack.jsonl');
    log.export(pack, 'eu_ai_act');
    expect(verify(pack)[0]).toBe(true);
    const lines = readFileSync(pack, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    writeFileSync(pack, `${lines.slice(0, -3).join('\n')}\n`);
    const [ok, detail] = verify(pack);
    expect(ok).toBe(false);
    expect(detail).toContain('incomplete');
  });

  it('expected_head catches raw-log truncation', async () => {
    const path = tmpFile('raw.jsonl');
    const log = new AuditLog('s', { path });
    for (let i = 0; i < 3; i++) await log.decision(async () => {}, { input: `x${i}` });
    log.detach();
    const head = log.head;
    expect(verify(path, { expectedHead: head })[0]).toBe(true);
    const lines = readFileSync(path, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    writeFileSync(path, `${lines.slice(0, -2).join('\n')}\n`);
    expect(verify(path, { expectedHead: head })[0]).toBe(false);
    expect(verify(path)[0]).toBe(true);
  });

  it('signed pack _meta is verifiable', async () => {
    const { pack } = await signedPack();
    const [ok, detail] = verify(pack, { key: 's3cret' });
    expect(ok).toBe(true);
    expect(detail).toContain('metadata signature verified');
  });

  it('forged _meta truncation fails even with the key', async () => {
    const { pack } = await signedPack();
    const rows = readRows(pack);
    const meta = rows[0]!;
    const entries = rows.slice(1);
    const kept = entries.slice(0, -3);
    (meta._meta as Dict).head_hash = (kept[kept.length - 1] as Dict).hash;
    (meta._meta as Dict).entries = kept.length;
    const forged = [meta, ...kept];
    writeFileSync(pack, `${forged.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const [ok, detail] = verify(pack, { key: 's3cret' });
    expect(ok).toBe(false);
    expect(detail).toContain('forged _meta');
  });

  it('stripped _meta signature fails with the key', async () => {
    const { pack } = await signedPack();
    const rows = readRows(pack);
    // Strip _meta.sig: JSON.stringify omits an `undefined` value, so the header carries no signature.
    (rows[0]!._meta as Dict).sig = undefined;
    writeFileSync(pack, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const [ok, detail] = verify(pack, { key: 's3cret' });
    expect(ok).toBe(false);
    expect(detail).toContain('signature');
  });

  it('no-key detail flags unauthenticated _meta', async () => {
    const { pack } = await signedPack();
    const [ok, detail] = verify(pack);
    expect(ok).toBe(true);
    expect(detail).toContain('unauthenticated');
    expect(detail).toContain('expected_head');
  });

  it('entry swap / reordering is detected', async () => {
    const path = tmpFile('raw.jsonl');
    const log = new AuditLog('s', { path });
    for (let i = 0; i < 4; i++) await log.decision(async () => {}, { input: `x${i}` });
    log.detach();
    const lines = readFileSync(path, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    [lines[1], lines[2]] = [lines[2]!, lines[1]!];
    writeFileSync(path, `${lines.join('\n')}\n`);
    const [ok, detail] = verify(path);
    expect(ok).toBe(false);
    expect(detail.includes('broken link') || detail.includes('tampered')).toBe(true);
  });
});

describe('verify robustness + cli', () => {
  it('missing file returns false, not a throw', () => {
    const [ok, detail] = verify(join(tmpdir(), 'acttrace-nope', 'x.jsonl'));
    expect(ok).toBe(false);
    expect(detail).toContain('cannot read');
  });

  it('corrupt json returns false, not a throw', () => {
    const path = tmpFile('corrupt.jsonl');
    writeFileSync(path, '{not valid json\n');
    const [ok, detail] = verify(path);
    expect(ok).toBe(false);
    expect(detail).toContain('corrupt');
  });

  it('cli verify: 0 on ok, 1 after tampering', async () => {
    const path = tmpFile();
    const log = new AuditLog('s', { path });
    log.detach();
    expect(main(['verify', path])).toBe(0);
    writeFileSync(path, readFileSync(path, 'utf-8').replace('"system"', '"SYSTEM"'));
    expect(main(['verify', path])).toBe(1);
  });

  it('cli missing file exits non-zero cleanly', () => {
    expect(main(['verify', join(tmpdir(), 'acttrace-nope', 'nope.jsonl')])).toBe(1);
  });

  it('detach stops capture (context-manager parity)', () => {
    const log = new AuditLog('cm');
    expect(log.head).toBeTruthy();
    const before = log.entries.length;
    log.detach();
    bus.emit(new LLMCall({ id: '1', provider: 'openai', model: 'gpt-4o', messages: [] }));
    expect(log.entries.length).toBe(before);
  });

  it('concurrent-style emits keep the chain intact', async () => {
    const path = tmpFile('concurrent.jsonl');
    const log = new AuditLog('s', { path });
    const threadsN = 6;
    const per = 30;
    for (let w = 0; w < threadsN; w++) {
      for (let i = 0; i < per; i++) {
        bus.emit(
          new LLMCall({
            id: `${w}-${i}`,
            provider: 'openai',
            model: 'gpt-4o',
            messages: [],
            usage: new Usage({ inputTokens: 1, outputTokens: 1 }),
            cost: new Money('0'),
          }),
        );
      }
    }
    log.detach();
    const expected = 1 + threadsN * per;
    expect(log.entries.length).toBe(expected);
    const [ok, detail] = verify(path, { expectEntries: expected });
    expect(ok, detail).toBe(true);
  });
});
