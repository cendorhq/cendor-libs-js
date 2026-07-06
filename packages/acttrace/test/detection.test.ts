/** Detection engine + policy. Mirrors tests/test_detection.py. Offline, deterministic; no network. */
import { bus } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DETECTORS,
  type Detector,
  abaValid,
  bicValid,
  ibanMod97,
  luhn,
  scrub,
  ssnValid,
  verhoeff,
} from '../src/detectors.js';
import {
  AuditLog,
  Finding,
  Policy,
  defaultRedactor,
  redact,
  registerDetector,
  scan,
} from '../src/index.js';

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

describe('validators', () => {
  it.each([
    ['4111111111111111', true],
    ['4111 1111 1111 1111', true],
    ['5500005555555559', true],
    ['4111111111111112', false],
    ['1234567890123456', false],
    ['123', false],
  ] as const)('luhn(%s) === %s', (n, ok) => expect(luhn(n)).toBe(ok));

  it.each([
    ['GB82WEST12345698765432', true],
    ['GB82 WEST 1234 5698 7654 32', true],
    ['DE89370400440532013000', true],
    ['GB00WEST12345698765432', false],
    ['XX00', false],
  ] as const)('ibanMod97(%s) === %s', (n, ok) => expect(ibanMod97(n)).toBe(ok));

  it.each([
    ['2363', true],
    ['1428570', true],
    ['2364', false],
    ['1428571', false],
  ] as const)('verhoeff(%s) === %s', (n, ok) => expect(verhoeff(n)).toBe(ok));

  it.each([
    ['021000021', true],
    ['123456789', false],
    ['12345678', false],
  ] as const)('abaValid(%s) === %s', (n, ok) => expect(abaValid(n)).toBe(ok));

  it.each([
    ['123-45-6789', true],
    ['666-45-6789', false],
    ['000-45-6789', false],
    ['900-45-6789', false],
    ['123-00-6789', false],
    ['123-45-0000', false],
  ] as const)('ssnValid(%s) === %s', (n, ok) => expect(ssnValid(n)).toBe(ok));

  it('bicValid requires a valid ISO country code', () => {
    expect(bicValid('DEUTDEFF')).toBe(true);
    expect(bicValid('DEUTDEFF500')).toBe(true);
    expect(bicValid('ABCDZZFF')).toBe(false);
    expect(bicValid('SHORT')).toBe(false);
  });
});

describe('golden detections per category', () => {
  it.each([
    ['reach me at alice@example.com', 'email', 'pii'],
    ['key sk-ant-api03-ABCDEFGH12345678', 'api_key', 'secret'],
    [`aws AKIA${'A'.repeat(16)}`, 'aws_key', 'secret'],
    [`google AIza${'b'.repeat(35)}`, 'google_api_key', 'secret'],
    [`gh ghp_${'a'.repeat(36)}`, 'github_token', 'secret'],
    ['slack xoxb-123456789012-abcdef', 'slack_token', 'secret'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'private_key', 'secret'],
    ['the password is hunter2!', 'password', 'credential'],
    ['card 4111 1111 1111 1111 on file', 'credit_card', 'financial'],
    ['iban GB82WEST12345698765432 please', 'iban', 'financial'],
    ['routing 021000021 for wire', 'us_routing', 'financial'],
    ['bic DEUTDEFF for transfer', 'swift_bic', 'financial'],
    ['ssn 123-45-6789 on record', 'us_ssn', 'gov_id'],
    ['call 415-555-2671 tomorrow', 'phone', 'pii'],
    ['call +14155552671 now', 'phone', 'pii'],
    ['host at 192.168.1.1 up', 'ipv4', 'pii'],
    ['addr 2001:0db8:85a3::8a2e:0370:7334 up', 'ipv6', 'pii'],
    ['nic 01:23:45:67:89:ab reset', 'mac_address', 'pii'],
    ['patient diagnosis recorded', 'special_category', 'special_category'],
  ])('%s -> %s/%s', (text, category, group) => {
    const byCat = new Map(scan(text).map((f) => [f.category, f]));
    const finding = byCat.get(category);
    expect(finding, `${category} not detected in ${text}`).toBeDefined();
    expect(finding!.group).toBe(group);
    expect(finding!.count).toBeGreaterThanOrEqual(1);
  });

  it('scan resolves action + counts occurrences', () => {
    expect(scan('email a@b.com and again c@d.com')).toEqual([
      new Finding('email', 'pii', 'warning', 'redact', 2),
    ]);
  });
});

