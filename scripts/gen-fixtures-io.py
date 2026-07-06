"""Generate cassette + acttrace cross-language conformance vectors from the Python reference.

Run from the Python libraries workspace:
    cd ../cendor-libs && uv run python ../cendor-libs-js/scripts/gen-fixtures-io.py

Writes into cendor-libs-js/fixtures/cassette/ and fixtures/acttrace/. These prove:
  - a Python-recorded cassette replays in JS (record files + a replay manifest),
  - the cassette request-hash + redaction are byte-identical,
  - a Python-written acttrace chain verifies in JS (signed + unsigned chain files),
  - the acttrace canonical chain-hash + _meta signature + detectors are byte-identical.
The reverse (JS-written chain verifies in Python) is proven at test time by invoking Python verify().
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from cendor.core import bus, instrument, instrument_tool

OUT = Path(__file__).resolve().parent.parent / "fixtures"
(OUT / "cassette").mkdir(parents=True, exist_ok=True)
(OUT / "acttrace").mkdir(parents=True, exist_ok=True)


# =========================================================================== cassette
def gen_cassette() -> None:
    from cendor import cassette
    from cendor.cassette import _hash, _normalized_request  # noqa: PLC2701

    cdir = OUT / "cassette"

    # --- recorded LLM cassette ------------------------------------------------
    def llm_client(answer: str):
        def create(**kwargs):
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content=answer))],
                usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5),
            )

        return instrument(SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))))

    bus._reset()
    with cassette.using(str(cdir / "llm.json"), mode="record"):
        c = llm_client("Sure, here is a refund.")
        c.chat.completions.create(model="gpt-4o", messages=[{"role": "user", "content": "I want a refund"}])

    # --- recorded tool cassette ----------------------------------------------
    bus._reset()
    with cassette.using(str(cdir / "tool.json"), mode="record"):
        @instrument_tool("search")
        def search(q: str):
            return {"hits": ["doc about refunds", "policy page"]}

        search("refund")

    # --- recorded streaming cassette -----------------------------------------
    def delta(text: str):
        return SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=text))], usage=None)

    def usage_chunk(p: int, c: int):
        return SimpleNamespace(choices=[], usage=SimpleNamespace(prompt_tokens=p, completion_tokens=c))

    def stream_client():
        def create(**kwargs):
            return iter([delta("Hel"), delta("lo"), usage_chunk(5, 2)])

        return instrument(SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))))

    bus._reset()
    with cassette.using(str(cdir / "stream.json"), mode="record"):
        c = stream_client()
        stream = c.chat.completions.create(model="gpt-4o", messages=[{"role": "user", "content": "stream hi"}], stream=True)
        list(stream)  # drain so usage/finalize fires and the LLMCall is emitted
    bus._reset()

    # --- replay manifest: how JS should exercise each file -------------------
    manifest = {
        "spec": "cassette/2",
        "replays": [
            {
                "file": "llm.json",
                "kind": "llm",
                "request": {"model": "gpt-4o", "messages": [{"role": "user", "content": "I want a refund"}]},
                "expect": {"path": "choices.0.message.content", "value": "Sure, here is a refund."},
            },
            {
                "file": "tool.json",
                "kind": "tool",
                "tool": "search",
                "args": ["refund"],
                "expect": {"value": {"hits": ["doc about refunds", "policy page"]}},
            },
            {
                "file": "stream.json",
                "kind": "stream",
                "request": {"model": "gpt-4o", "messages": [{"role": "user", "content": "stream hi"}], "stream": True},
                "expect": {"joinedDeltaContent": "Hello"},
            },
        ],
    }
    (cdir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    # --- canonical request-hash vectors --------------------------------------
    hash_cases = [
        {"kind": "llm", "provider": "openai", "model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}], "stream": False},
        {"kind": "llm", "provider": "anthropic", "model": "claude-opus-4-8", "messages": [{"role": "user", "content": "hello"}], "stream": True},
        {"kind": "tool", "name": "search", "arguments": {"args": ["refund"], "kwargs": {}}},
        {"kind": "tool", "name": "calc", "arguments": {"args": [], "kwargs": {"a": 1, "b": 2}}},
    ]
    hashes = [{"request": req, "hash": _hash(req)} for req in hash_cases]
    (cdir / "hashes.json").write_text(json.dumps({"cases": hashes}, indent=2), encoding="utf-8")

    # --- redaction vectors ----------------------------------------------------
    redactions = [
        "my key is sk-ABCDEFGH12345678 ok",
        "email me at alice@example.com please",
        "sk-ant-api03-abcdef_ghijklmnop-qrst and sk-proj-ABCDEFGHIJKLMNOP",
        "AKIAIOSFODNN7EXAMPLE is an aws key",
        "Bearer abc.def-ghi_123 and BEARER shouldnotmatch",
        "a well-known best-practice for multi-region fail-over",
        "token 0123456789abcdef0123456789abcdef1234",  # 36-char opaque
    ]
    red = [{"input": s, "output": cassette._redact(s)} for s in redactions]  # noqa: SLF001
    (cdir / "redaction.json").write_text(json.dumps({"cases": red}, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"cassette: llm/tool/stream recorded; {len(hashes)} hash + {len(red)} redaction vectors")


# =========================================================================== acttrace
def gen_acttrace() -> None:
    import cendor.acttrace as at
    from cendor.acttrace import GENESIS, AuditLog, Policy, redact, scan, verify
    from cendor.acttrace import _chain_hash, _canonical  # noqa: PLC2701
    from cendor.acttrace import _meta_signature  # noqa: PLC2701

    adir = OUT / "acttrace"
    KEY = "conformance-passphrase"

    # --- a signed, exported chain (the cross-language verify target) ---------
    bus._reset()
    signed_raw = adir / "chain-signed-raw.jsonl"
    log = AuditLog("refund-bot", risk_tier="high", path=str(signed_raw), signing_key=KEY)
    with log.decision(input={"question": "refund?"}, actor="agent") as d:
        d.record(step="policy-check", allowed=True)
        # a synthetic llm_call + tool_call through the bus
        from cendor.core.types import LLMCall, Money, ToolCall, Usage

        call = LLMCall(id="x", provider="openai", model="gpt-4o", messages=[{"role": "user", "content": "hi"}])
        call.usage = Usage(10, 5)
        call.cost = Money("0.00042")
        call.latency_ms = 12.5
        bus.emit(call)
        bus.emit(ToolCall(id="t", name="search", arguments={"args": ["refund"], "kwargs": {}}, result={"hits": 2}))
        d.human_oversight(reviewer="alice", action="approved", note="looks fine")
    log.export(str(adir / "chain-signed.jsonl"), framework="eu_ai_act")
    signed_head = log.head
    signed_ok, signed_detail = verify(str(adir / "chain-signed.jsonl"), key=KEY)
    log.detach()

    # --- an unsigned chain ---------------------------------------------------
    bus._reset()
    unsigned_raw = adir / "chain-unsigned.jsonl"
    log2 = AuditLog("simple-bot", path=str(unsigned_raw))
    with log2.decision(input="do the thing") as d:
        d.record(note="did the thing")
    log2.export(str(adir / "chain-unsigned.jsonl"))
    unsigned_head = log2.head
    unsigned_n = log2._seq  # noqa: SLF001
    log2.detach()
    bus._reset()

    signed_n = None
    for line in (adir / "chain-signed.jsonl").read_text(encoding="utf-8").splitlines():
        row = json.loads(line)
        if "_meta" in row:
            signed_n = row["_meta"]["entries"]

    manifest = {
        "spec": "acttrace-chain/1",
        "signed": {
            "file": "chain-signed.jsonl",
            "key": KEY,
            "head": signed_head,
            "entries": signed_n,
            "pythonVerify": {"ok": signed_ok, "detail": signed_detail},
        },
        "unsigned": {
            "file": "chain-unsigned.jsonl",
            "head": unsigned_head,
            "entries": unsigned_n,
        },
    }
    (adir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    # --- canonical chain-hash vectors (fixed inputs incl. int/float) ---------
    hcases = [
        {"prevHash": GENESIS, "seq": 0, "ts": "2026-07-05T12:00:00+00:00", "type": "audit_open",
         "payload": {"system": "s", "risk_tier": "limited"}},
        {"prevHash": "a" * 64, "seq": 1, "ts": "2026-07-05T12:00:01+00:00", "type": "llm_call",
         "payload": {"decision_id": None, "provider": "openai", "model": "gpt-4o",
                     "usage": {"input_tokens": 10, "output_tokens": 5, "cached_tokens": 0,
                               "reasoning_tokens": 0, "cache_write": 0},
                     "cost": "0.00042 USD", "latency_ms": 12.5, "replayed": False}},
        {"prevHash": "b" * 64, "seq": 2, "ts": "2026-07-05T12:00:02+00:00", "type": "decision_record",
         "payload": {"decision_id": "abc", "score": 3, "ratio": 2.0, "flag": True, "note": "café ☕"}},
    ]
    hvec = []
    for c in hcases:
        body = _canonical({"seq": c["seq"], "ts": c["ts"], "type": c["type"], "payload": c["payload"]})
        h = _chain_hash(c["prevHash"], c["seq"], c["ts"], c["type"], c["payload"])
        hvec.append({**c, "canonicalBody": body, "hash": h})
    (adir / "hashes.json").write_text(json.dumps({"cases": hvec}, indent=2, ensure_ascii=False), encoding="utf-8")

    # --- _meta signature vector ----------------------------------------------
    meta = {"system": "refund-bot", "risk_tier": "high", "head_hash": "c" * 64, "entries": 7}
    meta_sig = _meta_signature(KEY.encode("utf-8"), meta)
    (adir / "meta-sig.json").write_text(
        json.dumps({"key": KEY, "meta": meta, "sig": meta_sig,
                    "canonicalBody": _canonical({"system": meta["system"], "risk_tier": meta["risk_tier"],
                                                 "head_hash": meta["head_hash"], "entries": meta["entries"]})},
                   indent=2), encoding="utf-8")

    # --- detector scan/redact vectors (default policy) -----------------------
    samples = [
        "contact alice@example.com or use sk-ABCDEFGH12345678",
        "my card is 4111 1111 1111 1111 and ssn 123-45-6789",
        "no secrets here, just plain text",
    ]
    dvec = []
    for s in samples:
        findings = [
            {"category": f.category, "group": f.group, "severity": f.severity, "action": f.action, "count": f.count}
            for f in scan(s)
        ]
        cleaned, _ = redact(s)
        dvec.append({"input": s, "findings": findings, "redacted": cleaned})
    (adir / "detect.json").write_text(json.dumps({"cases": dvec}, indent=2, ensure_ascii=False), encoding="utf-8")

    # cleanup raw (unexported) files — keep only the exported chains
    signed_raw.unlink(missing_ok=True)
    unsigned_raw.unlink(missing_ok=True)
    print(f"acttrace: signed verify={signed_ok} ({signed_detail}); {len(hvec)} hash + {len(dvec)} detect vectors")


if __name__ == "__main__":
    gen_cassette()
    gen_acttrace()
    print(f"\nIO fixtures written to {OUT}")
