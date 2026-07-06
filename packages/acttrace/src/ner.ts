/**
 * Optional NER-backed redaction — the `[ner]` extra. The TS port ships regex/pattern detectors
 * ONLY: there is no Presidio in JS. So {@link nerAvailable} always returns `false` and
 * {@link nerRedactor} always throws the install-hint error (mirroring the Python behaviour when the
 * optional extra is absent). The names/shape are kept for API parity.
 */

/** Presidio entity types redacted by default (kept for parity — unused in the JS port). */
export const DEFAULT_NER_ENTITIES = ['PERSON', 'LOCATION', 'NRP', 'DATE_TIME'] as const;

const INSTALL_HINT = "NER redaction needs the optional extra: pip install 'cendor-acttrace[ner]'";

/** `true` if an NER backend is importable. The JS port has none, so always `false`. */
export function nerAvailable(): boolean {
  return false;
}

/**
 * Build a `payload -> payload` redactor that scrubs NER entities. Not available in the JS port —
 * always throws an `ImportError`-equivalent whose message names `cendor-acttrace[ner]`.
 */
export function nerRedactor(
  _entities: readonly string[] = DEFAULT_NER_ENTITIES,
  _language = 'en',
  _compose?: ((obj: unknown) => unknown) | null,
): (obj: unknown) => unknown {
  throw new Error(INSTALL_HINT);
}
