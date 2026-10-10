# @assetlib/cli

Register a checked-in Assetlib catalog with the console from an application build, or adopt bundled Expo images into declared placements. Node.js 22 or newer. The CLI pins `typescript` 5.9.3 for AST parsing and `image-size` 2.0.4 for encoded image dimensions.

## Install

The CLI is not on the npm registry. Install the exact tarball attached to a GitHub release of this repository; release `v0.5.0-preview.1` ships `@assetlib/cli` 0.2.0:

```sh
npm install --save-dev https://github.com/AssetLib/sdk-js/releases/download/v0.5.0-preview.1/assetlib-cli-0.2.0.tgz
node ./node_modules/@assetlib/cli/bin/assetlib.mjs --help
```

Run the installed package's own entry file, as above, and commit the lockfile so `npm ci` checks the tarball's hash. The unscoped `assetlib` name on npm is not ours: never install it or `npx` it by name, because that would fetch whatever package holds the name and run it beside `ASSETLIB_TOKEN`. The `assetlib` commands below assume this entry file (or an npm script that calls it).

Check the tarball against the release's `SHA256SUMS`, and pin it in your lockfile. From a checkout of this repository, after `npm ci`, run it directly:

```sh
node packages/cli/bin/assetlib.mjs --help
```

## Commands

```sh
assetlib sync --catalog assetlib.catalog.json \
  --platform ios --app-version 1.6.0 --build-number 231 \
  --references src --references ios \
  --console https://console.assetlib.dev \
  --org 11111111-1111-4111-8111-111111111111 \
  --app 22222222-2222-4222-8222-222222222222

assetlib hash --catalog assetlib.catalog.json

assetlib check --catalog assetlib.catalog.json --generated src/assets.generated.ts
```

`sync` accepts `--platform ios|android|web|expo`, `--app-version`, `--build-number`, optional `--sdk-version`, repeatable `--references <directory|file>`, and optional `--root <directory>`. Versions and build numbers are 1–64 letters, digits, `.`, `_`, `+`, or `-`. Relative CLI paths resolve from the working directory. Reference paths in the request are relative to the catalog's directory, or to `--root` when supplied; choose a common root containing the catalog and all selected reference paths.

`--dry-run` prints the registration body as JSON without a request and without requiring a token, console, organization, or app. `--json` makes sync stdout a JSON response (or JSON error) only. Partial-scan diagnostics go to stderr, as JSON with `--json`; the payload and response remain unchanged. A partial scan still sends the bounded references unless `--dry-run` is set.

`hash` prints the lowercase SHA-256 of the canonical catalog: recursively sorted object keys by Unicode code point, preserved array order, JSON scalar serialization, no whitespace, UTF-8 bytes. The parsed catalog is validated before hashing; input whitespace and object-key order do not affect the hash.

`check` regenerates the JavaScript SDK's typed `AppAssets` source in memory and compares exact contents, including whitespace and the final newline. It never rewrites the generated file. This phase supports the existing JavaScript/TypeScript generator output (`as const`), not Swift or Kotlin generators. Regenerate with the existing core command:

```sh
assetlib-codegen assetlib.catalog.json > src/assets.generated.ts
```

The CLI copies the existing core codegen and accessibility validation to remain standalone without an SDK runtime dependency. A parity test compares its output to `packages/sdk-core/bin/codegen.mjs`; update the copy when the generator changes. Registration additionally rejects a supplied `defaultState` that is not one of the declared states. Catalog files are limited to 128 KiB and requests to 256 KiB. Optional `variants: { appearance: ['light', 'dark'], arm: ['b', 'c'] }` declarations pass through generation and sync. Either axis can be declared alone. Appearance arrays must be nonempty, unique, and contain only `light` or `dark`. Arm arrays contain 1–4 unique strings matching `^[a-z][a-z0-9_-]{0,19}$`, excluding `control`, `any`, `constructor`, `prototype`, and `__proto__`. The existing default artwork is the implicit `control` arm. Unknown axes are rejected. Optional `rendering` is `original` (the default) or `template` for a tintable icon; any other value is rejected. Generation adds `rendering: 'template'` to the reference only for `template`, so catalogs without the field generate the same bytes as before, and sync registers the field with the rest of the catalog.

