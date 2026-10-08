# Assetlib JavaScript SDKs

Signed app artwork delivery with typed placement references and bundled fallbacks. This MIT-licensed preview includes the delivery client, an Expo adapter for iOS/Android/web, and a local asset audit.

Try the hosted developer preview:

- [Assetlib console](https://assetlib-console.vercel.app) — sign in with GitHub and create a workspace with original demo artwork.
- [Travel demo](https://assetlib-travel.vercel.app) — browse the app, then connect your workspace to update its travel images.
- [Todo demo](https://assetlib-todo.vercel.app) — try the same release workflow with a task illustration.

Copy the public SDK configuration from the console into a demo’s **Connect** screen. Publish a compatible image change, then refresh assets in the running demo; try rollback to restore earlier artwork. Published images are public. These links open web demos; native-device validation is separate.

| Package | What works in this preview |
| --- | --- |
| [`@assetlib/sdk-core`](packages/sdk-core) | Pinned Ed25519 manifest verification, SHA-256 image checks, durable sequence tracking, compatible cached fallback, local catalog code generation, signed PNG/WebP size selection |
| [`@assetlib/sdk-expo`](packages/sdk-expo) | Expo 57 component, native file cache, web IndexedDB cache, `expo-image` rendering, browser-only opt-in SVG |
| [`@assetlib/audit`](packages/audit) | Read-only PNG/JPEG/WebP inventory, duplicate evidence, dimension candidates, optional literal-reference hints |

Separate [Swift](https://github.com/AssetLib/sdk-swift) and [Kotlin](https://github.com/AssetLib/sdk-android) previews are available. This release does not include a remote MCP server, marketplace package, or npm registry publication. SDK source and release tarballs are public; the hosted Assetlib console is a separate service.

## Install the preview SDKs

Use both exact tarball URLs from the matching GitHub release. The core package is precompiled; Expo consumes the adapter's Metro-ready source. Installing these packages does not request an Assetlib account or fetch a cloud catalog.

```sh
npm install \
  https://github.com/AssetLib/sdk-js/releases/download/v0.2.0-preview.1/assetlib-sdk-core-0.2.0-preview.1.tgz \
  https://github.com/AssetLib/sdk-js/releases/download/v0.2.0-preview.1/assetlib-sdk-expo-0.2.0-preview.1.tgz
npx expo install expo-file-system expo-image
```

The preview targets Expo 57, React Native 0.86, and React 19. Pin the installed versions in your application's lockfile. Check `SHA256SUMS` attached to the release when reviewing downloaded artifacts.

## Connect one artwork placement

```tsx
import { parsePublicConfig } from '@assetlib/sdk-core';
import { createExpoAssetClient, AssetlibImage } from '@assetlib/sdk-expo';
import { AppAssets } from './assets.generated';

const client = createExpoAssetClient(parsePublicConfig(publicConfig));
await client.initialize();
await client.refresh();

<AssetlibImage
  client={client}
  asset={AppAssets.Travel.coast}
  fallback={require('./assets/coast.png')}
  pixelWidth={600}
  pixelHeight={450}
  contentFit="cover"
  style={{ width: '100%', aspectRatio: 4 / 3 }}
/>
```

Obtain public app configuration from your authenticated Assetlib workspace. It contains organization/app IDs, a manifest URL, and an independently pinned public signing key; it must never contain admin credentials. Keep one client for the configured app. After refreshing, increment the component's `revision` prop to resolve the accepted release.

See the [core guide](packages/sdk-core/README.md) for the checked-in catalog format and offline generator. Application code uses generated references such as `AppAssets.Travel.coast`; compatible artwork updates preserve that reference. Schema v1 still uses placement keys, with exact width/height contracts. Renames and contract changes require a coordinated migration.

## Audit an existing app

Clone this repository, use Node 22+, then install the locked workspace dependencies:

```sh
npm ci
npm run build
node packages/audit/bin/assetlib-audit.mjs /path/to/app --assets assets --references src --json
```

Select actual artwork and source folders. The audit does not upload, transform, or delete files. An unmatched literal reference is unresolved; it is not proof that an image is unused. [Audit scope and limits](packages/audit/README.md) · [Use the local agent skill](agent-kit/INSTALL.md)

## Reliability boundaries

Signatures protect against modified delivery responses only when the app trusts the independently supplied key. Downloaded bytes are checked before display. Corrupt state fails closed. Offline rendering uses compatible verified cache entries, then the bundled image. Cache retention is bounded, and clearing app/browser data removes local replay protection.

The default request deadline is eight seconds, images are limited to eight MiB, and the cache is limited to 50 MiB / 100 files per configuration. Eight signed releases are retained. [Detailed limits](packages/sdk-core/README.md#verification-and-operating-limits)

Source status callbacks describe SDK resolution; they are not analytics impressions. Experiment assignment, analytics routing, automatic source migration, key rotation, and background prefetching are outside this preview. Actual native device and hosted web validation must be reported separately from unit tests and TypeScript checks.

## Develop

```sh
npm ci
npm run verify
npm run pack:release
```

Verification builds the core, runs its signed-delivery tests and the local audit tests, and typechecks the Expo adapter. Packing writes two tarballs and SHA-256 checksums into `release/`; it does not publish to npm or GitHub. See [CONTRIBUTING](CONTRIBUTING.md) and [SECURITY](SECURITY.md).
