# @cendor/contextkit

**Assemble LLM context to a token budget — with a receipt.** The TypeScript port of
[`cendor.contextkit`](https://github.com/cendorhq/cendor-libs/tree/main/packages/cendor-contextkit).

Treat the context window like a packed suitcase: declare `Block`s with a priority, a `pin`, and a
per-block eviction rule; `assemble()` packs them to a token budget **deterministically**, and
`report()` hands back the receipt — what was kept, shrunk, or dropped, with the token math. Depends
only on `@cendor/core`; `@cendor/squeeze` plugs in by shape (optional) for reversible compression.

The receipt is honest at the **message** level: budgeting charges the per-message framing overhead
providers add around every turn (self-calibrated from `core.tokens`), so `report().used` equals
`tokens.count(await ctx.assemble(), model)` for text content — what the model actually sees.

## Killer example

```ts
import { Block, Context } from '@cendor/contextkit';

const ctx = new Context({ budgetTokens: 4000, model: 'gpt-4o', reserveOutput: 500 });

ctx.add(new Block('You are a terse, accurate assistant.', { role: 'system', priority: 100, pin: true }))
   .add(new Block(hugeRetrievedDoc, { role: 'user', priority: 5, evict: 'truncate', keep: 'head' }))
   .add(new Block({ messages: chatHistory, priority: 20, evict: 'drop_oldest' })) // peels oldest turns
   .add(new Block(userQuestion, { role: 'user', priority: 90, pin: true }));

const messages = await ctx.assemble();     // provider-ready [{ role, content }, ...]
console.log(ctx.report().toString());      // the receipt: kept / truncated / dropped + token math

// Provider adapters (lazy-assemble):
const [system, msgs] = await ctx.forAnthropic();      // system split out
const [instruction, contents] = await ctx.forGemini(); // {role:"model"|"user", parts}
const [sys, bedrock] = await ctx.forBedrock();         // Converse shape
```

## Surface

| Symbol | Kind | Notes |
|---|---|---|
| `Block(contentOrOpts?, opts?)` | class | Exactly one of `content` / `messages`. Fields: `content`, `priority` (0), `pin` (false), `evict` (`'drop_oldest'`), `role` (`'user'`), `summarizer`, `keep` (`'head'`), `messages`. |
| `Context({ budgetTokens, model, reserveOutput?, compressor?, order?, imageTokens? })` | class | `order` ∈ `'default'` \| `'attention'` \| `'cache'`. |
| `Context.add(block)` | method | Chainable (`=> this`). |
| `Context.assemble()` | async | Packs, emits the report on `core.bus`, returns messages. |
| `Context.report()` | sync | Last receipt; throws `RuntimeError` before the first `assemble()`. |
| `Context.whatif(budgetTokens)` | async | Preview at a different budget; does not commit or emit. |
| `Context.forAnthropic()` / `forGemini()` / `forBedrock()` | async | Provider adapters (lazy-assemble). |
| `AssemblyReport` | class | `budget`, `used`, `reservedOutput`, `model`, `decisions[]`, `order`, `toString()`. |
| `BlockDecision` | class | `role`, `action`, `tokensBefore`, `tokensAfter`, `note`, `handle`. |
| `BudgetError` | error | Pinned blocks alone exceed the budget. |
| `useCompressor(c)` | function | Set the process-wide default compressor for `evict:'compress'`; returns the previous. |
| `EvictStrategy` | type | `'drop_oldest' | 'truncate' | 'summarize' | 'compress'`. |

**Eviction** (`Block.evict`): `'drop_oldest'` (drop the whole block; peel oldest turns for `messages`
blocks), `'truncate'` (cut to fit, `keep: 'head' | 'tail'`, with a `[truncated]` marker),
`'summarize'` (call `summarizer(content, targetTokens)`), `'compress'` (via `@cendor/squeeze` or a
`useCompressor` backend, exposing a reversible `handle` on the decision), or any custom
`EvictionStrategy` object.

## Parity note

Faithful port of `cendor.contextkit` 1.0.1: identical public symbols (`snake_case` → `camelCase`,
kwargs → options objects), identical defaults, **byte-identical string-literal values**
(`'drop_oldest'`, `'attention'`, the `…[truncated]` markers with U+2026), and the `BudgetError`
name. Two deliberate adaptations:

1. **Single async `assemble()`.** Python's sync `assemble` + async `aassemble` collapse into one
   `async assemble()` that awaits summarizers (sync or async) and the compressor. The Python
   "sync path falls back to truncation for an async summarizer" behavior therefore has no analog —
   async summarizers are simply awaited. `whatif` and the provider adapters are async accordingly.
2. **Real token counts.** `@cendor/core` bundles js-tiktoken, so counts are the exact tiktoken
   numbers, not Python's forced offline `ceil(len/4)` heuristic. Per-message framing is identical
   (`priming=3`, `perMessage=4`, derived — not hardcoded — from `tokens.count`), so every
   structural guarantee ports verbatim: `used <= budget`, `used === tokens.count(messages, model)`
   for text, deterministic ordering, and roundtrips.
