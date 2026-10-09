# Changelog

## 0.4.1-preview.1 — unreleased

- Public configuration now accepts raw JSON strings and enforces a 4096-byte UTF-8 limit. Object inputs use their JSON serialization. Unknown fields and JSON whitespace count toward the limit.
- Configurations with duplicate PEM pins or more than 16 pins are now rejected. Each pin must be an Ed25519 SPKI PEM of at most 256 UTF-8 bytes.
- Near-limit configurations remain reusable by a client: derived IDs are omitted when adding them would exceed 4096 bytes. Supplied IDs and every trusted pin are preserved.
- The shared contract checks explicit nulls, invalid or mismatched IDs, and `keyId` without an explicit single pin. When both pin forms are supplied, the single pin must belong to the set; ordered `keyIds` must match every pin. Any trusted member may sign a release, including a member other than the single pin.
- The JavaScript tests now run every generated shared config case as both a JSON string and an object, including exact byte boundaries and signatures from a second trusted key and an untrusted key.
