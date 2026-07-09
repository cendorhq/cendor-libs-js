/**
 * `@cendor/acttrace` — a tamper-evident, auto-populated audit log for AI decisions. The TS port of
 * `cendor.acttrace` (regex/pattern detectors only; no Presidio).
 *
 * Construct an {@link AuditLog} and it **subscribes** to `@cendor/core`'s event stream: every
 * instrumented model/tool call — and the context decisions `@cendor/contextkit` rides on the same
 * stream — becomes an audit entry with no per-call wiring. You add only the explicit human-facing
 * events (`decision`, `humanOversight`).
 *
 * Integrity comes from a **hash chain**, not a server: `entry.hash = sha256(prev_hash +
 * canonical(entry))`, so editing any past entry breaks every entry after it. {@link verify} re-walks
 * the chain offline. Byte-conformant with the Python implementation: the canonical bytes that are
 * hashed (and the HMAC inputs) are identical across languages.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { LLMCall, ToolCall, Usage, bus } from '@cendor/core';
import {
  DETECTORS,
  type Detector,
  detectors,
  groupOf,
  registerDetector,
  scanCounts,
  scrub,
} from './detectors.js';
import { PolicyViolation, guard } from './guard.js';
import { hmacSha256Hex, sha256Hex, timingSafeEqualHex } from './hash.js';
import { nerAvailable, nerRedactor } from './ner.js';
import { LOCALE_PACKS, enableEntropyDetector, enableLocalePack } from './packs.js';
import { Finding, Policy, redact, scan } from './policy.js';
import { PyFloat, type PyValue, canonical, dumpsDefault, parsePreserving } from './pyjson.js';
import { type ChainStorage, fsChainStorage, fsReadLines, memoryChainStorage } from './storage.js';

export {
  DETECTORS,
  registerDetector,
  detectors,
  Policy,
  Finding,
  scan,
  redact,
  guard,
  PolicyViolation,
  enableLocalePack,
  enableEntropyDetector,
  LOCALE_PACKS,
  nerAvailable,
  nerRedactor,
};
export type { Detector };

/** The `prev_hash` of the first entry: 64 ASCII zeros. */
export const GENESIS = '0'.repeat(64);

/** Named error mirroring Python's `ValueError` (message substring is the contract). */
class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

/**
 * Warned when `AuditLog({ maxEntries })` is set without `path`. Bounding the in-memory ring relies on
 * the file as the source of truth; without a path, evicted entries are lost entirely.
 */
export class BoundedMemoryWithoutPathWarning extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoundedMemoryWithoutPathWarning';
  }
}

// acttrace's own decision-correlation context (a 32-hex id) — independent of core's trace id.
const activeDecision = new AsyncLocalStorage<string>();

function currentDecision(): string | null {
  return activeDecision.getStore() ?? null;
}

// --------------------------------------------------------------------------- framework tables

