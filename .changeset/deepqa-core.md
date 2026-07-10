---
"@cendor/core": minor
---

Deep-QA fixes: token accuracy for the open/hosted-model class + Gemini capture.

- Non-OpenAI / unrecognized models — llama, mistral, deepseek, qwen, new o-series ids (`o5-mini`), and OpenAI fine-tunes (`ft:gpt-4o:*`) — now count via the `o200k` BPE proxy (`bpe-estimate`), exactly like Claude/Gemini, instead of the character heuristic. **This changes token counts** for the whole open/hosted-model class (hence a minor). The o-series match is generalized (`^o\d`) and an `ft:` fine-tune strips to its base model, counting `exact` (H2).
- Gemini usage/cost capture in `instrument()` now reads the real `@google/genai` **camelCase** `usageMetadata` keys (`promptTokenCount`/`candidatesTokenCount`/`thoughtsTokenCount`), with a snake_case fallback, on both the non-streaming and streaming paths — previously `usage`/`cost` came back `null` (H3).
