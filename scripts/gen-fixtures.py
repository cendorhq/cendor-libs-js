"""Generate cross-language conformance vectors from the reference Python implementation.

Run from the Python libraries workspace so `cendor.*` and `tiktoken` are importable:

    cd ../cendor-libs && uv run python ../cendor-libs-js/scripts/gen-fixtures.py

Writes golden JSON fixtures into `cendor-libs-js/fixtures/`. These are committed so the JS CI needs
no Python. Money amounts are emitted as the exact Python `Decimal` string *and* a normalized value;
the JS side compares money by decimal *value* (trailing-zero representation is not part of the wire
contract — audit chains re-read stored strings, so chain interop is unaffected — see the JS
`fixtures/README.md`). Token counts come from real `tiktoken`, which shares BPE ranks with
`js-tiktoken`, so counts match exactly.
"""

from __future__ import annotations

import json
import sys
from decimal import Decimal
from pathlib import Path

from cendor.core import Money, Usage, prices, tokens

OUT = Path(__file__).resolve().parent.parent / "fixtures"
OUT.mkdir(exist_ok=True)


def money_obj(m: Money) -> dict:
    return {"amount": str(m.amount), "currency": m.currency}


# --------------------------------------------------------------------------- prices
def gen_prices() -> None:
    cases = [
        {"model": "gpt-4o", "input": 1000, "output": 500},
        {"model": "gpt-4o", "input": 1000, "output": 0},
        {"model": "gpt-4o", "input": 1000, "output": 500, "cached": 200},
        {"model": "gpt-4o", "input": 1000, "output": 500, "cache_write": 100},
        {"model": "gpt-4o", "input": 1000, "output": 500, "cached": 2000},  # cached > input -> clamp
        {"model": "gpt-4o-mini", "input": 12345, "output": 6789},
        {"model": "claude-opus-4-8", "input": 2000, "output": 1000, "cached": 500, "cache_write": 300},
        {"model": "claude-haiku-4-5", "input": 100, "output": 50, "cached": 25},
        {"model": "gemini-2.5-pro", "input": 4096, "output": 1024, "cached": 1000},
        {"model": "claude-fable-5", "input": 2000, "output": 1000, "cached": 500, "cache_write": 300},
        {"model": "gpt-5.6-terra", "input": 1000, "output": 500, "cached": 200},
        {"model": "grok-4.3", "input": 500, "output": 500},  # no cached rate
        {"model": "o3", "input": 3000, "output": 900},
        {"model": "llama3", "input": 1000, "output": 1000},  # zero rates
        {"model": "gpt-4-turbo", "input": 777, "output": 333, "cache_write": 50},  # no cache_write rate
    ]
    out = []
    for c in cases:
        cost = prices.estimate(
            c["model"],
            c["input"],
            c.get("output", 0),
            c.get("cached", 0),
            c.get("cache_write", 0),
        )
        out.append(
            {
                "model": c["model"],
                "inputTokens": c["input"],
                "outputTokens": c.get("output", 0),
                "cachedTokens": c.get("cached", 0),
                "cacheWriteTokens": c.get("cache_write", 0),
                "cost": money_obj(cost),
                "costStr": str(cost),
            }
        )
    unknown = "totally-unknown-model-xyz"
    err = False
    try:
        prices.estimate(unknown, 100, 100)
    except KeyError:
        err = True
    payload = {
        "spec": "prices/1",
        "snapshotDate": prices.snapshot_date(),
        "models": prices.models(),
        "cases": out,
        "unknownModel": {"model": unknown, "raises": err},
    }
    (OUT / "prices.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"prices.json: {len(out)} cases")


# --------------------------------------------------------------------------- money / bus
def gen_money() -> None:
    a = Money("0.0025")
    b = Money("0.0010")
    ops = {
        "construct_str": money_obj(Money("0.0025")),
        "construct_float": money_obj(Money(0.1)),
        "construct_int": money_obj(Money(5)),
        "zero": money_obj(Money.zero()),
        "zero_eur": money_obj(Money.zero("EUR")),
        "add": money_obj(a + b),
        "sub": money_obj(a - b),
        "mul_int": money_obj(a * 3),
        "mul_decimal": money_obj(a * Decimal("2.5")),
        "str_form": str(a),
        "lt": a < b,
        "gt": a > b,
        "le_eq": Money("0.5") <= Money("0.5"),
        "eq_trailing_zeros": Money("2.5") == Money("2.50"),
    }
    mismatch = False
    try:
        _ = Money("1", "USD") + Money("1", "EUR")
    except ValueError:
        mismatch = True
    usages = [
        {
            "init": {"input_tokens": 1000, "output_tokens": 500},
            "total": Usage(1000, 500).total_tokens,
        },
        {
            "init": {"input_tokens": 1000, "output_tokens": 500, "cached_tokens": 200, "reasoning_tokens": 100, "cache_write": 50},
            "total": Usage(1000, 500, 200, 100, 50).total_tokens,
        },
        {"init": {"input_tokens": 0}, "total": Usage(0).total_tokens},
    ]
    payload = {
        "spec": "events/1",
        "money": ops,
        "currencyMismatchRaises": mismatch,
        "usage": usages,
    }
    (OUT / "money.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print("money.json written")


# --------------------------------------------------------------------------- tokens
def gen_tokens() -> None:
    texts = [
        ("", "gpt-4o"),
        ("hello world", "gpt-4o"),
        ("The quick brown fox jumps over the lazy dog.", "gpt-4o"),
        ("hello world", "claude-opus-4-8"),
        ("The quick brown fox jumps over the lazy dog.", "claude-opus-4-8"),
        ("hello world", "gemini-2.5-pro"),
        ("Grüße aus München — café touché naïve", "gpt-4o"),
        ("def add(a, b):\n    return a + b\n", "gpt-4o"),
        ("a" * 500, "gpt-4o"),
        ("hello world", "gpt-4o-mini"),
        ("hello world", "o3"),
    ]
    text_cases = []
    for text, model in texts:
        text_cases.append(
            {
                "text": text,
                "model": model,
                "count": tokens.count(text, model),
                "method": tokens.method(model),
                "family": tokens.family(model),
                "isExact": tokens.is_exact(model),
            }
        )
    message_sets = [
        [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "What is the capital of France?"},
        ],
        [
            {"role": "user", "content": [{"type": "text", "text": "part one "}, {"type": "text", "text": "part two"}]},
        ],
        [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
            {"role": "user", "content": "how are you?"},
        ],
    ]
    message_cases = []
    for msgs in message_sets:
        for model in ("gpt-4o", "claude-opus-4-8"):
            message_cases.append({"messages": msgs, "model": model, "count": tokens.count(msgs, model)})
    payload = {"textCases": text_cases, "messageCases": message_cases}
    (OUT / "tokens.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"tokens.json: {len(text_cases)} text + {len(message_cases)} message cases")


if __name__ == "__main__":
    gen_prices()
    gen_money()
    gen_tokens()
    print(f"\nFixtures written to {OUT}")
    sys.exit(0)