## Adopt Expo image call sites

Start with a valid checked-in catalog and review the dry run:

```sh
assetlib adopt --catalog assetlib.catalog.json --src src

assetlib adopt --catalog assetlib.catalog.json --src src --src app \
  --generated src/assets.generated.ts \
  --client-import './src/assetlib/client#client' --min-edge 64 --json

# Only after reviewing the plan:
assetlib adopt --catalog assetlib.catalog.json --src src --apply
```

The default is read-only: it prints candidate, skipped, and collision counts plus a unified diff for **every** planned file, including generated output and a missing client stub. `--json` returns that same plan as JSON (`summary`, `candidates`, `skipped`, `collisions`, `issues`, `files[].diff`, and `notes`). `--apply` validates the whole plan and checks for concurrent file changes before writing it. Exit 0 means at least one call site was adopted or could be adopted; exit 3 means nothing new was found. A second run after applying reports nothing new. Scan limits and unreadable files are reported in `issues`; review them even when candidates were found.

The TypeScript compiler API parses `.tsx`, `.jsx`, `.ts`, and `.js` with JSX enabled. Two patterns are supported, when the JSX tag is the named `Image` import from `react-native` or `expo-image`:

```tsx
import { Image } from 'react-native';
const hero = require('../assets/coast-hero.png');

<Image source={require('../assets/coast-hero.png')} style={styles.hero} />
<Image source={hero} style={styles.hero} />
```

The second pattern requires a module-level `const` with exactly one use in that file. Exported constants are supported and remain exported. Lexical shadowing, shorthand properties, and export references are included in use analysis. Existing `AssetlibImage` fallback expressions are already adopted. Replacements preserve surrounding source formatting using AST positions. Literal Expo `cachePolicy="memory-disk"` becomes `cachePolicy="disk"`; `disk`, `memory`, and `none` retain their values. String literals inside JSX expressions are supported too. Other literals and non-literal expressions are skipped with reason `cache-policy`. Elements with any JSX spread attribute are skipped with reason `spread-attributes`, because the spread may override delivery props. Other attributes are retained:

```tsx
<AssetlibImage client={client} asset={AppAssets.Travel.coastHero}
  fallback={require('../assets/coast-hero.png')} style={styles.hero} />
```

For identifier sources, `fallback={hero}` and the original constant are retained. The original `Image` import is retained even if unused. Imports for `AssetlibImage`, `AppAssets`, and the client are reused where possible or added with collision-safe aliases; directives such as `'use client'` remain first.

`TravelScreen.tsx` and `coast-hero.png` become key `travel.coast-hero`, symbol `['Travel', 'coastHero']`, and screen `travel`. A matching existing key with the same dimensions reuses its existing symbol. Different dimensions are a conflict and are skipped. Distinct images that collide on a key or symbol receive `-2`, `-3`, and corresponding identifier suffixes, reported in the plan; repeat uses of the same image and key share a placement. Invalid names, dimensions outside 1–8192, and additions beyond the catalog's 100-placement limit are skipped. Existing catalog entries are preserved. If every existing placement occupies one line, new placements also occupy one line with the existing indentation and the surrounding file formatting is retained; otherwise the catalog uses expanded JSON with two-space indentation. The CLI generator refreshes the generated file.

`--generated` defaults to `src/assets.generated.ts` relative to the catalog directory. An explicit `--generated`, `--catalog`, or `--src` resolves from the working directory. `--client-import` defaults to `./src/assetlib/client#client`; its relative module path resolves from the catalog directory, then each source receives the appropriate relative import. Use `#default` for a default export, or a valid named binding. A missing local client gets a commented starter module on `--apply`, importing `createExpoAssetClient` and `parsePublicConfig` and reading `assetlib.public.json`. The dry-run diff includes this module. Existing client modules are never overwritten. A bare package import such as `@example/client#client` is accepted and assumes the package already supplies that export; the CLI does not scaffold packages.

