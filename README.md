# Assetlib JavaScript SDKs

Signed app artwork delivery with typed placement references and bundled fallbacks. This MIT-licensed preview includes the delivery client, an Expo adapter for iOS/Android/web, and a local asset audit.

Try the hosted developer preview:

- [Assetlib console](https://console.assetlib.dev) — sign in with GitHub and create a workspace with original demo artwork.
- [Travel demo](https://assetlib-travel.vercel.app) — browse the app, then connect your workspace to update its travel images.
- [Todo demo](https://assetlib-todo.vercel.app) — try the same release workflow with a task illustration.

Copy the public SDK configuration from the console into a demo’s **Connect** screen. Publish a compatible image change, then refresh assets in the running demo; try rollback to restore earlier artwork. Published images are public. These links open web demos; native-device validation is separate.

| Package | What works in this preview |
| --- | --- |
| [`@assetlib/sdk-core`](packages/sdk-core) | Pinned Ed25519 manifest verification, SHA-256 image checks, durable sequence tracking, compatible cached fallback, local catalog code generation, signed PNG/WebP size selection, localized image descriptions |
| [`@assetlib/sdk-expo`](packages/sdk-expo) | Expo 57 component, native file cache, web IndexedDB cache, `expo-image` rendering, browser-only opt-in SVG, per-usage accessibility modes |
| [`@assetlib/cli`](packages/cli) | `assetlib sync` build and catalog registration, `hash`, `check` for generated references, and the dry-run-first `adopt` codemod |
| [`@assetlib/audit`](packages/audit) | Read-only PNG/JPEG/WebP inventory, duplicate evidence, dimension candidates, optional literal-reference hints |

Separate [Swift](https://github.com/AssetLib/sdk-swift) and [Kotlin](https://github.com/AssetLib/sdk-android) previews are available. The SDK and CLI packages are not on the npm registry; install them from the tarballs attached to a GitHub release. Only the read-only audit is published to npm, and its agent plugin lives in [AssetLib/agent-plugins](https://github.com/AssetLib/agent-plugins). This repository does not include a remote MCP server. SDK source and release tarballs are public; the hosted Assetlib console is a separate service.

## Install the preview SDKs

Use both exact tarball URLs from the matching GitHub release. The core package is precompiled; Expo consumes the adapter's Metro-ready source. Installing these packages does not request an Assetlib account or fetch a cloud catalog.

```sh
npm install \
  https://github.com/AssetLib/sdk-js/releases/download/v0.4.1-preview.1/assetlib-sdk-core-0.4.1-preview.1.tgz \
  https://github.com/AssetLib/sdk-js/releases/download/v0.4.1-preview.1/assetlib-sdk-expo-0.4.1-preview.1.tgz
npx expo install expo-file-system expo-image
```

The preview targets Expo 57, React Native 0.86, and React 19. Pin the installed versions in your application's lockfile. Check `SHA256SUMS` attached to the release when reviewing downloaded artifacts. The same release attaches the `assetlib` CLI as `assetlib-cli-0.1.1.tgz`; see the [CLI install steps](packages/cli/README.md#install).

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
  accessibilityMode="decorative"
  pixelWidth={600}
  pixelHeight={450}
  contentFit="cover"
  style={{ width: '100%', aspectRatio: 4 / 3 }}
/>
```

Obtain public app configuration from your authenticated Assetlib workspace. It contains organization/app IDs, a manifest URL, and an independently pinned public signing key; it must never contain admin credentials. Keep one client for the configured app. After refreshing, increment the component's `revision` prop to resolve the accepted release.

See the [core guide](packages/sdk-core/README.md) for the checked-in catalog format and offline generator. Application code uses generated references such as `AppAssets.Travel.coast`; compatible artwork updates preserve that reference. Schema v1 still uses placement keys, with exact width/height contracts. Renames and contract changes require a coordinated migration.

Since 0.4.0-preview.1 the SDKs resolve appearance and arm variants, with an optional app-supplied `decide` callback and `arm` props on Expo placement/state components, and accept staging configurations and pinned signing key sets. See the [resolution and decision contract](packages/sdk-core/README.md#appearance-and-arm-variants). The [CLI](packages/cli/README.md) preserves these declarations during code generation and sync; `adopt` preserves compact catalog placement lines and skips essential icon, splash, mark, logo, and brand images.

## Audit an existing app

The read-only audit is on npm as [`@assetlib/audit`](https://www.npmjs.com/package/@assetlib/audit). With Node 22+:

```sh
npx -y @assetlib/audit@0.1.0 /path/to/app --assets assets --references src --json
```

Or from this checkout after `npm ci`:

```sh
node packages/audit/bin/assetlib-audit.mjs /path/to/app --assets assets --references src --json
```

Select actual artwork and source folders. The audit does not upload, transform, or delete files. An unmatched literal reference is unresolved; it is not proof that an image is unused. [Audit scope and limits](packages/audit/README.md) · [Agent plugin and local skill](agent-kit/INSTALL.md)

## Reliability boundaries

Signatures protect against modified delivery responses only when the app trusts the independently supplied key. Downloaded bytes are checked before display. Corrupt state fails closed. Offline rendering uses compatible verified cache entries, then the bundled image. Cache retention is bounded, and clearing app/browser data removes local replay protection.

The default request deadline is eight seconds, images are limited to eight MiB, and the cache is limited to 50 MiB / 100 files per configuration. Eight signed releases are retained. [Detailed limits](packages/sdk-core/README.md#verification-and-operating-limits)

Source status callbacks describe SDK resolution; they are not analytics impressions. The app's experiment tool owns assignment and must log exposure after rendering, never from `decide`. Analytics routing, key rotation, and background prefetching are outside this preview. Actual native device and hosted web validation must be reported separately from unit tests and TypeScript checks.

## Develop

```sh
npm ci
npm run verify
npm run pack:release
```

Verification builds the core, runs the core, Expo, audit, and CLI tests, typechecks the Expo adapter, and checks the CLI entry point. Packing writes four tarballs (core, Expo, audit, and CLI) and their SHA-256 checksums into `release/`; it does not publish to npm or GitHub. GitHub releases attach the core, Expo, and CLI tarballs; the audit is published to npm. See [CONTRIBUTING](CONTRIBUTING.md) and [SECURITY](SECURITY.md).
