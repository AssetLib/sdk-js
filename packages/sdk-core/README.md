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

`refresh()` returns `{ updated, sequence, error? }`. Errors preserve the previous accepted release. `resolve()` returns `{ source, sequence, message, arm, armSource, bytes?, sha256?, assetId?, mime?, pixelWidth?, pixelHeight?, rendering? }`. `getStatus()` returns `{ initialized, sequence, lastError }`. Use one long-lived client per configured app.

Public config: `{ schemaVersion: 1, orgId, appId, environment: 'staging' | 'production', manifestUrl, pinnedPublicKey?, keyId?, pinnedPublicKeys?, keyIds? }`. Supply `pinnedPublicKey` or a `pinnedPublicKeys` array of 1–16 distinct exact-PEM Ed25519 SPKI public keys. Each PEM is limited to 256 UTF-8 bytes. When both are present, the single key must exactly match a member of the set. Configurations with only `pinnedPublicKey` retain their existing behavior and parsed shape.

`parsePublicConfig` accepts a JSON string or an object. JSON is limited to 4096 UTF-8 bytes: strings are measured exactly, including whitespace; objects are measured and parsed using their `JSON.stringify` serialization. Unknown fields are ignored after counting their serialized bytes. Explicit `null` values for recognized fields are rejected, including the optional pin and ID fields.

`keyId`, when supplied, must match the single key and requires `pinnedPublicKey`. Each ID is the first 16 lowercase hexadecimal characters of SHA-256 over the exact UTF-8 PEM text. Optional `keyIds` must match the pinned keys in array order (or the single key when no set is supplied). `parsePublicConfig` derives missing IDs, omitting added IDs when needed to keep its result within 4096 bytes for reuse by a client. Supplied IDs are preserved. Manifests and asset pages may be signed by any member of the pinned set; each envelope's `publicKey` must exactly match that member and its `keyId` must match that key's derived ID. A supplied ID never authorizes an unpinned key.

Use the matching `/api/delivery/{orgId}/{appId}/environments/{environment}/manifest` URL; the legacy `/api/delivery/{orgId}/{appId}/manifest` URL remains valid for production. Signed manifests and asset pages must match the configured environment. Every pinned key must come from a trusted provisioning step independent of the delivery response. Public config contains no admin credentials. Importing it from an untrusted source changes the trust anchor; verification cannot establish that the source belongs to your organization.

To prepare a signing-key rotation, ship a trusted configuration containing both the current and next keys before the server starts signing with the next key. Keep retiring keys pinned while retained releases still need to verify. The SDK does not discover or download replacement trust anchors. `storageNamespace(config)` scopes durable replay state to the manifest origin, organization, app, and environment. Key-set changes and switching between the production manifest routes preserve that identity; staging remains separate. Expo migrates verified state from its previous single-key and sorted-key-set namespaces once when the new namespace is empty. Custom durable adapters should use this identity and `verifyStoredState(serialized, config)` when migrating their prior namespace.

## Optional runtime observations

Telemetry is **off by default**. Opt in when creating the client, and supply your application's registered build metadata:

```ts
const client = createAssetClient(config, {
  storage: durableStorage,
  telemetry: {
    enabled: true,
    build: { platform: 'web', appVersion: '1.6.0', buildNumber: '231' },
    // flushIntervalMs: 60_000, maxBatch: 200
  },
});
const image = await client.resolve(AppAssets.Travel.coast);
// Call only after your renderer has decoded and attached this remote/cached image.
client.reportDisplay(AppAssets.Travel.coast, image);
// On renderer failure: client.reportFallback(AppAssets.Travel.coast, image, 'decode');
await client.flush();
```

Each batch goes to the configured manifest origin's `/api/delivery/{orgId}/{appId}/observations` route without credentials. It contains only schema version, environment, SDK name/version, build platform/version/number, a random install ID, send time, and coalesced event counts. Event coordinates contain the placement key, event kind, effective source, asset ID and release sequence when available, effective arm/appearance when selected, and a fallback reason (`offline`, `verification`, `decode`, `missing`, or `other`). Image bytes, image URLs, hashes, descriptions, diagnostic messages, user accounts, device identifiers, and experiment callback data are not sent. Default metadata is `sdk-core` with this package's version and `{ platform: 'web', appVersion: 'unknown', buildNumber: 'unknown' }`; supply actual build metadata for useful build comparisons.

