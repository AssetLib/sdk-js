# @assetlib/sdk-core

An early TypeScript client for signed Assetlib image delivery. Works with the current schema-v1 HTTP delivery API. The Expo adapter supplies native and browser persistence; this package is also usable with your own storage adapter.

The additive browser/JavaScript animation preview supports a restricted, validated Lottie profile with a mandatory still poster. Native image integrations continue using that poster; this does not add native animation playback.

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

Public config: `{ schemaVersion: 1, orgId, appId, environment: 'staging' | 'production', manifestUrl, pinnedPublicKey, keyId? }`. Use the matching `/api/delivery/{orgId}/{appId}/environments/{environment}/manifest` URL; the legacy `/api/delivery/{orgId}/{appId}/manifest` URL remains valid for production. Signed manifests and asset pages must match the configured environment. The PEM Ed25519 public key must come from a trusted provisioning step independent of the delivery response. Public config contains no admin credentials. Importing it from an untrusted source changes the trust anchor; verification cannot establish that the source belongs to your organization.

## Image descriptions

Image descriptors optionally carry signed `accessibility: { defaultLocale, descriptions }` metadata. Descriptions travel with the image descriptor in the release, including state members and dynamic collection images. `resolve()` returns the metadata for the image it actually selects: a cached image from an older release has that older description. Missing remote metadata never inherits the bundled image's description. Existing descriptors without the field remain valid; no extension version is required.

```ts
import { resolveAccessibilityDescription } from '@assetlib/sdk-core';

const result = await client.resolve(AppAssets.Travel.coast);
const description = resolveAccessibilityDescription(result.accessibility, 'en-GB');
// The application decides whether this usage needs a description or is decorative.
```

The pure resolver tries a case-insensitive exact locale, progressively removes subtags, then uses `defaultLocale`. There is no filename-derived description or automatic accessibility behavior. Metadata requires 1–32 unique locale tags (case-insensitive), each at most 63 characters and matching `[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*`. The default must name an existing locale. Descriptions must contain non-whitespace text and be at most 1,000 UTF-16 code units. A present null or invalid metadata field rejects the descriptor.

App-owned catalog placements may include `bundledAccessibility` with the same shape. It is returned only for bundled fallback artwork. For state sets, `bundledStateAccessibility` maps declared states to their own bundled metadata for the adapter. Offline code generation validates and preserves both fields. Keep these descriptions synchronized with checked-in bundled images. App controls should describe their action; descriptive artwork and decorative artwork remain choices made by each usage.

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

## Select only the user's assigned catalog entries

The host backend determines card ownership/assignment. Match its artwork keys against references checked into the application, then resolve only those references:

```ts
import { selectCatalogReferences } from '@assetlib/sdk-core';

const catalog = [AppAssets.Cards.gold, AppAssets.Cards.blue, AppAssets.Cards.green];
const { references, unknownKeys } = selectCatalogReferences(catalog, backendArtworkKeys);
await client.refresh(); // Downloads a signed manifest, no image or animation bodies.
const selectedImages = await Promise.all(references.map(ref => client.resolve(ref)));
// Show a generic bundled placeholder for unknownKeys; never construct URLs from them.
```

The helper preserves assignment order, removes duplicates, and accepts at most 100 catalog entries and 100 keys. Unknown strings produce no reference and no request. It does not establish authorization. Public artwork must not contain account data; the app renders customer labels and handles assignment independently. Ship a small generic bundled fallback rather than every catalog image if install size matters. Measure app binary size separately from downloaded payload bytes.

## Explicit Lottie resolution

```ts
const animation = await client.resolveAnimation(AppAssets.Cards.gold);
if (animation.source === 'poster') {
  // Use ordinary client.resolve(ref), then the generic bundled placeholder if needed.
} else {
  // animation.data is validated JSON for a compatible browser Lottie player.
  // animation.source is 'remote' or 'cache'; bytes and verified metadata are included.
}
```

