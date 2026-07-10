---
"@cendor/squeeze": patch
---

Deep-QA fixes.

- Budgeted JSON compression recurses into a payload nested under a single key (`{"data":[…]}`, `{"results":{…}}`), peeling elements/keys largest-first, instead of collapsing the whole thing to `{}` — so `contextkit`'s `Block(evict="compress")` keeps real content under a budget. Output stays valid JSON; `expand()` is still byte-exact (H1).
- A non-JSON-serializable input (bigint / function / symbol) now throws a clear `compress()` error instead of silently producing garbage (L4).