Successful placement resolutions record `resolve`; a successfully resolved state set records its committed members, never a partially discarded family. A bundled outcome records only `fallback`, without an asset ID or sequence. Dynamic catalog references have no placement key and are omitted from observations, including explicit display/fallback reports. `display` is emitted only when the adapter calls `reportDisplay`: it means decoded and attached, **not seen by a person**, and is not experiment exposure or a unique-user count. Animation playback is not observed.

Without an explicit `installId`, the SDK generates a random 32-character hexadecimal ID and stores it under a dedicated per-origin, per-organization, per-app key through `storage.getOrCreateInstallId(key, create)`. Custom durable adapters must implement this optional method atomically: return the existing ID or persist the new `create()` value before returning. The same install shares its ID across staging and production. Clearing app data resets it. `createMemoryStorage()` preserves it only for that adapter instance; use durable storage to retain it across app restarts. An adapter without this method, a persistence failure, or an unavailable secure random source suppresses generated-ID telemetry. The app can instead supply its own persistent, random, opaque `installId` of 8–64 characters. Never use a device, account, advertising, or other personal identifier.

Events coalesce in memory, with at most 2,000 pending coordinates. `flush()` sends one batch of at most 200 events (or a smaller `maxBatch`), capped at 64 KiB, with each count capped at 10,000. Excess count remains queued for subsequent batches. Pending events flush every 60 seconds by default and when `refresh()` runs; explicit `flush()` is useful before backgrounding. A request has a five-second deadline; failed batches stay in memory for the next flush and are not immediately retried. Reporting never blocks or fails artwork resolution. A successful send removes only the sent counts, preserving events recorded during the request. Pending events are not persisted and may be lost when the process exits; a lost response can result in duplicate counts on a later retry. `dispose()` stops telemetry timers and discards its pending observations when the client is no longer needed.

Nonpositive or noninteger interval/batch settings use the defaults; `maxBatch` is capped at 200. Build versions and SDK names/versions accept 1–64 characters from letters, digits, `.`, `_`, `+`, and `-`. Invalid build, SDK, or install-ID metadata disables reporting without changing artwork resolution.

The hosted Assetlib service validates each batch as a whole, accepts at most 64 KiB per request, and stores no raw event log and no raw install ID. Accepted counts are added to daily aggregates keyed by the UTC day of receipt, kept for 90 UTC days. For install coverage it keeps a SHA-256 hash of the install ID and UTC day, per app, environment and day, for 7 UTC days. Expired rows are removed when later batches arrive, not on a fixed schedule. Reporting installs summed over several days are install-days, not unique installations or people. Request infrastructure handles network addresses and headers; they are not stored in the aggregates.

Enabling reporting changes your app's data collection. Review Google Play Data safety disclosures, App Store privacy disclosures and any applicable privacy manifest requirements against your app's actual use. A random install identifier is still sent to the service; enabling this option does not automatically update those declarations or establish consent. Hashing an identifier does not by itself make it anonymous or remove disclosure requirements. Suggested wording for an app team's data inventory, to adapt to your actual configuration:

> When enabled, Assetlib sends app/build version information, placement and asset identifiers, image resolution/display/fallback counts, and a random app-install identifier to our configured Assetlib service for asset-delivery diagnostics. Telemetry is disabled by default. The service stores daily aggregates and day-specific install hashes, not raw event logs or the raw install identifier. A display report means the renderer decoded and attached an image, not that a person viewed it.

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

## Tintable icons

A catalog placement can declare `"rendering": "template"`. Assetlib then delivers a single-color shape, and the app supplies the color when it draws it, for example from its theme or a selected state. Values are `original` (the default when absent) and `template`. Code generation adds `rendering: 'template'` to that placement's reference and omits the field otherwise, so catalogs without it generate the same output as before.

```json
{ "key": "tab.trips", "symbol": ["Tabs", "trips"], "width": 24, "height": 24, "rendering": "template" }
```

Signed image descriptors (placements, state members, variant cells and catalog page images) may carry `rendering`. A present value that is not a string matching `^[a-z][a-z0-9-]{0,31}$` rejects the release; absent means `original`. Resolution compares the reference's rendering with the descriptor actually selected after arm, appearance and state selection. If they differ, or the descriptor names a value this client does not know, that placement uses the bundled fallback with `fallbackReason: 'missing'`, as for an incompatible size: the cache is not read and nothing is downloaded. Retained releases follow the same rule, and other placements are unaffected. Catalog page images resolve as `original`. `ResolvedAsset.rendering` reports the delivered descriptor's rendering, `'original'` or `'template'`.

