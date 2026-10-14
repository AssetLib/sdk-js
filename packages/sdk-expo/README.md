# @assetlib/sdk-expo

Expo SDK 54 to 57 (React Native 0.81 to 0.86) image delivery adapter for `@assetlib/sdk-core`. One integration targets iOS, Android, and Expo web. This is a preview SDK, not separate Swift or Kotlin SDKs.

Install **`@assetlib/sdk-core` and `@assetlib/sdk-expo` at the same exact version** as direct dependencies, from npm (`preview` dist-tag) or as the tarballs attached to the same GitHub release. The Expo package depends on that exact core version. The host app needs Expo SDK 54, 55, 56 or 57 with that SDK's React Native and React 19, and the `expo-file-system` and `expo-image` versions that SDK installs:

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
  revision={refreshCounter}
  pixelWidth={600}
  pixelHeight={450}
  style={{ width: '100%', aspectRatio: 4 / 3 }}
  contentFit="cover"
  onStatus={(status) => console.log(status.source, status.sequence)}
/>
```

Create a long-lived client outside repeated renders. After an explicit `refresh()`, increment `revision` to request the current artwork. `AssetlibImage` initially displays the bundled fallback, then a verified local image. A native/browser image decode error returns to the bundled image. Supply a stable `fallback` value, such as React Native's numeric `require()` result.

`onStatus` reports source selection and verification, including the effective `arm` (`null` for control) and `armSource` (`explicit`, `decision`, `control`, or `invalid-decision`). Initial bundle and renderer-failure statuses use `arm: null` and `armSource: 'control'`; resolved statuses preserve the core's decision diagnostics. This callback is not a user impression or proof that the image was visible. Do not send experiment exposure events from this callback. App layout, accessibility labels, image sizing, and refresh policy remain app-owned. Rendering uses `expo-image` for downloaded PNG/WebP support on iOS and Android; props follow Expo Image except `cachePolicy`, which controls Assetlib's verified byte retention. The renderer's independent cache is always disabled. Pending resolution is cancelled when a component unmounts or changes its asset request.

## Appearance variants

Declare `"variants": { "appearance": ["dark"] }` on a checked-in catalog placement and regenerate its reference to enable a dark cell. `AssetlibImage`, `AssetlibStateImage`, and `AssetlibDynamicImage` accept `appearance="light"`, `"dark"`, or `"system"` (the default). System mode reads React Native's `useColorScheme()`; a null scheme sends no appearance preference. A change in the effective appearance cancels the previous request and resolves again automatically.

```tsx
<AssetlibImage
  client={client}
  asset={AppAssets.Travel.coast}
  fallback={require('./assets/coast.png')}
  fallbackDark={require('./assets/coast-dark.png')}
  appearance="system"
/>
```

Published placements resolve the requested appearance cell when bound, or inherit the placement's Any image. Stateful placements select one complete appearance family; individual states never borrow across appearances. `fallbackDark` is optional on image and dynamic-image components. State images accept an optional `fallbacksDark` map containing every declared state. Dark mode uses that complete bundle when supplied; otherwise it uses the existing `fallback` or `fallbacks`. Bundled accessibility metadata remains app-owned: provide descriptions suitable for the displayed fallback.

Dynamic collection payloads have no appearance cells, so their verified image stays the same while their bundled placeholder can follow appearance. Animations continue using the Any cell. Appearance-scoped cache keys isolate light, dark, and no-preference image requests, including historical cache fallback.

## Tintable icons

Declare `"rendering": "template"` on a catalog placement and regenerate its reference. Assetlib then delivers a single-color shape, and your app supplies the color, for example from its theme or a selected state. `AssetlibImage` and `AssetlibStateImage` pass `tintColor` to Expo Image for both the bundled and the downloaded image, so switching between them keeps the same color.

```tsx
<AssetlibImage
  client={client}
  asset={AppAssets.Tabs.trips}
  fallback={require('./assets/tab-trips.png')}
  tintColor={focused ? colors.ink : colors.muted}
  style={{ width: 24, height: 24 }}
