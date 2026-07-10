---
"@cendor/core": patch
"@cendor/tokenguard": patch
"@cendor/contextkit": patch
"@cendor/squeeze": patch
"@cendor/guardrails": patch
"@cendor/cassette": patch
"@cendor/acttrace": patch
---

AI-assistant onboarding: inline Type Teach now ships in every package — `@example` + correct-shape JSDoc on public symbols, the `budget(cfg, fn): never` decoy overload (the wrong shape is a compile error), Literal-narrowed string params, and `@deprecated` casing aliases — plus the bundled `INTEGRATION.md`. No runtime behavior change for correct code; the wrong call-shape just fails to typecheck with a message stating the right one. Full trap sheet: https://cendor.ai/docs/for-ai-assistants
