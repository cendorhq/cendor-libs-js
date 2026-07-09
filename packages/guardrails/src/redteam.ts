/**
 * Red-team evaluation — measure a guardrail's trip rate against a labeled corpus. The TS port of
 * `cendor.guardrails.redteam`.
 *
 * The honest path to *any* detection number: run **your** guardrails over a labeled corpus and
 * publish the per-category trip rate + false-positive rate, naming the corpus. cendor **vends no
 * attack data** — `loadCorpus` parses records / text **you** supplied (public sets like AdvBench /
 * JailbreakBench / HackAPrompt are referenced in the docs; you fetch them under their own licenses).
 * There is no `node:fs` here — read the file yourself and pass the text or the parsed array. The
 * report is a measurement tool, not a claim.
 *
 * Deterministic guardrails make the run offline + reproducible; a run with an `llmJudge` / hosted
 * rail should be cassette-recorded so CI stays offline. Imports only `./decision` + the engine.
 */
import { type Guardrail, GuardrailTripped } from './decision.js';
import { apply, applyAsync } from './index.js';

export const ATTACK = 'attack';
export const BENIGN = 'benign';

/** One labeled probe. `label` is `"attack"` (should trip) or `"benign"` (should pass). */
export interface AttackCase {
  text: string;
  label?: string;
  category?: string;
  id?: string;
}

/** Counts + rates from a red-team run — no shipped claim; it describes the corpus you name. */
export class RedTeamReport {
  total = 0;
  attacks = 0;
  benign = 0;
  caught = 0; // attack cases that tripped (true positives)
  falsePositives = 0; // benign cases that tripped
  /** category → `[attacks, caught]`. */
  byCategory: Record<string, [number, number]> = {};

  /** Recall on attack cases (caught / attacks); `0` when there are no attacks. */
  get tripRate(): number {
    return this.attacks ? this.caught / this.attacks : 0;
  }

  /** Fraction of benign cases that tripped; `0` when there are no benign cases. */
  get falsePositiveRate(): number {
    return this.benign ? this.falsePositives / this.benign : 0;
  }

  /** A one-line, corpus-agnostic summary (safe to log — no case text). */
  summary(): string {
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    return (
      `${this.total} cases: trip rate ${pct(this.tripRate)} (${this.caught}/${this.attacks} attacks), ` +
      `false-positive rate ${pct(this.falsePositiveRate)} (${this.falsePositives}/${this.benign} benign)`
    );
  }
}

function toCase(row: unknown): AttackCase {
  if (row === null || typeof row !== 'object') {
    throw new Error(
      `each corpus record must be an object, got ${row === null ? 'null' : typeof row}`,
    );
  }
  const r = row as Record<string, unknown>;
  if (!('text' in r)) throw new Error("each corpus record needs a 'text' field");
  return {
    text: String(r.text),
    label: r.label === undefined ? ATTACK : String(r.label),
    category: r.category === undefined ? '' : String(r.category),
    id: r.id === undefined ? '' : String(r.id),
  };
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const header = (lines[0] as string).split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(',');
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = (cols[i] ?? '').trim();
    });
    return row;
  });
}

export interface LoadCorpusOptions {
  /** For a text `source`: `"jsonl"` / `"json"` / `"csv"` (default `"jsonl"`). Ignored for an array. */
  format?: 'jsonl' | 'json' | 'csv';
}

/**
 * Build a labeled corpus from an **array** of records (already parsed) or a **text** blob you read
 * yourself — `jsonl` (one object per line), `json` (an array), or `csv` (a header row). Each record
 * needs a `text` field; `label` (default `"attack"`) / `category` / `id` are optional. No `node:fs`.
 */
export function loadCorpus(
  source: readonly unknown[] | string,
  opts: LoadCorpusOptions = {},
): AttackCase[] {
  if (Array.isArray(source)) return source.map(toCase);
  const text = source as string;
  const fmt = opts.format ?? 'jsonl';
  let rows: unknown[];
  if (fmt === 'jsonl') {
    rows = text
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } else if (fmt === 'json') {
    const data = JSON.parse(text);
    rows = Array.isArray(data) ? data : [data];
  } else {
    rows = parseCsv(text);
  }
  return rows.map(toCase);
}

function tally(report: RedTeamReport, c: AttackCase, tripped: boolean): void {
  report.total += 1;
  const label = c.label ?? ATTACK;
  if (label === ATTACK) {
    report.attacks += 1;
    if (tripped) report.caught += 1;
    const cat = c.category ?? '';
    const [a, caught] = report.byCategory[cat] ?? [0, 0];
    report.byCategory[cat] = [a + 1, caught + (tripped ? 1 : 0)];
  } else if (label === BENIGN) {
    report.benign += 1;
    if (tripped) report.falsePositives += 1;
  }
}

/**
 * Run `guardrails` over each case at `stage` and tally trip rate + false positives. A case trips
 * when any guardrail blocks/redacts/flags it (a `block` throws `GuardrailTripped` — counted as a
 * trip, not an error). Sync only — for an `async` check use {@link runRedteamAsync}.
 */
export function runRedteam(
  guardrails: readonly Guardrail[],
  cases: Iterable<AttackCase>,
  opts: { stage?: string } = {},
): RedTeamReport {
  const stage = opts.stage ?? 'input';
  const report = new RedTeamReport();
  for (const c of cases) {
    let tripped: boolean;
    try {
      tripped = apply(guardrails, stage, c.text).length > 0;
    } catch (err) {
      if (!(err instanceof GuardrailTripped)) throw err;
      tripped = true;
    }
    tally(report, c, tripped);
  }
  return report;
}

/** Async counterpart of {@link runRedteam} — awaits `async` checks (an `llmJudge` / hosted rail). */
export async function runRedteamAsync(
  guardrails: readonly Guardrail[],
  cases: Iterable<AttackCase>,
  opts: { stage?: string } = {},
): Promise<RedTeamReport> {
  const stage = opts.stage ?? 'input';
  const report = new RedTeamReport();
  for (const c of cases) {
    let tripped: boolean;
    try {
      tripped = (await applyAsync(guardrails, stage, c.text)).length > 0;
    } catch (err) {
      if (!(err instanceof GuardrailTripped)) throw err;
      tripped = true;
    }
    tally(report, c, tripped);
  }
  return report;
}
