---
"@cendor/core": patch
---

Model-currency patch. The bundled price snapshot is regenerated for the current model generation
(every rate verified against the official provider pricing pages, `_updated` 2026-07-11): adds the
OpenAI gpt-5.x line, Anthropic claude-fable-5 / claude-mythos-5 / claude-sonnet-5 (standard
post-2026-09-01 rate; intro rate noted in `_note`) / opus-4-7/-4-6/-4-5, Gemini 3.x, and xAI
grok-4.3 / grok-4.5; corrects claude-haiku-4-5 to the official $1/$5 (+ $0.10 cache read / $1.25
5m write) and the Gemini 2.5 cache-read rates; removes the dead gemini-2.0-flash / gemini-1.5-pro
rows. Wire-level model ids now normalize at price lookup, so Bedrock modelIds
(`anthropic.…-v1:0`, `us.`-region profiles) and dated Anthropic / OpenAI snapshot ids price like
their base model instead of yielding a null cost — unknown models still throw.
