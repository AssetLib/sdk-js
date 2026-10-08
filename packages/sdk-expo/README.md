# @assetlib/sdk-expo

Expo SDK 57 / React Native 0.86 image delivery adapter for `@assetlib/sdk-core`. One integration targets iOS, Android, and Expo web. This is a preview SDK, not separate Swift or Kotlin SDKs.

Install **both exact core and Expo tarball URLs from the same GitHub release** as direct dependencies. The Expo package depends on the matching core preview version; neither package is published to the npm registry. The host app needs Expo 57, React 19, React Native 0.86, and matching `expo-file-system` and `expo-image` versions:

```sh
npx expo install expo-file-system expo-image
```

The package ships Metro-ready TypeScript/TSX source. It has no install-time generation, lifecycle downloads, or secrets. Metro selects the native or web adapter; a custom bundler must honor `.native` / `.web` module resolution.

## Integration

```tsx
import { createExpoAssetClient, AssetlibImage } from '@assetlib/sdk-expo';
import { parsePublicConfig } from '@assetlib/sdk-core';
import { AppAssets } from './assets.generated';

const client = createExpoAssetClient(parsePublicConfig(publicConfig));
await client.initialize(); // Local persisted release only.
await client.refresh(); // Explicit network check.

<AssetlibImage
  client={client}
  asset={AppAssets.Travel.coast}
  fallback={require('./assets/coast.png')}
  accessibilityMode="decorative"
  revision={refreshCounter}
  pixelWidth={600}
  pixelHeight={450}
  style={{ width: '100%', aspectRatio: 4 / 3 }}
  contentFit="cover"
  onStatus={(status) => console.log(status.source, status.sequence)}
/>
```

Create a long-lived client outside repeated renders. After an explicit `refresh()`, increment `revision` to request the current artwork. `AssetlibImage` initially displays the bundled fallback, then a verified local image. A native/browser image decode error returns to the bundled image. Supply a stable `fallback` value, such as React Native's numeric `require()` result.

`onStatus` reports source selection and verification, not a user impression or proof that the image was visible. Do not send experiment exposure events from this callback. App layout, accessibility labels, image sizing, and refresh policy remain app-owned. Rendering uses `expo-image` for downloaded PNG/WebP support on iOS and Android; props follow Expo Image. Its separate disk cache is disabled because Assetlib owns the verified byte cache.

## Accessibility per usage

Opt into the localized description that matches the displayed artwork:

```tsx
<AssetlibImage
  client={client}
  asset={AppAssets.Travel.coast}
  fallback={require('./assets/coast.png')}
  accessibilityMode="description"
  accessibilityLocale="en-GB"
  fallbackAccessibility={{
    defaultLocale: 'en',
    descriptions: { en: 'An illustrated coastal escape' },
  }}
/>
```

`fallbackAccessibility` describes only the bundled image. It defaults to the reference's `bundledAccessibility` from the checked-in catalog. Remote and cached artwork use their own signed descriptions. Decode failures and request changes restore the corresponding bundle and description together. Description mode retains the bundle when remote metadata is missing. Supply a useful bundled description when choosing this mode. Native `accessibilityLabel` remains an explicit app override, including for legacy releases without metadata.

For decorative artwork, set `accessibilityMode="decorative"` to hide the image from accessibility services. When an image is inside a control, label the action on the control and make the artwork decorative. Omitting the mode preserves ordinary Expo accessibility props and does not attach a universal label. Pass the app's active locale through `accessibilityLocale`; lookup tries exact locale, parent subtags, then the metadata's explicit default. The pure `resolveAccessibilityDescription()` helper and `AssetAccessibility` type are exported for custom renderers.

## Storage and networking

Native uses the maintained Expo `File`, `Directory`, and `Paths` APIs, with private app-document storage and a recoverable state replacement journal. Native delivery uses streaming `expo/fetch`. Web uses transactional IndexedDB, browser Fetch, and ephemeral Blob image URLs, released when the component changes or unmounts. No credentials are attached to public delivery requests; the server must allow the web demo origin through CORS.

Caches are isolated by delivery URL, organization, app, environment, and pinned key. Image storage is bounded to 50 MiB / 100 entries per configuration; the core retains eight signed releases. Cached content is rehashed. A missing cache resolves to the bundled fallback. Corrupt release state fails closed rather than resetting the stored sequence.

There is no automatic app-data reset API: disconnect the client to show bundled artwork while retaining the cache. Explicitly clearing app/browser data removes stored replay protection. Multiple native clients are serialized within one JavaScript process; cross-process synchronization is outside this preview's contract. Preview 0.2 supports PNG/WebP renditions selected by explicit pixel size. Logical placement dimensions still match the generated catalog. Native caches preserve compatibility with existing `.webp` entries. Web can opt into normalized SVG with `createExpoAssetClient(config, { allowVector: true })`; enabling that option on native throws. Native SVG, PDF and animated delivery are not implemented. Browser rendering checks decoded dimensions before handing the image to Expo; native Expo decode errors fall back to the bundled image. See the core README for signature, timeout, body-size, and compatibility limits.

## Validation

`npm test` checks matching descriptions, locale changes, legacy metadata fallback, decode failure, and stale requests with a React test renderer and mocked platform boundaries. `npm run typecheck` checks against the current Expo 57 APIs. Core security and offline tests run in the sibling package. Actual iOS/Android runtime and web delivery checks must be reported separately; typechecking alone is not evidence of a native device run.
