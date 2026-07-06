/**
 * Policy resolution and the pure `scan` / `redact` surface for `@cendor/acttrace` — the TS port of
 * `cendor.acttrace.policy`.
 *
 * A {@link Policy} maps a detected category (or its group) to an **action** —
 * `allow` · `flag` · `redact` · `block` — so the same detection engine can serve very different
 * postures. {@link scan} reports what's present (counts only, never raw values); {@link redact}
 * returns a scrubbed copy plus those findings. Neither touches the audit chain or the network.
 */

import { type Detector, scanCounts, scrub } from './detectors.js';

/** The allowed policy actions, from most permissive to most severe. */
export const ACTIONS = ['allow', 'flag', 'redact', 'block'] as const;
export type Action = (typeof ACTIONS)[number];

/** Actions that cause {@link redact} (and the built-in `AuditLog` path) to scrub the value. */
const SCRUB_ACTIONS: ReadonlySet<string> = new Set(['redact', 'block']);

/**
 * Maps each detected category → an action, with a fallthrough `default`. Keys in `actions` may be a
 * specific **category** (`"credit_card"`) or a **group** (`"financial"`); a category-specific entry
 * wins over its group, which wins over `default`.
 */
export class Policy {
  actions: Record<string, string>;
  private readonly _default: string;

  constructor(actions?: Record<string, string> | null, defaultAction = 'flag') {
    this.actions = { ...(actions ?? {}) };
    this._default = defaultAction;
  }

  /** The fallthrough action for a category not named (by category or group) in `actions`. */
  get defaultAction(): string {
    return this._default;
  }

  /** Resolve the action for a category (most specific wins: category → group → default). */
  actionFor(category: string, group = ''): string {
    if (Object.hasOwn(this.actions, category)) return this.actions[category]!;
    if (group && Object.hasOwn(this.actions, group)) return this.actions[group]!;
    return this._default;
  }

  toString(): string {
    return `Policy(actions=${JSON.stringify(this.actions)}, default=${JSON.stringify(this._default)})`;
  }

  equals(other: unknown): boolean {
    if (!(other instanceof Policy)) return false;
    const a = this.actions;
    const b = other.actions;
    const ak = Object.keys(a);
    if (ak.length !== Object.keys(b).length) return false;
    for (const k of ak) {
      if (a[k] !== b[k]) return false;
    }
    return this._default === other._default;
  }

  /** Today's behaviour: secrets and email are `redact`ed, everything else is `flag`ged. */
  static default(): Policy {
    return new Policy({ secret: 'redact', email: 'redact' }, 'flag');
  }

  /** GDPR-leaning: special-category data `block`, other personal/secret data `redact`. */
  static gdpr(): Policy {
    return new Policy(
      {
        special_category: 'block',
        pii: 'redact',
        gov_id: 'redact',
        financial: 'redact',
        secret: 'redact',
        credential: 'block',
      },
      'flag',
    );
  }

  /** PCI-leaning: payment/financial data `block`; secrets & PII `redact`. */
  static pci(): Policy {
    return new Policy({ financial: 'block', secret: 'redact', pii: 'redact' }, 'flag');
  }

  /** Highest recall: high-severity groups `block`, everything else `redact`. */
  static strict(): Policy {
    return new Policy(
      { secret: 'block', credential: 'block', financial: 'block', gov_id: 'block' },
      'redact',
    );
  }
}

/** One category detected in a payload — a count and its resolved action, never the raw value. */
export class Finding {
  constructor(
    public readonly category: string,
    public readonly group: string,
    public readonly severity: string,
    public readonly action: string,
    public readonly count: number,
  ) {}
}

/**
 * Detect sensitive data in `obj` (str/dict/list) and resolve each category to an action. Returns one
 * {@link Finding} per detected category, sorted by category. Reports **counts only**.
 */
export function scan(obj: unknown, policy?: Policy | null): Finding[] {
  const p = policy ?? Policy.default();
  const findings: Finding[] = [];
  for (const [category, [det, count]] of scanCounts(obj)) {
    const action = p.actionFor(det.category, det.group);
    findings.push(new Finding(category, det.group, det.severity, action, count));
  }
  findings.sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  return findings;
}

/**
 * Scrub `obj` per `policy` and return `[cleaned, findings]`. Only categories whose resolved action is
 * `redact` or `block` are scrubbed; `flag`/`allow` categories are reported but left in place.
 */
export function redact<T>(obj: T, policy?: Policy | null): [T, Finding[]] {
  const findings = scan(obj, policy);
  const toScrub = new Set(
    findings.filter((f) => SCRUB_ACTIONS.has(f.action)).map((f) => f.category),
  );
  const cleaned = toScrub.size ? scrub(obj, toScrub) : obj;
  return [cleaned, findings];
}

export type { Detector };