/** event type -> framework control IDs (starting templates, NOT legal advice). */
const CONTROLS: Record<string, Record<string, string[]>> = {
  eu_ai_act: {
    audit_open: ['Art.12 record-keeping', 'Art.19 automatically generated logs'],
    decision: ['Art.12 record-keeping', 'Art.13 transparency'],
    decision_record: ['Art.12 record-keeping', 'Art.13 transparency'],
    decision_end: ['Art.12 record-keeping'],
    llm_call: [
      'Art.12 logging',
      'Art.19 automatically generated logs',
      'Art.72 post-market monitoring',
    ],
    tool_call: ['Art.12 logging', 'Art.19 automatically generated logs'],
    context_assembly: ['Art.12 logging', 'Art.13 transparency'],
    human_oversight: ['Art.14 human oversight', 'Art.26(5) deployer oversight'],
    policy_flag: ['Art.10 data governance', 'Art.12 record-keeping'],
  },
  nist_rmf: {
    audit_open: ['GOVERN-1.1'],
    decision: ['MAP-1.1', 'MEASURE-2.1'],
    decision_record: ['MEASURE-2.1'],
    decision_end: ['MEASURE-2.1'],
    llm_call: ['MEASURE-2.1'],
    tool_call: ['MEASURE-2.1'],
    context_assembly: ['MEASURE-2.1'],
    human_oversight: ['MANAGE-2.1'],
    policy_flag: ['MANAGE-2.1', 'MEASURE-2.1'],
  },
  iso_42001: {
    audit_open: ['A.6.2.8 event logs'],
    decision: ['A.6.2.8 event logs', 'A.5.2 AI system impact assessment'],
    decision_record: ['A.6.2.8 event logs'],
    decision_end: ['A.6.2.8 event logs'],
    llm_call: [
      'A.6.2.8 event logs',
      'A.6.2.6 operation & monitoring',
      'Cl.9.1 monitoring & measurement',
    ],
    tool_call: ['A.6.2.8 event logs', 'A.6.2.6 operation & monitoring'],
    context_assembly: ['A.6.2.8 event logs', 'A.6.2.6 operation & monitoring'],
    human_oversight: ['A.9.2 responsible use', 'A.9.4 intended use'],
    policy_flag: ['A.7 data for AI systems', 'A.6.2.8 event logs', 'A.9.2 responsible use'],
  },
  gdpr: {
    audit_open: ['Art.30 records of processing', 'Art.5(2) accountability'],
    decision: ['Art.22 automated decision-making', 'Art.5(2) accountability'],
    decision_record: ['Art.22 automated decision-making'],
    decision_end: ['Art.30 records of processing'],
    llm_call: ['Art.30 records of processing'],
    tool_call: ['Art.30 records of processing'],
    context_assembly: ['Art.30 records of processing'],
    human_oversight: ['Art.22(3) right to human intervention'],
    policy_flag: [
      'Art.9 special-category data',
      'Art.5(1)(c) data minimisation',
      'Art.30 records of processing',
    ],
  },
};

/** Category/group-specific control pointers layered on top of the per-type `policy_flag` mapping. */
const CATEGORY_CONTROLS: Record<string, Record<string, string[]>> = {
  special_category: {
    gdpr: ['Art.9 special-category data'],
    eu_ai_act: ['Art.10(5) special categories for bias detection'],
  },
  gov_id: {
    gdpr: ['Art.87 processing of national identification numbers'],
  },
  financial: {
    gdpr: ['PCI-DSS 3.3/3.4 (payment-card data — cross-reference)'],
    eu_ai_act: ['PCI-DSS 3.3/3.4 (payment-card data — cross-reference)'],
  },
  pii: {
    gdpr: ['Art.4(1) personal data', 'Art.5(1)(c) data minimisation'],
  },
  secret: {
    gdpr: ['Art.32 security of processing'],
  },
  credential: {
    gdpr: ['Art.32 security of processing'],
  },
};

/** Frameworks with a bundled (starting-template) control mapping for {@link AuditLog.export}. */
export function frameworks(): string[] {
  return Object.keys(CONTROLS).sort();
}

function controlsForEntry(
  entry: AuditEntry,
  framework: string,
  controls: Record<string, string[]>,
): string[] {
  const result = [...(controls[entry.type] ?? [])];
  if (entry.type !== 'policy_flag') return result;
  const payload = entry.payload as Record<string, PyValue> | null;
  const data = payload && typeof payload === 'object' ? payload.data : undefined;
  const cats: PyValue[] = Array.isArray(data) ? data : typeof data === 'string' ? [data] : [];
  for (const cat of cats) {
    const keys: (string | null)[] = [
      typeof cat === 'string' ? cat : null,
      typeof cat === 'string' ? groupOf(cat) : null,
    ];
    for (const key of keys) {
      if (key === null) continue;
      for (const control of CATEGORY_CONTROLS[key]?.[framework] ?? []) {
        if (!result.includes(control)) result.push(control);
      }
    }
  }
  return result;
}

// --------------------------------------------------------------------------- canonicalization

/** Map a core {@link Usage} to the snake_case wire dict, in Python field order (all ints). */
function usageJsonable(u: Usage): PyValue {
  return {
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    cached_tokens: u.cachedTokens,
    reasoning_tokens: u.reasoningTokens,
    cache_write: u.cacheWrite,
  };
}

function isPlainObject(o: unknown): o is Record<string, unknown> {
  if (o === null || typeof o !== 'object') return false;
  const proto = Object.getPrototypeOf(o);
  return proto === Object.prototype || proto === null;
}