Skipped image requires include the following reasons, each with `path:line`:

| Reason | Meaning |
| --- | --- |
| `object-property`, `array-element` | Require or identifier appears in an object or array rather than directly in `source`. |
| `template-string`, `dynamic-path` | The require argument is a template or computed expression. |
| `conditional-expression`, `non-jsx-call`, `unsupported-source` | Conditional, helper-call, or other unsupported source expression. |
| `multiple-uses`, `unused-identifier`, `non-module-const` | The constant pattern cannot be established unambiguously. |
| `image-not-imported`, `shadowed-require`, `attribute-conflict` | The tag or require is locally shadowed/unsupported, or replacement would conflict with existing props. |
| `cache-policy` | The cache policy is not a supported string literal, or is duplicated. |
| `spread-attributes` | A JSX spread could override the rewritten component's delivery props. |
| `icon-sized` | Both encoded edges are below `--min-edge` (default 64; allowed 1–8192). |
| `essential` | Basename contains `icon`, `splash`, `adaptive-icon`, `mark`, `logo`, or `brand` (case-insensitive), or an ancestor directory is named `icons`. |
| `image-missing`, `dimensions-unavailable` | File is absent or its supported image dimensions cannot be read. |
| `catalog-dimension-conflict`, `invalid-catalog-name-or-dimensions`, `placement-limit` | The placement cannot be appended or safely reused under catalog rules. |
| `non-relative-path`, `image-outside-root`, `symlink-or-outside-root` | The image cannot be read inside the supported local scope. |
| `unreadable-or-byte-limit`, `file-changed-during-scan` | A safe bounded read could not complete. |

Scope is intentionally local and bounded: source directories, generated output, local client modules, and image files must stay inside the catalog directory. Symlinks are not followed. Hidden entries, generated sources, and the same dependency/build directories listed under References below are excluded. Limits are 32 directory levels per selected source root, 20,000 entries, 500 source files, 256 KiB per source file, 2 MiB total source bytes, 32 MiB per image, and 128 MiB total image bytes. Overlapping source roots are scanned once. Parse failures and truncated scans appear as scan issues.

Dimensions are the encoded pixel dimensions, not React Native layout dimensions. **Check `@2x` and `@3x` sources** before accepting them as placement canvases. Before committing, review every diff, configure the client with the correct public SDK config, ensure the SDK packages are installed, and run the app's typecheck and visual checks. In particular, review retained platform-specific image props for compatibility with `AssetlibImage`. Adoption never calls Git, commits or stashes, sends a network request, uploads an image, deletes or rewrites image bytes, changes app configuration, removes the original `Image` import or constant, or performs unsupported rewrites.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ASSETLIB_TOKEN` | App API token with `declare` scope. Required only for a real sync. Supply through your shell/CI secret store; there is no token flag. |
| `ASSETLIB_CONSOLE` | Console HTTPS origin: `https://console.assetlib.dev` for the hosted console. See the explicit loopback exception below. |
| `ASSETLIB_ORG` | Organization UUID. |
| `ASSETLIB_APP` | App UUID. |

`--console`, `--org`, and `--app` override environment defaults. The console must use HTTPS and be an origin without a path, credentials, query, or fragment. Local development can use HTTP only for `localhost`, `127.0.0.1`, or `[::1]`, and only when `--allow-insecure-loopback` is explicitly supplied. The flag has no environment-variable equivalent and cannot permit remote HTTP. This validation happens before an authenticated request is constructed. Sync posts to `/api/apps/{org}/{app}/builds` with Bearer authentication and JSON content type, a 30-second timeout, and no followed redirects. Tokens are never printed, including in echoed server errors. There is no session cookie or stored credential file.

