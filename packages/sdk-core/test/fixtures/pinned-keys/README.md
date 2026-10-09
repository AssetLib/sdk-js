# JavaScript pinned key set fixtures

These fixtures are specific to Workstream N. They do not extend the shared
native-contract corpus or its `cases.json`; native key-set support is a later
workstream.

`config.json` pins the original key from `../config.json` and a second key. The
second-key manifest must verify against that set. The outside-key manifest has a
valid signature from a third key and must be rejected because that key is absent
from the set. Both manifests sign the exact existing `../payloads/seq2.utf8`
bytes, leaving all existing signed payloads and corpus entries unchanged.

All keys are **TEST ONLY**. The second seed is the 32 bytes `20` through `3f`;
the outside seed is `40` through `5f`. Reconstruct Ed25519 PKCS#8 DER by prefixing
each seed with `302e020100300506032b657004220420`, then export its SPKI public key
as PEM. Key IDs are the first 16 lowercase hexadecimal characters of SHA-256 of
the exact PEM UTF-8 bytes, including its trailing newline. Sign the unchanged
payload bytes with Node's `crypto.sign(null, bytes, privateKey)` and base64-encode
the signature. JSON files use two-space indentation and a final newline; seed
files contain lowercase hexadecimal and a final newline.

`pinned-keys.test.mjs` independently reproduces the keys and signatures with Node
crypto. Every file in this directory is listed in the parent `SHA256SUMS`, which
is also checked by the existing fixture-integrity test.