const FALSE_POSITIVE_CORPUS = [
  'INFO 2026-07-04T12:34:56.123456Z request_id=abc123 latency=123ms status=200',
  'commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b merged to main',
  '550e8400-e29b-41d4-a716-446655440000',
  'order ORD-2024-0001 shipped; tracking 1Z999AA10123456784',
  'a well-known best-practice for multi-region fail-over in us-east-1',
  'version v1.2.3 released; also 10.20.30 and build 2026',
  'color #3af5c2 padding 0 0 0 0 margin: 10px auto',
  'def multiply(x): return x * 2  # a multiply-by-two helper',
  'price was $1,234.56 and quantity 4 units in cart',
  'the 9-digit id 123456789 failed ABA; card 4111111111111112 fails luhn',
  'sha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'timestamp 12:34:56 on date 2026-07-04 in year 2026',
  'GET /api/v2/users?id=42&sort=name HTTP/1.1 200',
  'hex dump 0xDEADBEEF and 0xCAFEBABE at offset 16',
  'kubernetes pod nginx-7d8b49c9f4-xk2lm restarted 3 times',
];

describe('false-positive corpus is clean', () => {
  it.each(FALSE_POSITIVE_CORPUS)('no findings in: %s', (line) => {
    expect(scan(line)).toEqual([]);
  });

  it('validators gate loose matches', () => {
    expect(scan('card 4111111111111112')).toEqual([]);
    expect(scan('iban GB00WEST12345698765432')).toEqual([]);
    expect(scan('routing 123456789')).toEqual([]);
  });
});

describe('policy resolution', () => {
  it('default matches legacy behaviour', () => {
    const p = Policy.default();
    expect(p.actionFor('email', 'pii')).toBe('redact');
    expect(p.actionFor('api_key', 'secret')).toBe('redact');
    expect(p.actionFor('credit_card', 'financial')).toBe('flag');
    expect(p.actionFor('phone', 'pii')).toBe('flag');
  });

  it('presets', () => {
    expect(Policy.gdpr().actionFor('special_category', 'special_category')).toBe('block');
    expect(Policy.gdpr().actionFor('phone', 'pii')).toBe('redact');
    expect(Policy.pci().actionFor('credit_card', 'financial')).toBe('block');
    expect(Policy.strict().actionFor('api_key', 'secret')).toBe('block');
    expect(Policy.strict().actionFor('phone', 'pii')).toBe('redact');
  });

  it('specificity: category over group over default', () => {
    const p = new Policy({ financial: 'flag', credit_card: 'block' }, 'allow');
    expect(p.actionFor('credit_card', 'financial')).toBe('block');
    expect(p.actionFor('iban', 'financial')).toBe('flag');
    expect(p.actionFor('email', 'pii')).toBe('allow');
  });
});

describe('pure scan / redact', () => {
  it('redact scrubs only redact and block actions', () => {
    const [cleaned, findings] = redact(
      { e: 'a@b.com', card: '4111 1111 1111 1111' },
      Policy.default(),
    );
    expect(cleaned.e).toBe('<redacted>');
    expect(cleaned.card).toBe('4111 1111 1111 1111');
    const cats = Object.fromEntries(findings.map((f) => [f.category, f.action]));
    expect(cats).toEqual({ email: 'redact', credit_card: 'flag' });
  });

  it('pci blocks and scrubs card', () => {
    const [cleaned, findings] = redact({ card: '4111111111111111' }, Policy.pci());
    expect(cleaned.card).toBe('<redacted>');
    expect(findings.some((f) => f.category === 'credit_card' && f.action === 'block')).toBe(true);
  });

  it('default redactor is byte-identical for the original six', () => {
    const sample = {
      email: 'reach me at alice@example.com',
      api_key: 'sk-ant-api03-ABCDEFGH12345678',
      aws: `AKIA${'A'.repeat(16)}`,
      google: `AIza${'b'.repeat(35)}`,
      jwt: `eyJ${'a'.repeat(15)}.${'b'.repeat(15)}.${'c'.repeat(15)}`,
      bearer: 'Bearer abc.def-123',
    };
    const out = defaultRedactor(sample) as Record<string, string>;
    const blob = JSON.stringify(out);
    for (const raw of Object.values(sample)) expect(blob).not.toContain(raw);
    expect(blob.split('<redacted>').length - 1).toBe(6);
  });

  it('leaves hashes, uuids and ids untouched even under strict', () => {
    const ids = {
      uuid: '550e8400-e29b-41d4-a716-446655440000',
      sha: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b',
      hex64: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    };
    const [cleaned, findings] = redact(ids, Policy.strict());
    expect(cleaned).toEqual(ids);
    expect(findings).toEqual([]);
  });
});

