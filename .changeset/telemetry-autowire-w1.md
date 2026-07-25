---
'@cendor/core': minor
'@cendor/tokenguard': minor
'@cendor/acttrace': minor
---

**Telemetry now flows with zero telemetry code — and `CENDOR_TELEMETRY=off` turns it all off.**

⚠️ **This is a default-behaviour change.** If your app has `@opentelemetry/api` installed **and**
configures a global tracer provider (`NodeSDK.start()`, `useAzureMonitor()`, a plain
`setGlobalTracerProvider`, an OTLP endpoint pointed at Cendor Monitor…), then after upgrading you will
start seeing Cendor data in **your** backend without adding a line of code:

| What appears | Where it comes from | Scope / names |
|---|---|---|
| `chat …` / `execute_tool …` spans per governed call | `@cendor/core` — the emitter attaches itself at your first `instrument()` (or `otel.ingest()`) | `cendor.core`, standard `gen_ai.*` |
| `gen_ai.client.token.usage` / `.cost.usd` / `.reasoning.token.usage` counters, dimensioned by `model` + your `track()` tags | `@cendor/tokenguard` — an **internal additive tap** beside your `useSink` slot | meter `cendor.tokenguard` |
| `audit.*` spans per chained audit entry | `@cendor/acttrace` — `new AuditLog(...)` auto-attaches an `OTelMirror` when you pass no `mirror` | `cendor.acttrace` |

Nothing else changes: Cendor still has **no endpoint, no exporter and no collector of its own** — it
emits into the provider *you* configured. With `@opentelemetry/api` absent, or with no provider
configured, behaviour is byte-identical to before (not one extra bus subscriber). Prompt/response
**content stays opt-in** (`otel.captureContent()`). No new identity: the app name is still the OTel
resource's `service.name`.

**Turning it off / diagnosing it**

- `CENDOR_TELEMETRY=off` — process-wide, no code change. Honoured per event, so it applies even if you
  export it late. `OTEL_SDK_DISABLED=true` (the standard switch) composes for free.
- `CENDOR_DEBUG_TELEMETRY=1` — one stderr line stating the mode, whether a provider was detected, and
  what got wired. Silent otherwise: Cendor never nags an offline app.

**New in `@cendor/core`'s `otel`**: `telemetryMode()`, `providerConfigured()`, `liveSpansActive()`,
`autoTelemetryState()` (diagnostics). `useSpanEmitter()` still works and **always wins** — a manual
attachment detaches the automatic one, so an event is never rendered twice.

**New in `@cendor/acttrace`**: `new AuditLog(system, { mirror: false })` — "never mirror this log".
An explicit mirror is used verbatim, and the mirror stays an *operational copy*: the hash-chained file
(or a signed `export()`) remains the only artifact `verify()` checks.

**`@cendor/tokenguard`**: the spend tap never touches your `useSink` slot (that slot holds exactly the
sink you set), and it stands down when your own sink already **is** an `OTelSink` (or a `QueueSink`
wrapping one) — so an app following the older docs does not double-count spend after upgrading.
