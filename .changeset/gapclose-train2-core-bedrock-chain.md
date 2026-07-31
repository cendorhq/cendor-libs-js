---
'@cendor/core': minor
'@cendor/contextkit': minor
---

First-class aws-sdk-v3 Bedrock capture, the output gate's helper-method escape closed, and the
interceptor chain's ordering contract corrected.

**`instrument()` now detects an aws-sdk-v3 `BedrockRuntimeClient`.** This was the most surprising
capture gap in the JS port and the external black-box suite filed it as a challenge on *every* run: v3
exposes no `client.converse(...)`, so a libs-only TypeScript Bedrock app got **zero** capture — no
budget, no guard, no audit, no cassette, measured at 0 `LLMCall`s. `send` is shared by every AWS
command, so the capture is keyed on two things: the client is identified once
(`config.serviceId === 'Bedrock Runtime'`, measured to be a plain synchronously-readable string on
`@aws-sdk/client-bedrock-runtime` 3.1100.0) and the command per call. `ConverseCommand` and
`ConverseStreamCommand` are captured; **everything else passes through completely untouched and emits
nothing** — another AWS command, a non-Bedrock client, or `InvokeModelCommand` (deliberately excluded:
its body is opaque per-model JSON, so any usage reading would be a guess). Pre-flight governance rides
it — a budget block issues zero HTTP requests, and a `guard()` redaction is written back onto
`command.input`, which is both writable and replaceable. `@cendor/sdk`'s synthetic `converse()`
provider still works and **cannot double-count**: a `send` reached from inside another instrumented
call stands down. Stop writing the `converse()` shim the old docs recommended.

**A post-flight output guardrail now fires for a response consumed through an SDK helper method.**
`openai-node` builds `responses.parse` / `chat.completions.parse` / `runTools` on
`create(...)._thenUnwrap(...)`, and the same response that was **blocked** when awaited directly
**resolved** when reached that way — so a `withStructuredOutput()` call delivered banned text. It had
been documented OPEN with the mechanism unexplained, which is why an earlier attempt had not closed
it. Measured: the gate *did* run and *did* decide `block` (a `GuardrailDecision keyword_deny:block`
was on the bus every time), and its exception rejected core's capture chain — which core deliberately
marks handled so a `withResponse()`-only caller gets no noisy unhandled-rejection warning. But
`_thenUnwrap` derives a new promise from the **SDK's own** object, so the promise the caller awaited
had never touched that chain. The gate was never the problem; the promise was. Core now gates the
derived promise (recursively, since these chain), while `asResponse()` and a nested `_thenUnwrap` stay
reachable and an ungated call is untouched.

**A `Reroute` no longer ends the interceptor chain; only a returned response does.** A recorded
response (cassette's replay) means the provider is never called, so nothing is left to rewrite and
stopping is right — but a `Reroute` still goes to the provider, so every remaining interceptor must
still be consulted, and against the rerouted call. Before this, the first interceptor that rewrote a
request silently skipped every one after it, and what you lost was silent and in the dangerous
direction: measured, a `tokenguard` clamp registered before an `acttrace.guard()` sent the PII to the
provider **unredacted**, and the reverse order left the token cap **silently unbound**. Which one you
lost depended on registration order, which a user has no way to observe. Reroutes now compose in
registration order (later wins on the same field) and a raise still stops everything.

**Fixed: `Reroute({ model })` lands on the provider's own model kwarg — `modelId` on Bedrock's Converse
API.** It was assigned generically, so on Bedrock the rewrite went to a `model` member Converse does
not have and the provider billed the **original, expensive** model while the `LLMCall`, the budget
ledger and the audit chain all recorded the cheap one. `onExceed: 'downgrade'` did not downgrade on
Bedrock. Found while analysing the ripple of the v3 work, not from a report.

**`@cendor/contextkit`: `new Context({ onMissingCompressor: 'note' | 'warn' | 'error' })`.** A block
asking for `evict: 'compress'` with no compressor available is **truncated** instead — a different
operation, not a slightly worse one: it discards content and gives you no `Handle` to `.expand()`. It
was always recorded as a note on the `BlockDecision`, and a note nobody reads is how a forgotten
`@cendor/squeeze` quietly degraded every compress block while the assembly still reported success.
**The default is `'note'`, i.e. unchanged.** It fires only when the compressor is genuinely missing — a
block that asked for `truncate`, or one that fitted the budget, is untouched in every mode.
