# Cross-language conformance vectors

Golden fixtures generated from the **reference Python implementation** (`cendorhq/cendor-libs`) by
[`scripts/gen-fixtures.py`](../scripts/gen-fixtures.py). They are committed so JS CI needs no Python.
Every `@cendor/*` package's tests replay the relevant vectors — a JS change that would break
cross-language interop fails CI, not a user.

| File | Governs | Spec |
|---|---|---|
| `prices.json` | `estimate()` cost math + the bundled model table | `prices/1` |
| `money.json` | `Money` arithmetic/serialization + `Usage` conventions | `events/1` |
| `tokens.json` | token counts + method selection (real `tiktoken` ↔ `js-tiktoken`) | — |
| `cassette/*` | recorded cassettes that must replay in JS | `cassette/2` |
| `acttrace/*` | signed chains that must `verify` cross-language | `acttrace-chain/1` |

## Money: value equality, not byte-identical strings

Python's `Decimal` tracks *ideal exponents*, so `estimate('gpt-4o', 1000, 500)` renders as
`"0.007500000 USD"` (padded trailing zeros from the zero-valued cache terms). `decimal.js` normalizes
to `"0.0075"`. **The wire contract is the exact decimal _value_ and the `"{amount} {currency}"`
_format_ — not the trailing-zero representation.** So price/money vectors are compared by decimal
value (`Decimal.equals`), and each vector carries the exact Python `amount` string for reference.

This is safe for real interop because the two persisted artifacts re-read stored strings rather than
re-deriving them: an audit chain's `verify()` re-canonicalizes the `Money` string already on disk
(so a Python-written chain verifies in JS and vice versa regardless of which library formatted it),
and cassettes do not persist money at all. Trailing-zero formatting never crosses the wire.

## Regenerate

```bash
cd ../cendor-libs && uv run python ../cendor-libs-js/scripts/gen-fixtures.py
```
