---
"@cendor/acttrace": minor
---

Add optional NER-backed redaction to `@cendor/acttrace`, backed by the `compromise` peer dependency.

`nerRedactor(entities, language, compose)` now returns a working redactor (previously a throwing
stub): it walks dicts/arrays, runs the optional `compose` redactor first (e.g. `defaultRedactor` for
the regex categories), then scrubs detected `PERSON` / `LOCATION` / `ORGANIZATION` / `DATE_TIME` spans
with the `<redacted>` token — preserving the surrounding text. `nerAvailable()` reports whether the
backend is present; `nerRedactor()` throws a clear install hint when it isn't. Plug it into
`new AuditLog(system, { redactor })` (a custom redactor owns its own flagging).

`compromise` is an **optional** peer dependency, lazy-loaded synchronously (acttrace's tamper-evident
append path is synchronous). **Honest coverage:** this is English-only and lighter than Python's
Presidio backend — a useful extra layer, not a sole PII control. A transformer NER (transformers.js)
would match Presidio's quality but is async + heavy, so it can't plug into the sync append path. See
the parity matrix.