describe('AuditLog(policy=)', () => {
  it('default policy redacts secrets, flags the rest', async () => {
    const log = new AuditLog('s');
    try {
      await log.decision(async () => {}, { input: { e: 'a@b.com', card: '4111 1111 1111 1111' } });
    } finally {
      log.detach();
    }
    const flags = new Map(
      log.entries
        .filter((e) => e.type === 'policy_flag')
        .map((e) => [(e.payload as Record<string, unknown>).action as string, e]),
    );
    expect(new Set(flags.keys())).toEqual(new Set(['redacted', 'flagged']));
    expect((flags.get('redacted')!.payload as Record<string, unknown>).data).toEqual(['email']);
    expect((flags.get('flagged')!.payload as Record<string, unknown>).data).toEqual([
      'credit_card',
    ]);
    expect((flags.get('flagged')!.payload as Record<string, unknown>).severity).toBe('critical');
    const decision = log.entries.find((e) => e.type === 'decision')!;
    const blob = JSON.stringify(decision.payload);
    expect(blob).not.toContain('a@b.com');
    expect(blob).toContain('4111 1111 1111 1111');
  });

  it('gdpr policy blocks special-category', async () => {
    const log = new AuditLog('s', { policy: Policy.gdpr() });
    try {
      await log.decision(async () => {}, {
        input: { note: 'patient diagnosis pending; ping a@b.com' },
      });
    } finally {
      log.detach();
    }
    const flags = new Map(
      log.entries
        .filter((e) => e.type === 'policy_flag')
        .map((e) => [(e.payload as Record<string, unknown>).action as string, e]),
    );
    expect((flags.get('blocked')!.payload as Record<string, unknown>).data).toEqual([
      'special_category',
    ]);
    expect((flags.get('redacted')!.payload as Record<string, unknown>).data).toEqual(['email']);
    const decision = log.entries.find((e) => e.type === 'decision')!;
    expect(JSON.stringify(decision.payload)).not.toContain('diagnosis');
  });

  it('an explicit policy turns scanning on even when redact=false', async () => {
    const log = new AuditLog('s', { redact: false, policy: Policy.pci() });
    try {
      await log.decision(async () => {}, { input: { card: '4111111111111111' } });
    } finally {
      log.detach();
    }
    const flags = log.entries.filter((e) => e.type === 'policy_flag');
    expect(flags.length).toBe(1);
    expect((flags[0]!.payload as Record<string, unknown>).action).toBe('blocked');
  });
});

describe('custom registry', () => {
  it('register_detector is picked up by scan and redact', () => {
    const original = [...DETECTORS];
    try {
      const det: Detector = {
        category: 'employee_id',
        group: 'gov_id',
        severity: 'warning',
        pattern: /\bEMP-\d{5}\b/g,
      };
      registerDetector(det);
      expect(scan('ticket for EMP-12345 opened').some((f) => f.category === 'employee_id')).toBe(
        true,
      );
      const [cleaned] = redact('EMP-12345', new Policy({ gov_id: 'redact' }));
      expect(cleaned).toBe('<redacted>');
    } finally {
      DETECTORS.length = 0;
      DETECTORS.push(...original);
    }
  });

  it('scrub applies registry order deterministically (jwt before bearer)', () => {
    const text = `Authorization: Bearer eyJ${'a'.repeat(15)}.${'b'.repeat(15)}.${'c'.repeat(15)}`;
    const out = scrub(text, new Set(['jwt', 'bearer_token']));
    expect(out).not.toContain('eyJ');
    expect(out).toContain('<redacted>');
  });
});