/**
 * Normalize an arbitrary value to a JSON-plain {@link PyValue} — mirroring Python `_jsonable`'s exact
 * branch order (bool/int/float/str, datetime, dict, list/tuple, Money duck-type before generic
 * `__dict__`, `vars()` fields only). Preserves int vs float (bigint/{@link PyFloat}).
 */
function jsonable(obj: unknown): PyValue {
  if (obj === null || obj === undefined) return null;
  const t = typeof obj;
  if (t === 'boolean') return obj as boolean;
  if (t === 'bigint') return obj as bigint;
  if (obj instanceof PyFloat) return obj;
  if (t === 'number') return obj as number;
  if (t === 'string') return obj as string;
  if (obj instanceof Date) return obj.toISOString();
  if (Array.isArray(obj)) return obj.map(jsonable);
  if (obj instanceof Usage) return usageJsonable(obj);
  if (t === 'object') {
    // Plain dict: recurse, stringifying keys (Python `{str(k): _jsonable(v)}`).
    if (isPlainObject(obj)) {
      const out: Record<string, PyValue> = {};
      for (const [k, v] of Object.entries(obj)) out[String(k)] = jsonable(v);
      return out;
    }
    const o = obj as Record<string, unknown>;
    // Money duck-type (checked before the generic `__dict__` branch).
    if ('amount' in o && 'currency' in o) return `${String(o.amount)} ${String(o.currency)}`;
    // Any other object with fields -> recurse over its own enumerable attributes (like `vars()`).
    const out: Record<string, PyValue> = {};
    for (const [k, v] of Object.entries(o)) out[String(k)] = jsonable(v);
    return out;
  }
  return String(obj);
}

/** `sha256(prev_hash + canonical({payload, seq, ts, type}))` — prev_hash TEXT-prepended, 4 keys. */
export function chainHash(
  prevHash: string,
  seq: PyValue,
  ts: PyValue,
  etype: PyValue,
  payload: PyValue,
): string {
  const body = canonical({ seq, ts, type: etype, payload });
  return sha256Hex(prevHash + body);
}

/** HMAC over an export `_meta` header's four completeness fields (entries, head_hash, risk_tier, system). */
export function metaSignature(
  key: string | Uint8Array,
  meta: { system?: PyValue; risk_tier?: PyValue; head_hash?: PyValue; entries?: PyValue },
): string {
  const body = canonical({
    system: meta.system ?? null,
    risk_tier: meta.risk_tier ?? null,
    head_hash: meta.head_hash ?? null,
    entries: meta.entries ?? null,
  });
  return hmacSha256Hex(key, body);
}

// --------------------------------------------------------------------------- auto-flag machinery

/** Types that carry caller content; a detection in one is worth a follow-up flag. */
const AUTO_REDACT_TYPES: ReadonlySet<string> = new Set([
  'decision',
  'decision_record',
  'llm_call',
  'tool_call',
  'context_assembly',
]);

const ACTION_VERB: Record<string, string> = {
  block: 'blocked',
  redact: 'redacted',
  flag: 'flagged',
};
const SEVERITY_RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 };

function maxSeverity(severities: Iterable<string>): string {
  let best = 'warning';
  let bestRank = -1;
  for (const s of severities) {
    const rank = SEVERITY_RANK[s] ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = s;
    }
  }
  return best;
}

type AutoFlagRow = [reason: string, action: string, severity: string, data: string[]];

function autoFlagsFor(
  counts: Map<string, [Detector, number]>,
  policy: Policy,
  etype: string,
): AutoFlagRow[] {
  const byAction = new Map<string, [string, string][]>();
  for (const [, [det]] of counts) {
    const action = policy.actionFor(det.category, det.group);
    if (action === 'allow') continue;
    if (!byAction.has(action)) byAction.set(action, []);
    byAction.get(action)!.push([det.category, det.severity]);
  }
  const rows: AutoFlagRow[] = [];
  for (const action of ['block', 'redact', 'flag']) {
    const items = byAction.get(action);
    if (!items || items.length === 0) continue;
    const cats = [...new Set(items.map((i) => i[0]))].sort();
    const verb = ACTION_VERB[action]!;
    const severity = action === 'redact' ? 'info' : maxSeverity(items.map((i) => i[1]));
    rows.push([`${verb} ${cats.join(', ')} from ${etype}`, verb, severity, cats]);
  }
  return rows;
}

