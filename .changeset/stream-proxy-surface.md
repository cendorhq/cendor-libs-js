---
"@cendor/core": patch
---

instrument(): the streaming proxy now forwards the full SDK stream surface. The wrapped value is a
`Proxy` that keeps usage-capturing iteration while forwarding every other member (`.tee()`,
`.controller`, `.response`, `.finalMessage()`, `.close()`, `Symbol.asyncDispose`, …) to the
underlying provider stream, and finalizes the `LLMCall` exactly once — on iterate-to-exhaustion or
early close/dispose.