The bundled fallback must also be a single-color shape, such as a PNG with alpha, because the app applies the same tint to remote and bundled artwork. Remote masks are rasters, so request physical pixels with `pixelWidth` and `pixelHeight` (logical size × display scale); the Expo adapter does this for template references. Template rendering needs this SDK and CLI or newer: older code generation drops the field, and older runtimes do not check it. Publishing template descriptors from the hosted console is planned; until then releases carry no `rendering` field.

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

## Appearance and arm variants

A catalog placement can declare either or both axes: `"variants": { "appearance": ["dark"], "arm": ["b", "c"] }`. Code generation preserves this declaration on `AssetRef` and `StateSetRef`; `assetlib sync` includes it in build registration. Appearance accepts one or two unique `light`/`dark` values. Arms accept one to four unique strings matching `^[a-z][a-z0-9_-]{0,19}$`, excluding `control`, `any`, `constructor`, `prototype`, and `__proto__`. Unknown axes and empty declarations are rejected. Control is implicit and is never listed in `variants.arm`.

```ts
const image = await client.resolve(AppAssets.Travel.coast, { arm: 'b', appearance: 'dark' });
const family = await client.resolveStateSet(AppAssets.Tasks.garden, { arm: 'b', appearance: 'dark' });
```

Signed manifests retain `variantSchemaVersion: 1` and provide each placement's `variants` and bound `cells`. Cells omit `arm` for control and omit `appearance` for Any; at least one coordinate must be present. Duplicate coordinates, undeclared values, and incomplete state families reject the manifest. Resolution selects the first bound coordinate in this order:

1. Requested arm and appearance.
2. Requested arm and Any appearance.
3. Control arm and requested appearance.
4. The placement's legacy fields (Control/Any).

Omitting `appearance` requests Any. An explicit `arm: 'control'` bypasses decisions and requests control. An undeclared explicit arm inherits control through the same order. No other arm or appearance supplies artwork. Each stateful coordinate supplies an entire family; individual states are never mixed between coordinates or releases. Descriptions and renditions belong to the selected descriptor.

Image cache keys include the requested arm and appearance, even when the artwork inherits control. Retained releases use the same selection order and the same decision, with cached bytes only. `ResolvedAsset.sha256` remains the content hash; `cacheKey`, when present, identifies the storage entry. Custom adapters that open cached files should use `cacheKey ?? sha256`. Existing manifests and control cache keys remain supported. `resolveAnimation` continues to use Control/Any and never calls `decide`; asset-page payloads remain unchanged.

## App-supplied decisions

```ts
const client = createAssetClient(config, {
  storage: durableStorage,
  decide: async ({ key, arms, appearance }) => {
    // Read an assignment from your app's experiment tool without logging exposure.
    return experimentAssignments[key];
  },
});
const image = await client.resolve(AppAssets.Travel.coast, { appearance: 'dark' });
```

`decide` may return a declared arm or a promise for one. It runs once per `resolve` or `resolveStateSet` call when no explicit arm was supplied and the current compatible signed slot declares arms. The callback receives the placement key, an immutable array of declared arms, and the requested appearance when present. It never runs for slots without arms, missing slots, or before any signed manifest is available. The SDK does not persist assignment decisions; the app's experiment tool controls assignment stability.

The callback runs outside the client's operation queue with a 1,500 millisecond deadline. Set `decisionTimeoutMs` to an integer from 100 through 10,000 to change it. A pending callback never blocks refresh, initialization, or explicit arm/control requests. After it settles, the client revalidates durable state and selects from the current accepted release, including a newer release accepted by another client sharing storage. Failed revalidation uses the bundled fallback.

An undefined, undeclared, throwing/rejected, or timed-out result selects control, returns `armSource: 'invalid-decision'`, and explains why in `message`. Arm declarations are checked against the current release after the callback. Without a callback, omitted arms use `armSource: 'control'`. Explicit requests use `'explicit'`; accepted callback assignments use `'decision'`.

Every resolved image and state family reports `arm: string | null`: the arm of the artwork actually selected, or `null` for control or bundled fallback. `armSource` records how the request was chosen even when it inherits control or uses the bundle. State members carry the family's arm metadata. These are resolution diagnostics. **Exposure must be logged by the app's experiment tool after the intended artwork is rendered, never from this callback.** A decision can lead to a cache lookup, fallback, cancellation, or artwork that is never displayed.

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