// --------------------------------------------------------------------------- entry / log

/** One link in the hash chain. Field order == on-disk key order. */
export class AuditEntry {
  constructor(
    public readonly seq: number | bigint,
    public readonly ts: string,
    public readonly type: string,
    public readonly payload: PyValue,
    public readonly prev_hash: string,
    public readonly hash: string,
    public readonly sig: string = '',
  ) {}
}

function entryToRow(entry: AuditEntry): Record<string, PyValue> {
  return {
    seq: entry.seq,
    ts: entry.ts,
    type: entry.type,
    payload: entry.payload,
    prev_hash: entry.prev_hash,
    hash: entry.hash,
    sig: entry.sig,
  };
}

/** The built-in redactor (secrets & email under the default policy). Also the built-in-path sentinel. */
const DEFAULT_POLICY = Policy.default();
export function defaultRedactor(obj: unknown): unknown {
  return redact(obj, DEFAULT_POLICY)[0];
}

export interface FlagOptions {
  action?: string;
  severity?: string;
  data?: unknown;
  /** Extra payload fields (Python `**fields`), e.g. `{ auto: true }`. */
  extra?: Record<string, unknown>;
}

export interface AuditLogOptions {
  riskTier?: string;
  path?: string | null;
  signingKey?: string | Uint8Array | null;
  redact?: boolean;
  redactor?: ((obj: unknown) => unknown) | null;
  flagOnRedact?: boolean;
  policy?: Policy | null;
  maxEntries?: number | null;
  /** Advanced: override the chain storage backend (defaults to fs when `path` is set, else memory). */
  storage?: ChainStorage;
}

/** A hash-chained, append-only, auto-populating audit log. */
export class AuditLog {
  readonly system: string;
  readonly riskTier: string;
  entries: AuditEntry[] = [];
  private readonly _signingKey: string | Uint8Array | null;
  private readonly _redact: boolean;
  private readonly _policy: Policy;
  private readonly _redactor: (obj: unknown) => unknown;
  private readonly _flagOnRedact: boolean;
  private readonly _maxEntries: number | null;
  private readonly _path: string | null;
  private readonly _storage: ChainStorage;
  private _seq = 0;
  private _evictedFromMemory = 0;
  private _head = GENESIS;