VCS/CI metadata is detected in this order:

1. GitHub Actions: `GITHUB_SHA`, `GITHUB_REF_NAME`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_HEAD_REF` (preferred branch), and PR number from `GITHUB_REF=refs/pull/N/merge`.
2. CircleCI: `CIRCLE_SHA1`, `CIRCLE_BRANCH`, `CIRCLE_PROJECT_USERNAME`, `CIRCLE_PROJECT_REPONAME`, `CIRCLE_BUILD_NUM`, and PR number from `CIRCLE_PULL_REQUEST`. A recognized `CIRCLE_REPOSITORY_URL` identifies GitHub or Bitbucket.
3. Local Git: `git rev-parse HEAD` and `git rev-parse --abbrev-ref HEAD`, run from the catalog's directory. Missing Git or repository metadata does not prevent sync.

Detected strings are limited to 200 characters; absent or invalid metadata is omitted. The CI marker variables `GITHUB_ACTIONS` and `CIRCLECI` are also recognized.

## References and data sent

Only the catalog, build identity, VCS/CI metadata, canonical hash, and placement-key/`path:line` references are sent. No source contents or image bytes are uploaded. The token is sent only in the Authorization header. `hash`, `check`, and dry-run do not contact the console.

References are literal hints: a quoted placement key (single, double, or backtick quotes), or a symbol such as `AppAssets.Travel.coast`, `AssetCatalog.Travel.coast`, or `artwork.Travel.coast`. For two-segment symbols, the Swift accessors `artwork.travel.coast` and `artwork.travel.coastArtwork(...)` count too, unless another placement's symbol can produce the same text; ambiguous text is not credited. Computed names and interpolated keys are not resolved. Comments and unrelated matching strings may be counted; absence is not evidence that a placement is unused.

Scanning uses the audit's source extensions (`swift`, `m`, `mm`, `h`, `kt`, `java`, `xml`, `dart`, `js`, `jsx`, `mjs`, `cjs`, `ts`, `tsx`, `json`, `html`, `css`, `scss`) and bounds: 32 directory levels, 20,000 directory entries, 500 source files, 256 KiB per file, and 2 MiB total source bytes. Hidden entries, symlinks, and `node_modules`, `vendor`, `Vendor`, `Pods`, `Carthage`, `build`, `Build`, `dist`, `out`, `coverage`, `DerivedData`, `target`, and `graft` directories are excluded. Names match exactly, so a `Coverage` or `Target` folder is scanned. Generated names matching `*.generated.*` (including `assets.generated.ts` and `Artwork.generated.swift`) and `AppAssets.kt` are excluded.

References are deduplicated and selected in sorted POSIX path order, up to 200 total. Paths must fit 300 characters and remain inside the chosen root. Limits, unreadable files, or files changing during reads produce a partial-scan diagnostic and exit 2. Use a trusted, quiescent checkout as for the local audit.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Completed successfully within the selected scope. |
| `1` | Invalid arguments/catalog, stale generated file, network failure, rejected server response, or HTTP error. HTTP errors include the server message. |
| `2` | Completed with a partial reference scan; inspect stderr for limits or unreadable paths. |
| `3` | `adopt` found no new supported call sites. No files changed. |

A request error takes precedence over the partial-scan exit code. Re-registering the same platform, app version, and build number replaces that build's declarations and references; created, existing, and conflicting placements are summarized. Conflicts are reported without changing the exit code by themselves.

## Verification

Run `npm run verify` from the repository root. Tests include the shared hash vector, core-codegen parity, scanner limits, CI metadata, dry-run, generated-file checks, AST adoption and skip reasons, collision/reuse cases, diff replay, read-only snapshots, apply/idempotence, and real local `node:http` servers for registration and error responses. These HTTP tests require permission to listen on loopback; a sandbox that blocks listening reports failures rather than silently skipping them.