`resolveAnimation(ref)` never plays content automatically. Respect reduced motion, display the still poster while loading or on playback failure, and dispose the player on selection changes/unmount. Ordinary `resolve(ref)` never fetches animation bytes. Use one client and a storage adapter accepting `StorageMime` (`AssetMime | 'application/json'`); JSON is not an image format candidate.

The optional signed `animationSchemaVersion: 1` enables a per-slot `animation` descriptor containing `format: 'lottie'`, `profile: 'vector-v1'`, `mime: 'application/json'`, SHA-256, URL, bytes, width/height, frameRate, inPoint and outPoint. The SDK verifies same-origin app-scoped URLs, exact aspect ratio, signed byte count/hash, and equality between the signed metadata and parsed JSON before exposing data. Unknown schema/profile versions fail closed. Existing image-only clients can ignore the extension and use the mandatory WebP poster.

`vector-v1` accepts self-contained 2D shape layers with groups, paths, rectangles, ellipses, fills, strokes, transforms and trim paths. Static and bounded numeric/shape keyframes are supported. Animated properties require at least two strictly ordered keyframes, array-valued starts/ends (one element for scalars), consistent dimensions/path topology and complete easing for interpolated segments. Transforms require opacity, rotation, position, anchor and scale. It rejects images, fonts/text, precompositions, external resources, expressions, effects, masks, 3D content, unusual blending/time stretching and unknown extensions. `validateLottie(bytes)` exposes the same parser for tools and upload services, returning `{ data, width, height, frameRate, inPoint, outPoint }` without rewriting the original bytes. Rejection messages identify unsupported structure.

Limits: UTF-8 JSON up to 512 KiB, dimensions 1–2048, at most 4,194,304 pixels, 1–60 fps, duration up to 30 seconds / 1,800 frames, 32 layers, 2,048 shapes, 4,096 keyframes/vertices, 30,000 document values and nesting depth 32. An arbitrary hash-valid JSON file is never sufficient for playback.

Verified cached animation works offline. Only the current descriptor may trigger a download; if it fails, retained historical releases may supply an already cached compatible animation. Historical bytes are reverified and never downloaded. If the current release removes animation or its placement, resolution returns `source: 'poster'` immediately instead of reviving an old animation. First-use offline and unsupported/failed animations also return that poster outcome.

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

Tests include the shared cross-platform contract corpus, catalog subset requests, Lottie profile rejection/metadata verification, animation cache/offline/rollback/removal behavior, selection, PNG/SVG bytes and offline fallback, plus real Node Ed25519 signatures and bounded mock delivery streams. They cover signature and byte tampering, independent pins, replay across client restarts, corrupt storage, offline cache fallback, contract mismatch, URL boundaries, deadlines, and offline code generation. The npm pack contains built JavaScript and declarations; it does not require TypeScript compilation when installed.

## Local 0.3 delivery preview

The unpublished 0.3 preview adds `StateSetRef` / `resolveStateSet`, signed `loadAssetPage` / `resolveAsset` runtime handles, and `cachePolicy: 'disk' | 'memory' | 'none'`. The default remains `disk`; ephemeral image policies preserve durable signed release state. Image requests are cancellable and bounded to four concurrent transfers by default. `clearMemoryCache()` releases retained session bytes.

A state set declares 2–16 unique states in the checked-in catalog (`placements[].states`); code generation preserves those literal names. Resolve the complete family once and select its returned state. If any required member is unavailable, the whole family uses an eligible older cached release or the bundled family. Do not substitute one progress stage for another.

Catalog metadata pages are signed, scoped to the app/release/request cursor, and contain at most 50 image references. They fetch no image bodies. Preserve the first page's `sequence` on continuation requests. Runtime handles are bound to their issuing client and cannot be serialized or reconstructed as trusted references. Use the Expo virtualized-list example for visible-only image resolution.

These additions currently apply to JavaScript/Expo. Swift/Kotlin retain legacy image APIs. Catalog-only manifests with no slots are unsupported by those older clients. No publication or production-scale catalog capacity is implied by this local version.