  constructor(system: string, opts: AuditLogOptions = {}) {
    const {
      riskTier = 'limited',
      path = null,
      signingKey = null,
      redact: redactOpt = true,
      redactor = null,
      flagOnRedact = true,
      policy = null,
      maxEntries = null,
      storage,
    } = opts;
    if (maxEntries !== null && maxEntries < 1) {
      throw new ValueError(`max_entries must be a positive int or None, got ${maxEntries}`);
    }
    this.system = system;
    this.riskTier = riskTier;
    this._signingKey = signingKey ?? null;
    this._redact = redactOpt || policy !== null;
    this._policy = policy ?? Policy.default();
    this._redactor = redactor ?? defaultRedactor;
    this._flagOnRedact = flagOnRedact;
    this._path = path;
    if (maxEntries !== null && path === null) {
      process.emitWarning(
        new BoundedMemoryWithoutPathWarning(
          'AuditLog(maxEntries) without path: evicted entries are lost because the file is the ' +
            'source of truth. Pass path to keep the full chain on disk.',
        ),
      );
    }
    this._maxEntries = maxEntries;
    // Append-open (not truncate) so reopening an existing log preserves it and we can resume the
    // chain. `export()` still uses a truncating fsChainStorage — this append mode is the live log only.
    this._storage =
      storage ?? (path !== null ? fsChainStorage(path, { append: true }) : memoryChainStorage());
    // Resume an existing chain instead of restarting it: if the backing store already holds entries
    // (a non-empty log file being reopened), continue from its head with NO fresh `audit_open`. A
    // pristine store (fresh/empty file, memory backend) keeps the original behaviour: seed audit_open.
    const existing = this._storage
      .readLines()
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('{"_meta"'));
    if (existing.length > 0) {
      this._resume(existing);
    } else {
      this._append('audit_open', { system, risk_tier: riskTier });
    }
    bus.subscribe(this._onEvent);
  }

  /**
   * @internal Rehydrate from an existing on-disk chain (reopen/resume). Sets `_head`/`_seq` from the
   * last entry, loads the tail into memory honouring `maxEntries` (older entries stay only on disk and
   * are counted as evicted so `export()` re-reads the full file), and does NOT emit `audit_open` — a
   * pure continuation. Throws if a retained line is unparseable: a corrupt tail fails loudly rather
   * than silently restarting the chain from GENESIS.
   */
  private _resume(dataLines: string[]): void {
    const total = dataLines.length;
    const keep = this._maxEntries !== null ? Math.min(this._maxEntries, total) : total;
    const tail = dataLines.slice(total - keep);
    const rehydrated = tail.map((line) => this._parseResumedEntry(line));
    const last = rehydrated[rehydrated.length - 1]!; // total > 0 ⇒ keep ≥ 1 ⇒ last exists
    this.entries = rehydrated;
    this._head = last.hash;
    this._seq = Number(last.seq) + 1;
    this._evictedFromMemory = total - keep;
  }

  /** @internal Parse one persisted JSONL entry when resuming; throw a clear error if it is corrupt. */
  private _parseResumedEntry(line: string): AuditEntry {
    let row: PyValue;
    try {
      row = parsePreserving(line);
    } catch (e) {
      throw new ValueError(
        `cannot resume audit log ${this._path}: corrupt entry line: ${errMessage(e)}`,
      );
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new ValueError(`cannot resume audit log ${this._path}: entry is not a JSON object`);
    }
    const obj = row as Record<string, PyValue>;
    for (const field of ['seq', 'ts', 'type', 'prev_hash', 'hash']) {
      if (!(field in obj)) {
        throw new ValueError(`cannot resume audit log ${this._path}: entry missing '${field}'`);
      }
    }
    return new AuditEntry(
      obj.seq as number | bigint,
      obj.ts as string,
      obj.type as string,
      obj.payload ?? null,
      obj.prev_hash as string,
      obj.hash as string,
      typeof obj.sig === 'string' ? obj.sig : '',
    );
  }

  /** The current chain head hash. Capture it to later assert completeness via `verify`. */
  get head(): string {
    return this._head;
  }

  /** Entries evicted from the in-memory ring by `maxEntries` (0 if unbounded). Never left the chain. */
  get evictedFromMemory(): number {
    return this._evictedFromMemory;
  }

  private now(): string {
    return new Date().toISOString();
  }

  // ------------------------------------------------------------------ chain

  /** @internal Append one chain link. Also invoked by {@link Decision}. */
  _append(etype: string, payload: Record<string, unknown>): AuditEntry {
    const seq = this._seq;
    this._seq += 1;
    const ts = this.now();
    let safe: PyValue = jsonable(payload);
    let autoFlags: AutoFlagRow[] = [];
    if (this._redact) {
      if (this._redactor === defaultRedactor) {
        const counts = scanCounts(safe);
        if (counts.size > 0) {
          const toScrub = new Set<string>();
          for (const [cat, [det]] of counts) {
            const action = this._policy.actionFor(det.category, det.group);
            if (action === 'redact' || action === 'block') toScrub.add(cat);
          }
          if (toScrub.size > 0) safe = scrub(safe, toScrub);
          if (AUTO_REDACT_TYPES.has(etype) && this._flagOnRedact) {
            autoFlags = autoFlagsFor(counts, this._policy, etype);
          }
        }
      } else {
        safe = jsonable(this._redactor(safe));
      }
    }
    const h = chainHash(this._head, seq, ts, etype, safe);
    const sig = this._signingKey !== null ? hmacSha256Hex(this._signingKey, h) : '';
    const entry = new AuditEntry(seq, ts, etype, safe, this._head, h, sig);
    if (this._maxEntries !== null && this.entries.length === this._maxEntries) {
      this._evictedFromMemory += 1;
      this.entries.shift(); // drop the oldest, loudly counted above
    }
    this.entries.push(entry);
    this._head = h;
    this._storage.appendLine(`${dumpsDefault(entryToRow(entry))}\n`);
    // OUTSIDE the "lock": each auto-flag is its own chained policy_flag entry (auto:true), tagged to
    // the active decision. policy_flag is not an auto type, so this never recurses.
    for (const [reason, action, severity, data] of autoFlags) {
      this.flag(reason, { action, severity, data, extra: { auto: true } });
    }
    return entry;
  }

  // ------------------------------------------------------------------ auto-capture

  private readonly _onEvent = (event: unknown): void => {
    const did = currentDecision();
    if (event instanceof LLMCall) {
      this._append('llm_call', {
        decision_id: did,
        provider: event.provider,
        model: event.model,
        usage: event.usage === null ? null : usageJsonable(event.usage),
        cost: event.cost === null ? null : event.cost.toString(),
        latency_ms: event.latencyMs === null ? null : new PyFloat(event.latencyMs),
        replayed: Boolean(event.metadata?.replayed ?? false),
      });
    } else if (event instanceof ToolCall) {
      this._append('tool_call', {
        decision_id: did,
        name: event.name,
        arguments: jsonable(event.arguments),
      });
    } else if (
      event !== null &&
      typeof event === 'object' &&
      'decisions' in event &&
      'budget' in event
    ) {
      const e = event as Record<string, unknown>;
      this._append('context_assembly', {
        decision_id: did,
        model: e.model ?? null,
        budget: e.budget,
        used: e.used ?? null,
        decisions: jsonable(e.decisions),
      });
    } else if (
      event !== null &&
      typeof event === 'object' &&
      'guardrail' in event &&
      'stage' in event &&
      'action' in event
    ) {
      // @cendor/guardrails GuardrailDecision — duck-typed, no import (see contextkit branch above).
      const e = event as Record<string, unknown>;
      this._append('guardrail_decision', {
        decision_id: did,
        guardrail: e.guardrail,
        stage: e.stage,
        action: e.action,
        reason: e.reason ?? '',
        agent: e.agent ?? '',
        tool: e.tool ?? '',
      });
    }
  };

  /** Stop subscribing to the core event stream and close the log file handle (idempotent). */
  detach(): void {
    bus.unsubscribe(this._onEvent);
    this._storage.close();
  }

  // ------------------------------------------------------------------ explicit events

  /**
   * Group a unit of work. Auto-captured calls inside the async callback are tagged with this
   * decision (via an `AsyncLocalStorage` scope). Returns the callback's result.
   */
  async decision<T>(
    cb: (d: Decision) => T | Promise<T>,
    opts: { input?: unknown; actor?: string } = {},
  ): Promise<T> {
    const did = uuidHex();
    const actor = opts.actor ?? 'agent';
    this._append('decision', { decision_id: did, input: jsonable(opts.input ?? null), actor });
    try {
      return await activeDecision.run(did, async () => cb(new Decision(this, did)));
    } finally {
      this._append('decision_end', { decision_id: did });
    }
  }

  /**
   * Record a policy flag — a tamper-evident record that a data/usage policy fired. `action`/`severity`
   * are normalized to lowercase; pass a category label in `data`, never the raw value. Auto-tags the
   * active decision span.
   */
  flag(reason: string, opts: FlagOptions = {}): AuditEntry {
    return this._append('policy_flag', {
      decision_id: currentDecision(),
      reason,
      action: String(opts.action ?? 'flagged').toLowerCase(),
      severity: String(opts.severity ?? 'warning').toLowerCase(),
      data: opts.data ?? null,
      ...(opts.extra ?? {}),
    });
  }

  // ------------------------------------------------------------------ export

  private entriesForExport(): AuditEntry[] {
    if (this._evictedFromMemory === 0 || this._path === null) return [...this.entries];
    const entries: AuditEntry[] = [];
    for (const raw of this._storage.readLines()) {
      const line = raw.trim();
      if (!line) continue;
      const row = parsePreserving(line);
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
      const obj = row as Record<string, PyValue>;
      if ('_meta' in obj) continue; // a header from a previous export in the same file — skip
      entries.push(
        new AuditEntry(
          obj.seq as number | bigint,
          obj.ts as string,
          obj.type as string,
          obj.payload ?? null,
          obj.prev_hash as string,
          obj.hash as string,
          (obj.sig as string) ?? '',
        ),
      );
    }
    return entries;
  }

  private summary(entries: AuditEntry[]): PyValue {
    const countType = (t: string): number => entries.filter((e) => e.type === t).length;
    const flags = entries.filter((e) => e.type === 'policy_flag');
    const counter = (values: (PyValue | undefined)[]): Record<string, PyValue> => {
      const m: Record<string, PyValue> = {};
      for (const v of values) {
        const k = String(v);
        m[k] = ((m[k] as number | undefined) ?? 0) + 1;
      }
      return m;
    };
    return {
      decisions: countType('decision'),
      llm_calls: countType('llm_call'),
      tool_calls: countType('tool_call'),
      context_assemblies: countType('context_assembly'),
      human_oversight: countType('human_oversight'),
      policy_flags: flags.length,
      flags_by_action: counter(flags.map((f) => (f.payload as Record<string, PyValue>).action)),
      flags_by_severity: counter(flags.map((f) => (f.payload as Record<string, PyValue>).severity)),
    };
  }

  /** Write the chain as a JSONL evidence pack, optionally annotated with framework control IDs. */
  export(path: string, framework: string | null = null): void {
    if (framework && !(framework in CONTROLS)) {
      throw new ValueError(
        `unknown framework '${framework}'; available: ${frameworks().join(', ')}`,
      );
    }
    const controls = CONTROLS[framework ?? ''] ?? {};
    const entries = this.entriesForExport();
    const coveredSet = new Set<string>();
    for (const e of entries) {
      for (const c of controlsForEntry(e, framework ?? '', controls)) coveredSet.add(c);
    }
    const covered = [...coveredSet].sort();
    const out = fsChainStorage(path);
    try {
      const metaBody: Record<string, PyValue> = {
        system: this.system,
        risk_tier: this.riskTier,
        framework: framework,
        controls_covered: covered,
        summary: this.summary(entries),
        head_hash: this._head,
        entries: entries.length,
        disclaimer: 'Evidence to support compliance — not legal advice.',
      };
      if (this._signingKey !== null) {
        metaBody.sig = metaSignature(this._signingKey, metaBody);
      }
      out.appendLine(`${dumpsDefault({ _meta: metaBody })}\n`);
      for (const entry of entries) {
        const row = entryToRow(entry);
        if (framework) row.controls = controlsForEntry(entry, framework, controls);
        out.appendLine(`${dumpsDefault(row)}\n`);
      }
    } finally {
      out.close();
    }
  }
}