/>
```

- TypeScript requires `tintColor` when `asset` is a generated template reference. At runtime, a template reference without `tintColor` logs one development warning per placement key.
- The bundled fallback must be a single-color shape too, such as a PNG with alpha.
- Without `pixelWidth` and `pixelHeight`, a template reference requests the placement's logical size × `PixelRatio.get()`, rounded up, so small icons stay sharp. Other references keep requesting the logical size.
- If the published artwork's rendering does not match the reference, the component keeps the bundled fallback without downloading (see [tintable icons](../sdk-core/README.md#tintable-icons) in the core guide).

## Arms and app decisions

Declare `"variants": { "arm": ["b", "c"], "appearance": ["dark"] }` on a catalog placement to enable arms alongside appearance. Arms contain 1–4 unique lowercase names matching `^[a-z][a-z0-9_-]{0,19}$`; `control`, `any`, `constructor`, `prototype`, and `__proto__` are reserved. Control remains the placement's existing image.

`AssetlibImage` and `AssetlibStateImage` accept an optional `arm="b"` prop. An explicit arm bypasses the decision callback; `arm="control"` selects control. Changing the prop cancels the previous request and resolves again. Without an explicit arm, the client may ask the app's experiment tool for the assignment:

```tsx
const client = createExpoAssetClient(parsePublicConfig(publicConfig), {
  decide: async ({ key, arms, appearance }) => {
    // Read an assignment from app-owned state; do not record exposure here.
    return assignments[key];
  },
});

<AssetlibImage
  client={client}
  asset={AppAssets.Travel.coast}
  arm="b"
  appearance="dark"
  fallback={require('./assets/coast.png')}
/>
```

The callback receives the placement key, declared arms, and requested appearance. It runs once per resolution, including once for a complete state family, and never for placements without arms. It runs outside the client operation queue with a default deadline of 1,500 ms; configure `decisionTimeoutMs` from 100 to 10,000 ms on the client. Refresh, initialize, and explicit arm requests can proceed while a decision is pending. Afterward, the client revalidates durable state and resolves against the current release. A failed revalidation uses the bundle. An undefined, undeclared, throwing, or timed-out decision falls back to control with `armSource: 'invalid-decision'` and a reason in the status message. With no callback, control is used. If the app's assignment changes, update `arm` or increment `revision` to request it again. **Exposure must be logged by the app's experiment tool when its own visibility rules are met, never by `decide` or `onStatus`.**

Resolution checks `(arm, appearance)`, `(arm, Any)`, `(control, appearance)`, then `(control, Any)`. It never borrows another arm's artwork or mixes state families. Status `arm` identifies the actual selected artwork: inheriting control or displaying a bundled fallback reports `null`, even when the request came from an explicit arm or decision. Image caches isolate both requested arm and appearance, including historical fallback. Dynamic collections and animations do not use arm cells. Bundled fallbacks remain control artwork; there are no per-arm bundled props.

## Accessibility per usage

Choose how each use of an image should behave. Descriptive images can opt into the localized metadata that matches the displayed artwork:

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

`fallbackAccessibility` describes only the bundled image. It defaults to the reference's `bundledAccessibility` when supplied by the checked-in catalog. Remote and cached artwork use their own signed descriptions; after a decode failure or request change, both the image and description return to the corresponding bundle. Description mode keeps the bundle if a remote image has no description. Native `accessibilityLabel` remains an explicit app override, including for legacy releases without metadata. Supply a useful bundled description when choosing description mode.

For decorative artwork, set `accessibilityMode="decorative"`; the image is hidden from accessibility services. If an image is inside a control, label the action on the control and make the artwork decorative. Omitting the mode preserves ordinary Expo accessibility props and does not attach a universal description. Use the app's active locale with `accessibilityLocale`; lookup tries exact locale, parent subtags, then the metadata's explicit default.

`AssetlibDynamicImage` accepts the same props and an explicit `fallbackAccessibility` for its placeholder. `AssetlibStateImage` takes a `fallbackAccessibility` map keyed by state (or the catalog reference's `bundledStateAccessibility`); state selection switches image and description together. In description mode, if any state lacks remote metadata, the entire family stays bundled. The pure `resolveAccessibilityDescription()` helper and `AssetAccessibility` type are exported for custom renderers. These APIs do not generate descriptions or label raw images automatically.

## Artwork states in one component

Use a state set for artwork that belongs to a single placement, such as a plant progressing from sprout to full growth. The application chooses the state from its own business logic; the state names mean nothing to Assetlib. Every declared state needs a bundled fallback. The console publishes the family only when every state has an image at the placement's aspect ratio (pixel sizes may differ), and a release never mixes states from different publications.

```tsx
import { AssetlibStateImage, type StateSetRef } from '@assetlib/sdk-expo';

const garden = {
  key: 'tasks.garden', width: 120, height: 120,
  states: ['empty', 'sprout', 'growing', 'complete'],
} as const satisfies StateSetRef;

