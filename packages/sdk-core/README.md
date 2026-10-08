# @assetlib/sdk-core

An early TypeScript client for signed Assetlib image delivery. Works with the current schema-v1 HTTP delivery API. The Expo adapter supplies native and browser persistence; this package is also usable with your own storage adapter.

This preview is distributed as a versioned GitHub release tarball, not an npm registry package. Install the exact core and Expo tarballs supplied with the release together. A catalog generation step reads local JSON; app builds do not contact Assetlib.

## Client

```ts
import { createAssetClient, parsePublicConfig } from '@assetlib/sdk-core';
import { AppAssets } from './assets.generated';

const config = parsePublicConfig(publicConfig);
const client = createAssetClient(config, { storage: durableStorage });
await client.initialize(); // Verify persisted state; no network request.
const release = await client.refresh(); // Fetch and verify the manifest.
const asset = await client.resolve(AppAssets.Travel.coast); // Download on demand.
// source is 'remote', 'cache', or 'bundle'. Render a bundled image for 'bundle'.
```

`refresh()` returns `{ updated, sequence, error? }`. Errors preserve the previous accepted release. `resolve()` returns `{ source, sequence, message, bytes?, sha256?, assetId?, mime? }`. `getStatus()` returns `{ initialized, sequence, lastError }`. Use one long-lived client per configured app.

Public config: `{ schemaVersion: 1, orgId, appId, environment: 'production', manifestUrl, pinnedPublicKey, keyId? }`. The PEM Ed25519 public key must come from a trusted provisioning step independent of the delivery response. Public config contains no admin credentials. Importing it from an untrusted source changes the trust anchor; verification cannot establish that the source belongs to your organization.

## Offline typed references

Check a catalog into your application:

```json
{
  "schemaVersion": 1,
  "placements": [
    { "key": "travel.coast", "symbol": ["Travel", "coast"], "width": 1200, "height": 900 }
  ]
}
```

```sh
node node_modules/@assetlib/sdk-core/bin/codegen.mjs assetlib.catalog.json > src/assets.generated.ts
```

Use `AppAssets.Travel.coast` in application code. Existing compatible artwork updates do not require regenerating this catalog. Adding a new application placement does. Schema v1 identifies placements by key and exact width/height; stable placement IDs and separately versioned contracts are not implemented yet. Renaming a key requires a coordinated migration, not simply renaming it in the console.

## Verification and operating limits

- Ed25519 signatures are checked against the independently pinned key using strict RFC 8032 verification. An envelope cannot replace the pinned key.
- Schema, app, organization, environment, key ID, sequence, placement dimensions, and delivery URLs are checked. Image bytes must match the signed SHA-256 and byte count.
- HTTPS is required. `{ allowInsecureLoopback: true }` permits HTTP only for `localhost`, `127.0.0.1`, or `::1`; it does not permit arbitrary LAN hosts.
- Delivery is credentialless. Redirects are rejected. A streaming Fetch implementation is required so chunked responses can be bounded. The Expo adapter uses `expo/fetch` on native.
- Default deadline: 8 seconds per request; configurable from 20 milliseconds to 30 seconds. Maximum manifest response: 256 KiB. Maximum image: 8 MiB. Maximum placements: 100.
- Persistent state keeps the highest accepted sequence and eight signed releases, up to 3 MiB. A lower sequence or different payload reusing a sequence is rejected. Legitimate server rollback must publish a new, higher sequence.
- A failed current image resolves to a compatible cached image from the retained release history, then to the app's bundled fallback. Older releases never cause a new download. Eviction or more than eight accepted releases can remove a previous fallback.
- Cache bytes are rehashed before use. The supplied adapters bound image storage to 50 MiB and 100 entries per configuration. Persistence is required before activating a new release. Corrupt replay state fails closed; it is not automatically discarded.

Clearing app data, uninstalling the app, browser storage eviction, or changing the trust configuration resets local replay protection. This preview does not claim protection against a compromised device or browser. Storage adapters must enforce atomic, nondecreasing state replacement. No background refresh, resumeable download, compression negotiation, usage telemetry, image-render exposure events, experiment assignment, or cryptographic key rotation is implemented. Rendering support is supplied by the platform; a valid hash does not prove an image is decodable.

## Development

```sh
npm ci
npm test
npm pack
```

Tests use real Node Ed25519 signatures and bounded mock delivery streams. They cover signature and byte tampering, independent pins, replay across client restarts, corrupt storage, offline cache fallback, contract mismatch, URL boundaries, deadlines, and offline code generation. The npm pack contains built JavaScript and declarations; it does not require TypeScript compilation when installed.