/** Handle for the active decision span (passed to the {@link AuditLog.decision} callback). */
export class Decision {
  constructor(
    public readonly log: AuditLog,
    public readonly id: string,
  ) {}

  /** Record decision metadata (e.g. `{ model, prompt_id }`). */
  record(fields: Record<string, unknown>): void {
    this.log._append('decision_record', { decision_id: this.id, ...fields });
  }

  /** Record an Art. 14-style human-oversight event: who reviewed, what action, and a note. */
  humanOversight(reviewer: string, action: string, note = ''): void {
    this.log._append('human_oversight', {
      decision_id: this.id,
      reviewer,
      action,
      note,
    });
  }

  /** Record a policy flag tagged to this decision. Returns the chained {@link AuditEntry}. */
  flag(reason: string, opts: FlagOptions = {}): AuditEntry {
    return this.log._append('policy_flag', {
      decision_id: this.id,
      reason,
      action: String(opts.action ?? 'flagged').toLowerCase(),
      severity: String(opts.severity ?? 'warning').toLowerCase(),
      data: opts.data ?? null,
      ...(opts.extra ?? {}),
    });
  }
}

function uuidHex(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '');
}

// --------------------------------------------------------------------------- verify

export interface VerifyOptions {
  key?: string | Uint8Array | null;
  expectedHead?: string | null;
  expectEntries?: number | null;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Re-walk the hash chain in a JSONL file. Returns `[ok, detail]`. Detects edits and deletions,
 * including tail-truncation. Never throws on a missing/corrupt file — returns `[false, detail]`.
 */
export function verify(path: string, opts: VerifyOptions = {}): [boolean, string] {
  const key = opts.key ?? null;
  const expectedHead = opts.expectedHead ?? null;
  const expectEntries = opts.expectEntries ?? null;

  let prev = GENESIS;
  let seen = 0;
  let meta: Record<string, PyValue> | null = null;

  let text: string;
  try {
    text = fsReadLines(path).join('\n');
  } catch (e) {
    return [false, `cannot read ${path}: ${errMessage(e)}`];
  }

  // Split on the record separator only (not on Unicode line separators inside JSON strings).
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let row: PyValue;
    try {
      row = parsePreserving(line);
    } catch (e) {
      return [false, `corrupt log ${path}: ${errMessage(e)}`];
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return [false, `corrupt log ${path}: line is not an object`];
    }
    const obj = row as Record<string, PyValue>;
    if ('_meta' in obj) {
      const m = obj._meta;
      meta =
        m !== null && typeof m === 'object' && !Array.isArray(m)
          ? (m as Record<string, PyValue>)
          : {};
      continue;
    }
    for (const field of ['seq', 'ts', 'type', 'payload', 'prev_hash', 'hash']) {
      if (!(field in obj)) return [false, `corrupt log ${path}: missing '${field}'`];
    }
    const seqStr = String(obj.seq);
    const expected = chainHash(
      prev,
      obj.seq ?? null,
      obj.ts ?? null,
      obj.type ?? null,
      obj.payload ?? null,
    );
    if (obj.prev_hash !== prev) {
      return [false, `broken link at seq ${seqStr}: prev_hash mismatch`];
    }
    if (obj.hash !== expected) {
      return [false, `tampered entry at seq ${seqStr}: hash mismatch`];
    }
    if (key !== null) {
      const want = hmacSha256Hex(key, obj.hash as string);
      const sig = typeof obj.sig === 'string' ? obj.sig : '';
      if (!timingSafeEqualHex(sig, want)) {
        return [false, `bad signature at seq ${seqStr}`];
      }
    }
    prev = obj.hash as string;
    seen += 1;
  }

