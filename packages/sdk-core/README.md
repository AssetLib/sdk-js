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
const asset = await client.resolve(AppAssets.Travel.coast, { pixelWidth: 600, pixelHeight: 450 });
// source is 'remote', 'cache', or 'bundle'. Render a bundled image for 'bundle'.
```

`refresh()` returns `{ updated, sequence, error? }`. Errors preserve the previous accepted release. `resolve()` returns `{ source, sequence, message, bytes?, sha256?, assetId?, mime?, pixelWidth?, pixelHeight? }`. `getStatus()` returns `{ initialized, sequence, lastError }`. Use one long-lived client per configured app.

Public config: `{ schemaVersion: 1, orgId, appId, environment: 'production', manifestUrl, pinnedPublicKey, keyId? }`. The PEM Ed25519 public key must come from a trusted provisioning step independent of the delivery response. Public config contains no admin credentials. Importing it from an untrusted source changes the trust anchor; verification cannot establish that the source belongs to your organization.

## Image descriptions

Placement descriptors optionally carry signed `accessibility: { defaultLocale, descriptions }` metadata. `resolve()` returns the metadata for the image it actually selects, including a cached image from an older release. Missing remote metadata never inherits the bundled image's description. Existing descriptors without the field remain valid; no extension version is required.

```ts
import { resolveAccessibilityDescription } from '@assetlib/sdk-core';

const result = await client.resolve(AppAssets.Travel.coast);
const description = resolveAccessibilityDescription(result.accessibility, 'en-GB');
// The app decides whether this usage needs a description or is decorative.
```

Lookup tries a case-insensitive exact locale, progressively removes subtags, then uses `defaultLocale`. Metadata requires 1–32 case-insensitively unique locale tags, each at most 63 characters and matching `[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*` over the entire string. The default must name an existing locale. Descriptions must contain non-whitespace text and be at most 1,000 UTF-16 code units. A present null or invalid metadata field rejects the manifest. Returned remote metadata is immutable.

App-owned catalog placements may include `bundledAccessibility` with the same shape. Offline code generation validates and preserves it, and resolution returns it only for bundled artwork. Keep it synchronized with the checked-in image. The SDK does not generate labels from filenames or attach accessibility behavior to raw images. Controls should describe their action; decorative versus descriptive artwork is a choice made by each usage.

## Image formats and sizes

Preview 0.2 accepts the optional signed `renditionSchemaVersion: 1` extension. Existing schema-1 manifests still work; older clients can use the mandatory WebP fallback in new manifests. By default, the client selects PNG or WebP. Ask for physical pixels with both `pixelWidth` and `pixelHeight`; without a target, selection uses the generated placement dimensions. Layout and display density remain the application's responsibility.

Selection uses the smallest rendition covering both dimensions, then byte size and hash. If every rendition is smaller, the largest is preferred. Failed candidates advance to the next candidate, then the legacy fallback. Historical releases remain cache-only. The result describes the actual selected MIME, hash and pixel dimensions. It does not convert one format into another on the device.

A browser renderer can opt into normalized SVG with `formats: ['image/webp', 'image/png', 'image/svg+xml']`. SVG is then preferred. Generic/native clients should retain the raster defaults. The core validates signed metadata, hash, byte length and basic headers; adapters must decode images and verify dimensions before rendering. The Expo web adapter performs browser decoding, while the standalone Swift/Kotlin SDKs use native decoders.

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

Clearing app data, uninstalling the app, browser storage eviction, or changing the trust configuration resets local replay protection. This preview does not claim protection against a compromised device or browser. Storage adapters must enforce atomic, nondecreasing state replacement. No background refresh, resumable download, HTTP content negotiation, usage telemetry, image-render exposure events, experiment assignment, or cryptographic key rotation is implemented. Rendering support is supplied by the platform; a valid hash does not prove an image is decodable.

## Development

```sh
npm ci
npm test
npm pack
```

Tests include the shared cross-platform rendition contract corpus, selection, PNG/SVG bytes and offline fallback, plus real Node Ed25519 signatures and bounded mock delivery streams. They cover signature and byte tampering, independent pins, replay across client restarts, corrupt storage, offline cache fallback, contract mismatch, URL boundaries, deadlines, and offline code generation. The npm pack contains built JavaScript and declarations; it does not require TypeScript compilation when installed.