- Ed25519 signatures are checked against an independently pinned key from the configured single key or set using strict RFC 8032 verification. An envelope cannot add or replace a pinned key.
- Schema, app, organization, environment, key ID, sequence, placement dimensions, and delivery URLs are checked. Image bytes must match the signed SHA-256 and byte count.
- Public config: at most 4096 UTF-8 JSON bytes, 1–16 distinct exact-PEM pins, and 256 UTF-8 bytes per Ed25519 SPKI PEM. These limits are exported as `SDK_LIMITS.configBytes`, `pinnedKeys`, and `publicKeyBytes`.
- HTTPS is required. `{ allowInsecureLoopback: true }` permits HTTP only for `localhost`, `127.0.0.1`, or `::1`; it does not permit arbitrary LAN hosts.
- Delivery is credentialless. Redirects are rejected. A streaming Fetch implementation is required so chunked responses can be bounded. The Expo adapter uses `expo/fetch` on native.
- Default deadline: 8 seconds per request; configurable from 20 milliseconds to 30 seconds. Maximum manifest response: 256 KiB. Maximum image: 8 MiB. Maximum placements: 100.
- Persistent state keeps the highest accepted sequence and eight signed releases, up to 3 MiB. A lower sequence or different payload reusing a sequence is rejected. Legitimate server rollback must publish a new, higher sequence.
- A failed current image resolves to a compatible cached image from the retained release history, then to the app's bundled fallback. Older releases never cause a new download. Eviction or more than eight accepted releases can remove a previous fallback.
- Cache bytes are rehashed before use. The supplied adapters bound image storage to 50 MiB and 100 entries per configuration. Persistence is required before activating a new release. Corrupt replay state fails closed; it is not automatically discarded.

Clearing app data, uninstalling the app, or browser storage eviction can reset local replay protection across restarts. Changing pinned keys or the production manifest route does not reset it. An active client fails closed if accepted durable state disappears, moves backwards, conflicts, or cannot be verified. This preview does not claim protection against a compromised device or browser. Storage adapters must enforce atomic, nondecreasing state replacement. No background manifest refresh, resumable download, HTTP content negotiation, experiment assignment, or automatic signing-key distribution is implemented. Opt-in observation counts do not establish experiment exposure. Rendering support is supplied by the platform; a valid hash does not prove an image is decodable.

## Development

```sh
npm ci
npm test
npm pack
```

Tests include the shared cross-platform contract corpus (`test/fixtures/shared`, byte-identical with the Swift and Kotlin SDKs' copies: 115 signed manifest cases, 43 public config cases exercised as strings and objects, 18 appearance/arm resolution cases, 10 tintable icon rendering cases, staging configuration, stateful replay, byte-failure and rendition selection cases), separate JavaScript key-set fixtures for a second trusted signer and an untrusted signer, catalog subset requests, Lottie profile rejection/metadata verification, animation cache/offline/rollback/removal behavior, selection, PNG/SVG bytes and offline fallback, plus real Node Ed25519 signatures and bounded mock delivery streams. They cover signature and byte tampering, independent pins, replay across client restarts, corrupt storage, offline cache fallback, contract mismatch, URL boundaries, deadlines, and offline code generation. The npm pack contains built JavaScript and declarations; it does not require TypeScript compilation when installed.

## State sets, catalog pages, and cache policies

Release 0.4.0-preview.1 adds `StateSetRef` / `resolveStateSet`, signed `loadAssetPage` / `resolveAsset` runtime handles, and `cachePolicy: 'disk' | 'memory' | 'none'`. The default remains `disk`; ephemeral image policies preserve durable signed release state. Image requests are cancellable and bounded to four concurrent transfers by default. `clearMemoryCache()` releases retained session bytes.

A state set declares 2–16 unique states in the checked-in catalog (`placements[].states`); code generation preserves those literal names. Resolve the complete family once and select its returned state. If any required member is unavailable, the whole family uses an eligible older cached release or the bundled family. Do not substitute one progress stage for another.

Catalog metadata pages are signed, scoped to the app/release/request cursor, and contain at most 50 image references. They fetch no image bodies. Preserve the first page's `sequence` on continuation requests. Runtime handles are bound to their issuing client and cannot be serialized or reconstructed as trusted references. Use the Expo virtualized-list example for visible-only image resolution.

These additions currently apply to JavaScript/Expo. Swift/Kotlin retain legacy image APIs. Catalog-only manifests with no slots are unsupported by those older clients. No production-scale catalog capacity is implied.
