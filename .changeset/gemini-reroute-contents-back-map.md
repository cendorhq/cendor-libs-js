---
'@cendor/core': patch
---

A redacted Gemini call is now sendable: `Reroute({ messages })` maps back to Gemini's `contents` shape.

`instrument()` normalizes a **non-array** `contents` — the very common
`generateContent({ contents: 'summarize…' })` — into one canonical `{role, content}` message, so every
interceptor sees every provider the same way. `applyReroute` then wrote that message object straight
back onto `contents`, and `@google/genai` rejects it: `contents` takes a string, a `Content`
(`{role, parts}`) or a `Part`, never `{role, content}`. So `@cendor/acttrace`'s `guard()`
redact-before-send scrubbed the payload correctly and then made the call impossible to send — the
redaction fired, the audit entry chained, and the request raised.

The back-map mirrors the one `openai_embeddings` already had: **the original request's shape is what
goes back.** A string input that produced a single text message returns as a string; a `Content`/`Part`
passes through untouched (an array input is already Gemini-native and the scrub preserved its shape);
a canonical message becomes `{role, parts: [{ text }]}`, with `assistant`/`model` mapped to Gemini's
`model` role.

Only the reroute path changes — a call with no interceptor rewrite, and every other provider, is
byte-identical to before. Found by the external black-box suite driving a live Gemini key
(`@cendor/acttrace` finding, severity medium). Reproduced offline: the redacting guard used to hand
`@google/genai` `[{"role":"user","content":"…"}]`, and now hands it the string it was given.