  const metaHead = meta !== null ? (meta.head_hash ?? null) : null;
  const metaEntries = meta !== null ? (meta.entries ?? null) : null;

  let metaTrusted = false;
  if (key !== null && meta !== null) {
    const providedSig = typeof meta.sig === 'string' ? meta.sig : '';
    if (!providedSig) {
      return [false, 'unauthenticated _meta: signed log but header carries no signature'];
    }
    if (!timingSafeEqualHex(providedSig, metaSignature(key, meta))) {
      return [false, 'forged _meta: header signature mismatch (completeness fields altered?)'];
    }
    metaTrusted = true;
  }

  const wantHead = expectedHead !== null ? expectedHead : metaHead;
  if (wantHead !== null && prev !== wantHead) {
    const wh = String(wantHead).slice(0, 12);
    return [
      false,
      `incomplete log: head ${prev.slice(0, 12)}… != expected ${wh}… (trailing entries removed?)`,
    ];
  }
  let wantN: bigint | null = null;
  if (expectEntries !== null) wantN = BigInt(expectEntries);
  else if (typeof metaEntries === 'bigint') wantN = metaEntries;
  else if (typeof metaEntries === 'number') wantN = BigInt(metaEntries);
  if (wantN !== null && BigInt(seen) !== wantN) {
    return [false, `incomplete log: found ${seen} entries, expected ${wantN} (entries removed?)`];
  }

