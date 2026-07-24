---
"@cendor/core": patch
---

`instrument()` now detects a boto-shaped `converse_stream` as an always-stream Bedrock target, routed through the existing Bedrock stream/usage branches — closing the last undocumented `instrument()` detection asymmetry with the Python library. The public provider stays `bedrock`; the response object's `stream` member is wrapped and handed back unchanged, so `for await (const e of response.stream)` still works.