<AssetlibStateImage
  client={client}
  asset={garden}
  state={garden.states[completedCount]}
  fallbacks={{
    empty: require('./assets/garden-empty.png'),
    sprout: require('./assets/garden-sprout.png'),
    growing: require('./assets/garden-growing.png'),
    complete: require('./assets/garden-complete.png'),
  }}
  style={{ width: 120, height: 120 }}
/>
```

The component prepares the complete verified family before showing it. Changing only `state` selects from the pinned family without downloading again. A changed client, state-set contract, `revision`, pixel target, cache policy, arm, or effective appearance starts a new resolution. If preparing or displaying a member fails, the entire family uses its matching bundled states until the next resolution. It never substitutes another growth state for a missing one. App code is responsible for supplying a valid declared state.

## Dynamic collections and retention

Use `AssetlibDynamicImage` with an opaque runtime reference issued by this client's verified `loadAssetPage()` result. An arbitrary image URL or hand-built object is not a trusted runtime reference. It resolves on mount and cancels on unmount or reference change; use the application's list virtualization to load only visible or deliberately prefetched items.

```tsx
<AssetlibDynamicImage
  client={client}
  asset={verifiedRuntimeRef}
  fallback={require('./assets/destination-placeholder.png')}
  cachePolicy="none"
  pixelWidth={600}
  pixelHeight={450}
  style={{ width: '100%', aspectRatio: 4 / 3 }}
/>
```

Set `cachePolicy` on the client as a default, or override it on any of the three image components:

| Policy | Verified image retention |
| --- | --- |
| `disk` (default) | Bounded persistent filesystem or IndexedDB cache. |
| `memory` | Bounded cache for the client's lifetime; no persistent artwork reads or writes. |
| `none` | No reusable byte cache; the currently rendered image or pinned state set still needs memory. |

For example, `createExpoAssetClient(config, { cachePolicy: 'memory' })` keeps artwork ephemeral while preserving durable signed release metadata and replay protection. Native `memory`/`none` images use verified raster data URIs rather than image files; web images use ephemeral Blob URLs. Changing policy does not delete artwork saved by an earlier disk-caching request. No automatic reset or purge of app data is performed. Load timing and retention are independent: using `disk` does not download the entire library in advance.

## Storage and networking

Native uses the maintained Expo `File`, `Directory`, and `Paths` APIs for durable verification metadata and optional disk artwork, with private app-document storage and a recoverable state replacement journal. Native delivery uses streaming `expo/fetch`. Web uses transactional IndexedDB for durable metadata and optional cached artwork, browser Fetch, and ephemeral Blob image URLs, released when the component changes or unmounts. No credentials are attached to public delivery requests; the server must allow the web demo origin through CORS.

Caches and durable replay state are isolated by manifest origin, organization, app, and environment. Changing pins or switching between the legacy and environment-scoped production manifest routes preserves that namespace. On first use, an empty namespace checks both previous URL/key formulas (single-key and sorted-key-set), verifies the complete stored history with the current pins, and moves valid state and bounded cached artwork into the new namespace. Invalid legacy state is left untouched. A persisted completion marker prevents re-migration; missing or corrupt current state fails closed. Persistent artwork storage, including cached Lottie JSON and MP4 clips, is bounded to 50 MiB / 100 entries per namespace; the core retains eight signed releases. Cached content is rehashed. When verified artwork cannot be fetched or found in an eligible cache, the component uses its bundled fallback.

For the first upgrade from the old namespace scheme, retain the previous pinned set until migration has completed. Migration recognizes subsets of the current pins, including an expansion during upgrade, but cannot reconstruct an old sorted-set namespace containing a removed, unused pin from its one-way hash. Searches are limited to 4,096 namespace probes; exceeding this limit fails closed with bundled artwork instead of resetting replay protection. After migration, pin changes do not change storage identity; every retained release must still verify with the current pins.

There is no automatic app-data reset API: disconnect the client to show bundled artwork while retaining the cache. Explicitly clearing app/browser data removes stored replay protection. Multiple native clients are serialized within one JavaScript process; cross-process synchronization is outside this preview's contract. Preview 0.2 supports PNG/WebP renditions selected by explicit pixel size. Logical placement dimensions still match the generated catalog. Native caches preserve compatibility with existing `.webp` entries. Web can opt into normalized SVG with `createExpoAssetClient(config, { allowVector: true })`; enabling that option on native throws. On native, `client.resolveAnimation(ref)` resolves verified Lottie JSON and, under the `disk` policy, caches it as `<sha256>.json` beside the cached images (at most 512 KiB per entry, inside the same budget) for a Lottie player that the app supplies. The SDK includes no player, and its image components show the still poster. Native SVG and PDF delivery are not implemented. Browser rendering checks decoded dimensions before handing the image to Expo; native Expo decode errors fall back to the bundled image. See the core README for signature, timeout, body-size, and compatibility limits.

## Short looping video

`AssetlibVideo` shows a placement's poster and plays its signed short looping MP4 clip over it. It ships from a separate entry point so `expo-video` stays an optional peer dependency; importing `@assetlib/sdk-expo` never loads it. On October 11, 2026 it was checked with expo-video 57.0.5 on an iOS 27 Simulator and an Android 16 emulator (0.6.0-preview.1), and in headless Chrome 154 (0.6.2-preview.1). The checks covered playback from the SDK's cache, looping, offline replay and reduced motion. The same day, the 0.6.4-preview.1 change was checked in Safari: headless Playwright WebKit 26.6, desktop Safari 27.0.1 through `safaridriver`, and Mobile Safari 27.0 on an iOS 27 Simulator. In all three the poster hides once playback starts, and in WebKit a rejected `play()` keeps the poster. Offline replay in desktop Safari was last checked on 0.6.2-preview.1, and reduced motion only in WebKit and Mobile Safari. A 10-minute run in desktop Safari 27.0.1 (0.6.4-preview.1) kept one `<video>` with the poster hidden and no memory growth; Safari's `loop` loses about 21 ms at each restart, about 29.84 fps against the clock. It has not been tested on a physical device.

```sh
npx expo install expo-video
```

```tsx
import { AssetlibVideo } from '@assetlib/sdk-expo/video';

