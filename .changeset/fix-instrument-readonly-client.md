---
"@cendor/core": patch
---

Fix: `instrument()` no longer throws on clients whose task methods are non-writable, non-configurable own properties — notably `@huggingface/inference` v3+, whose `InferenceClient` defines every method with `Object.defineProperty(this, name, { value })`. Such a method can't be replaced in place (assignment raises `TypeError: Cannot assign to read only property 'chatCompletion'`), which crashed the whole Hugging Face path in JS. `instrument()` now falls back to a lightweight Proxy that serves the wrapped method (identity and in-place patching are unchanged for every other client), so HF capture works and the "unknown clients are returned untouched" contract holds even when patching fails.
