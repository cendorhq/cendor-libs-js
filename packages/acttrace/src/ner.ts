/**
 * Optional NER-backed redaction — the `[ner]`-equivalent for TypeScript, backed by the optional
 * `compromise` peer dependency.
 *
 * Regex can't reliably catch free-text **names**, **places**, and **organizations**; that needs a
 * model. This adapter plugs `compromise <https://compromise.cool>`_ in as a `redactor=` for
 * `AuditLog` (or a standalone scrubber), **only** when the optional dependency is installed:
 *
 *     npm install compromise
 *
 * It is strictly opt-in — the default install stays pure-regex, offline, and dependency-light. When
 * the dependency is absent, {@link nerAvailable} returns `false` and {@link nerRedactor} throws a
 * clear, actionable error (it never silently degrades or reaches the network — `compromise` runs
 * locally, bundled, with no model download).
 *
 * **Honest coverage note (not Presidio parity).** The Python `[ner]` extra uses Microsoft Presidio
 * (spaCy transformer models). `compromise` is a lightweight, synchronous, rule-plus-lexicon NLP
 * engine — it is *English-only* and its recall/precision on free-text PII is **lower** than
 * Presidio's. It is a useful extra layer, **not** a sufficient sole PII control. A transformer NER
 * (transformers.js) would match Presidio's quality but is asynchronous, which cannot satisfy
 * acttrace's synchronous, tamper-evident append path (and would add a heavy runtime). See
 * `docs/acttrace.md` and the parity matrix.
 */
import { createRequire } from 'node:module';

import { REDACTED } from './detectors.js';

/**
 * Entity types redacted by default. Kept for parity with the Python default
 * (`PERSON, LOCATION, NRP, DATE_TIME`); the `compromise` backend covers `PERSON`, `LOCATION`,
 * `ORGANIZATION`, and `DATE_TIME` — `NRP` has no `compromise` equivalent and is skipped.
 */
export const DEFAULT_NER_ENTITIES = ['PERSON', 'LOCATION', 'NRP', 'DATE_TIME'] as const;

const INSTALL_HINT =
  'NER-backed redaction needs the optional `compromise` peer dependency: npm install compromise. ' +
  '(It is English-only and lighter than Python’s Presidio backend — see docs/acttrace.md.)';

/** The slice of the `compromise` API this adapter uses — structural, so no hard type dependency. */
interface CompromiseView {
  people(): CompromiseView;
  places(): CompromiseView;
  organizations(): CompromiseView;
  match(pattern: string): CompromiseView;
  json(opts?: { offset?: boolean }): Array<{ offset?: { start?: number; length?: number } }>;
}
type Nlp = (text: string) => CompromiseView;

// `undefined` = not attempted yet; `null` = attempted and absent; otherwise the loaded `nlp`.
let cachedNlp: Nlp | null | undefined;

/** Load `compromise` synchronously (CJS build) if present, caching the outcome. */
function loadNlp(): Nlp | null {
  if (cachedNlp !== undefined) return cachedNlp;
  try {
    const req = createRequire(import.meta.url);
    const mod = req('compromise') as Nlp | { default: Nlp };
    cachedNlp = typeof mod === 'function' ? mod : mod.default;
  } catch {
    cachedNlp = null;
  }
  return cachedNlp;
}

/** Map a Presidio-style entity type to the `compromise` selection that finds it. */
const ENTITY_QUERIES: Record<string, (doc: CompromiseView) => CompromiseView> = {
  PERSON: (doc) => doc.people(),
  LOCATION: (doc) => doc.places(),
  ORGANIZATION: (doc) => doc.organizations(),
  DATE_TIME: (doc) => doc.match('#Date+'),
};

/** `true` if the optional NER backend (`compromise`) is importable in this environment. */
export function nerAvailable(): boolean {
  return loadNlp() !== null;
}

/**
 * Build a `payload -> payload` redactor that scrubs NER entities from strings.
 *
 * Pass the result to `AuditLog({ redactor })` (a custom redactor owns its own flagging, so the
 * built-in policy auto-flag does not also run), or call it directly. Walks dicts/arrays like the
 * built-in scrubber and replaces each detected entity span with `<redacted>`, preserving the
 * surrounding text.
 *
 * @param entities Entity types to redact (defaults to {@link DEFAULT_NER_ENTITIES}). Supported by the
 *   `compromise` backend: `PERSON`, `LOCATION`, `ORGANIZATION`, `DATE_TIME`; others are skipped.
 * @param _language Accepted for API parity; the `compromise` backend is English-only.
 * @param compose An optional inner redactor to run **first** (e.g. `defaultRedactor` to also scrub the
 *   regex categories); its output is then passed through NER.
 * @throws Error if the optional `compromise` dependency is not installed.
 */
export function nerRedactor(
  entities: readonly string[] = DEFAULT_NER_ENTITIES,
  _language = 'en',
  compose?: ((obj: unknown) => unknown) | null,
): (obj: unknown) => unknown {
  const nlp = loadNlp();
  if (nlp === null) throw new Error(INSTALL_HINT);

  const queries = entities
    .map((e) => ENTITY_QUERIES[e])
    .filter((q): q is (doc: CompromiseView) => CompromiseView => q !== undefined);

  const scrubText = (text: string): string => {
    if (!text || queries.length === 0) return text;
    const doc = nlp(text);
    const spans: Array<{ start: number; end: number }> = [];
    for (const query of queries) {
      for (const match of query(doc).json({ offset: true })) {
        const off = match.offset;
        if (
          off &&
          typeof off.start === 'number' &&
          typeof off.length === 'number' &&
          off.length > 0
        ) {
          spans.push({ start: off.start, end: off.start + off.length });
        }
      }
    }
    if (spans.length === 0) return text;
    // Merge overlapping spans (an org may contain a person, etc.), then splice right-to-left so
    // earlier offsets stay valid while we rewrite.
    spans.sort((a, b) => a.start - b.start);
    const merged: Array<{ start: number; end: number }> = [];
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
      else merged.push({ ...span });
    }
    let out = text;
    for (let i = merged.length - 1; i >= 0; i--) {
      const span = merged[i] as { start: number; end: number };
      out = out.slice(0, span.start) + REDACTED + out.slice(span.end);
    }
    return out;
  };

  const redact = (obj: unknown): unknown => {
    let value = obj;
    if (compose) value = compose(value);
    if (typeof value === 'string') return scrubText(value);
    if (Array.isArray(value)) return value.map(redact);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redact(v);
      return out;
    }
    return value;
  };
  return redact;
}