<AssetlibVideo
  client={client}
  asset={AppAssets.Cards.gold}
  fallback={require('./assets/gold.png')}
  revision={refreshCounter}
  contentFit="cover"
  style={{ width: '100%', aspectRatio: 4 / 3 }}
/>
```

- **Poster first.** It takes `AssetlibImage`'s props and renders that image as the poster, bundled fallback first. `style` sizes the container; the poster and clip fill it. The poster stays visible until the clip's first frame renders (on web, also once the `<video>` element's `play()` resolves, because Safari never sends expo-video's first-frame event) and returns on any failure.
- **Playback.** `expo-video`'s `useVideoPlayer` with `loop` and `muted` (screen not kept awake), in a `VideoView` with `nativeControls={false}` and the poster's `contentFit` (`none` and `scale-down` become `contain`).
- **When it plays.** Only while `AccessibilityInfo.isReduceMotionEnabled()` reports `false` (it listens to `reduceMotionChanged`; an unknown or failing query counts as reduced), the app is active (`AppState`; `background` and `inactive` stop it), `paused` is not set, and the view holds one of two playback slots shared by every `AssetlibVideo` in the app. Other views show their poster and take a slot when one frees. A view resolves its clip only once it holds a slot. Off-screen detection is up to the app: pass `paused` for views that are not visible.
- **Failures.** A missing clip, a failed check, a player error, or a rejected web `play()` (autoplay blocked, for example in iOS Low Power Mode) shows the poster until the request changes (client, asset, `revision` or `cachePolicy`).
- **iOS and Android.** The native adapter caches verified clips as `<sha256>.mp4` in the namespaced cache directory (at most 4 MiB each, inside the 50 MiB / 100 entry budget) and the core returns the file's `file://` URI. Under the `memory` and `none` policies `resolveVideo` returns the poster without downloading, because the player needs a file.
- **Web.** Verified bytes from IndexedDB, memory or the network become a `video/mp4` Blob URL, revoked when the clip changes or the component unmounts.
- **Cached `file://` clips.** `expo-video` documents `require()` assets and media-library URIs as local sources, not plain `file://` URIs. Its 57.0.5 source passes a string URI through unchanged. On October 11, 2026 it played the SDK's cached `file://` clip on an iOS 27 Simulator and an Android 16 emulator, both right after the download and offline after a relaunch. Physical devices and other expo-video versions are unverified.
- Limits and the signed descriptor are in the core README's [Short looping video](../sdk-core/README.md#short-looping-video) section. `createExpoAssetClient(config, { videoTimeoutMs })` sets the clip deadline.


Telemetry is **off by default**. Enable it explicitly to report which published placement artwork the app resolves and attaches to an image renderer:

```tsx
const client = createExpoAssetClient(publicConfig, {
  telemetry: {
    enabled: true,
    build: { platform: 'ios', appVersion: '1.6.0', buildNumber: '231' },
    flushIntervalMs: 60_000,
    maxBatch: 200,
  },
});
// Optional before a controlled shutdown:
await client.flush();
client.dispose(); // Remove the AppState listener and stop observation timers.
```