  const notes: string[] = [];
  if (key !== null) {
    notes.push('signatures verified');
    if (metaTrusted) notes.push('metadata signature verified');
  } else if (meta !== null && expectedHead === null && expectEntries === null) {
    notes.push(
      'completeness from unauthenticated in-file _meta — pass expected_head/expect_entries ' +
        'out-of-band for an authoritative check',
    );
  }
  const suffix = notes.length ? ` (${notes.join('; ')})` : '';
  return [true, `ok: ${seen} entries, head ${prev.slice(0, 12)}…${suffix}`];
}

// --------------------------------------------------------------------------- CLI

/** `acttrace verify <path> [--key K] [--expect-head H] [--expect-entries N]`. Returns an exit code. */
export function main(argv: string[]): number {
  if (argv[0] !== 'verify' || argv.length < 2) return 2;
  const path = argv[1]!;
  let key: string | null = null;
  let expectedHead: string | null = null;
  let expectEntries: number | null = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--key') key = argv[++i] ?? null;
    else if (a === '--expect-head') expectedHead = argv[++i] ?? null;
    else if (a === '--expect-entries') {
      const v = argv[++i];
      expectEntries = v === undefined ? null : Number.parseInt(v, 10);
    }
  }
  const [ok, detail] = verify(path, { key, expectedHead, expectEntries });
  process.stdout.write(`${detail}\n`);
  return ok ? 0 : 1;
}