The adapter identifies itself as `sdk-expo` version `0.7.5-preview.1`. An explicit `telemetry.sdk` or `telemetry.build` takes precedence. When the runtime can optionally require `expo-application` or `expo-constants`, the adapter reads native app version and build number (falling back to Expo config version/build). Missing packages, unavailable runtime loaders, and throwing native bridges are ignored; no new dependency is required. Supply `build` explicitly for reliable production attribution, especially with bundlers that cannot resolve optional runtime requires or in Expo Go. Without complete runtime metadata or an explicit build, batches use platform `expo` and version/build `unknown`.

Only the observation contract fields are sent: environment, SDK name/version, build platform/version/number, random install ID, send time, and coalesced events with placement key, kind/count, source, asset ID/release sequence when known, effective arm/appearance when selected, and fallback reason. Bundle outcomes send only `fallback` events without asset ID or sequence. Dynamic catalog references do not emit observations because they have no placement key. Image bytes, descriptions, URLs, device identifiers, account identifiers, and status/error messages are not included.

`AssetlibImage`, `AssetlibStateImage`, and `AssetlibDynamicImage` forward renderer load/error signals to the core (the core ignores dynamic references). For eligible placement images, `display` is counted once per mounted component when a remote or cached image's `onLoad` fires, including after a prop or state change if nothing was loaded earlier. **Display means decoded and attached, not seen by a person.** It is not an experiment exposure or a unique viewer. A current verified image's renderer error reports a `decode` fallback and restores bundled artwork; stale renderer events and bundled-image loads/errors do not add observations. App `onLoad` and `onError` callbacks still run. For a state family, display and decode reports identify the selected state's asset, and changing state does not count another display within that mount.

Events are held in bounded memory and coalesced by coordinate. Automatic flush runs while events are queued, on `refresh()`, and when React Native `AppState` reports `background` when available. Each request has a five-second timeout; failed batches remain queued for the next flush. Background execution is best effort and is not a delivery guarantee. `flush()` sends one bounded batch; `dispose()` drops pending events after stopping the reporter, so await a flush first when needed. Observation failures never fail image resolution.

The generated ID is a random 32-character hexadecimal string persisted in dedicated metadata, independent of artwork cache policy. Native Expo uses its secure UUID generator when Web Crypto is unavailable. It is per installation and per delivery origin/organization/app, shared across environments and signing-key rotations. It is never derived from a device identifier. Clearing app/browser data resets it (and also removes release verification state). An app may instead supply an opaque `telemetry.installId` of 8–64 characters; never pass an account, advertising, or hardware identifier.

Enabling telemetry changes the app's data collection behavior. Review Google Play Data safety, Apple App Privacy disclosures, your privacy policy, consent requirements, and any applicable iOS privacy manifest declarations for the app's actual use. These SDK options do not configure or satisfy those declarations automatically. The hosted service stores daily aggregates for 90 days and daily install hashes for 7 days, rather than raw events. See [optional runtime observations](../sdk-core/README.md#optional-runtime-observations) in the core guide for the complete fields, retention, and suggested Data safety wording. Install counts reflect reporting installations, not unique people or all app users.

## Validation

`npm test` exercises component lifecycle behavior with a React test renderer and mocked platform boundaries, including state-family activation, pinned selection, cancellation, fallback, native no-file data URI generation, and `AssetlibVideo`'s reduced-motion, app-state, two-slot and failure handling against a simulated player. `npm run typecheck` checks against Expo 57. Core security and offline tests run in the sibling package. Actual iOS/Android runtime and web delivery checks must be reported separately; these tests and typechecking are not evidence of a native device run.

Expo SDK 54 to 56, October 13, 2026: the source typechecked against the packages each SDK installs (Expo 54.0.0 and 54.0.37, 55.0.31, 56.0.23); only Expo 54 was also run. A new Expo SDK 54 app (React Native 0.81.5, expo-file-system 19.0.24, expo-image 3.0.11, expo-video 3.0.16) installed the packed packages without peer overrides and drew the public demo workspace's published images in a web export in Chrome 152, in a Release build on an iOS 27 Simulator and in a release build on an Android 16 emulator. Both native builds kept the verified cache after a restart, and on Android it restarted offline from that cache and drew the bundled images offline after its data was cleared. A new Expo SDK 57 app ran the same packed code in the same iOS Simulator and Android emulator release builds, including the replacement of an existing state file and cache entry and, on Android, an offline restart from the cache. Not checked: any runtime on Expo 55 or 56, offline runs on iOS, `AssetlibVideo` clip playback on Expo 54 to 56, and physical devices.
