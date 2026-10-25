# @assetlib/cli

Set up an Expo app's integration, register a checked-in Assetlib catalog with the console from an application build, adopt bundled Expo images into declared placements, or map an Expo Router app's routes, navigation and placements. Node.js 22 or newer. The CLI pins `typescript` 5.9.3 for AST parsing and `image-size` 2.0.4 for encoded image dimensions.

## Install

The CLI is on npm as `@assetlib/cli`, a developer preview under the `preview` dist-tag. Install an exact version; release `v0.7.13-preview.1` ships 0.4.9:

```sh
npm install --save-dev --save-exact @assetlib/cli@0.4.9
node ./node_modules/@assetlib/cli/bin/assetlib.mjs --help
```

Run the installed package's own entry file, as above, and commit the lockfile so `npm ci` checks the package's hash. The unscoped `assetlib` name on npm is not ours: never install it or `npx` it by name, because that would fetch whatever package holds the name and run it beside `ASSETLIB_TOKEN`. The `assetlib` commands below assume this entry file (or an npm script that calls it).

The same package is attached to the GitHub release as a tarball: `npm install --save-dev https://github.com/AssetLib/sdk-js/releases/download/v0.7.13-preview.1/assetlib-cli-0.4.9.tgz` installs it from there; check it against the release's `SHA256SUMS`. From a checkout of this repository, after `npm ci`, run it directly:

```sh
node packages/cli/bin/assetlib.mjs --help
```

## Set up an Expo app

`assetlib init` starts an Expo app's integration when it has no catalog yet. Run it from the app's root (or pass `--project <dir>`) with the public SDK configuration downloaded from Settings › Connect in the console:

```sh
node ./node_modules/@assetlib/cli/bin/assetlib.mjs init --config ~/Downloads/assetlib.config.json
# Only after reviewing the plan:
node ./node_modules/@assetlib/cli/bin/assetlib.mjs init --config ~/Downloads/assetlib.config.json --apply
```

- It is a dry run unless `--apply` is passed, and prints every file it would write as a diff. Commit first so the result is easy to review; undo it with Git.
- It adopts bundled images exactly as `adopt` does (the same patterns, skip reasons, limits, `--min-edge`, `--generated` and `--client-import`), but starts without a catalog and creates `assetlib.catalog.json`, the generated references and a starter client. The starter client checks for a new release at launch, before images resolve, and whenever the app returns to the foreground; an image already on screen shows a new release when it mounts again. To redraw it sooner, call `client.refresh()` in your screen and pass the image `revision={result.sequence}`; the starter client's own checks may already have applied the release, so `updated` can be `false`. It accepts an HTTP config for a local console on `localhost`, `127.0.0.1` or `[::1]` only in development builds (`__DEV__`), and replaces its foreground listener when Fast Refresh runs it again. `--src <dir>` (repeatable) defaults to `src`. `--image <file>` (repeatable) limits it to the images you choose. A catalog needs at least one placement, so when nothing can be adopted it writes nothing and exits 3.
- `--config` is checked (schema version 1, `staging` or `production`, UUID `orgId` and `appId`, a `manifestUrl` for that app and environment over HTTPS, or over HTTP on `localhost`, `127.0.0.1` or `[::1]` for a local console, and at least one pinned key) and copied byte for byte to `assetlib.public.json`, which the starter client loads. The SDK checks the keys fully when the app loads the config. The config pins the key your app trusts, so take it only from your own console. An existing identical `assetlib.public.json` is kept; a different one stops `init`. Without `--config`, an existing `assetlib.public.json` is used.
- `--ci github` (the default) writes `.github/workflows/assetlib-sync.yml`. It runs `assetlib sync` from the installed package's entry file on every push to `main`, and only on `main`: a first job compares the ref in the shell, because GitHub compares expressions without regard to case, so a manual run from any other branch (`Main` included) skips the sync job. That job uses the `assetlib-sync` environment. Store `ASSETLIB_TOKEN`, a token with the Declare scope, as a secret of that environment with its deployment branches limited to `main` (GitHub Settings › Environments), not as a repository or organization secret: then no other branch can read it, even with an edited workflow. A private repository on GitHub Free has no environments, so there use a repository secret, which any branch whose workflow is edited to ask for it can read. The token reaches only the sync step: the actions are pinned to commits, checkout keeps no credentials (`persist-credentials: false`), and `npm ci --ignore-scripts` keeps dependency install scripts from running before it. The console origin and IDs come from the public config when it is on HTTPS (otherwise from the `ASSETLIB_CONSOLE`, `ASSETLIB_ORG` and `ASSETLIB_APP` repository variables), the app version from `app.json` (else `package.json`), read inside the sync step into a quoted shell variable and never written to `$GITHUB_OUTPUT`, and the build number from the workflow run. Values reach the script as environment variables, never as `${{ }}` expressions inside it, and every literal is validated and single-quoted; `--src` folders whose names need more than letters, digits, `.`, `_`, `-` and `/` are refused. An existing workflow file is left unchanged. `--ci none` skips it.
- On Expo SDK 57 (an `expo` dependency of `57`, `57.x`, `~57` or `^57`) it also writes `plugins/with-ios-scene-lifecycle.js` and adds it to the plugins in `app.config.json` or, without one, `app.json` (with or without an `expo` key). Apps built with Xcode 27 (the iOS 27 SDK) stop at launch unless they adopt the UIScene life cycle, and the SDK 57 iOS template does not. The plugin applies the SDK 58 template's scene setup (a `SceneDelegate`, a single-scene manifest in `Info.plist`, and an app delegate that no longer creates the window) when Expo generates `ios/`, and does nothing on SDK 58 or later. With a dynamic config (`app.config.ts`, `.mts`, `.cts`, `.mjs`, `.cjs` or `.js`), which Expo reads instead, it only tells you to add the plugin there. It keeps an existing plugin file, leaves a config that already declares `UIApplicationSceneManifest` alone, and rechecks the config file just before writing it. If you keep `ios/` in Git, make the plugin's three changes there yourself. On Expo SDK 54 to 56, whose `expo` package has no `ExpoAppSceneDelegate`, it only notes that Xcode 27 builds need Expo SDK 57 or Xcode 26.
- Like `adopt`, it adds the [section for coding agents](#instructions-for-coding-agents) to `AGENTS.md`. Apart from the adopted call sites, `AGENTS.md` and, on Expo SDK 57, `app.config.json` or `app.json` are the only existing files it may change.
- It refuses to run when `assetlib.catalog.json` already exists (use `adopt`), needs `expo` in `package.json`, never writes through a symlink or outside the project, and, like `adopt`, never calls Git or the network.
- It ends with the next steps: install the SDK packages from the same release, add the token secret, connect your coding agent to the workspace's MCP server, run a development build, and publish a change and reload the app. Overview in the console ticks its setup checklist as the first sync, the first manifest request and the first update arrive.

### Workflows written before CLI 0.4.2

`init` never changes an existing workflow, and it refuses an app that already has a catalog. A workflow written by CLI 0.4.1 or earlier lets a manual run from any branch reach `ASSETLIB_TOKEN`, and writes the app version to `$GITHUB_OUTPUT`, where a version containing a newline can add step outputs. Update it by hand: add the `branch_gate` job, give `sync` the `needs`, `if` and `environment` lines, delete the "Read the app version" step and the `APP_VERSION` entry in the sync step's `env`, read the version at the top of that step's script (`require('./package.json').version` if your version is in `package.json`), and move the token into the `assetlib-sync` environment as described above. Leave the other lines as they are.

```yaml
jobs:
  branch_gate:
    runs-on: ubuntu-latest
    outputs:
      allowed: ${{ steps.check.outputs.allowed }}
    steps:
      - id: check
        run: |
          if [ "$GITHUB_REF" = 'refs/heads/main' ]; then echo 'allowed=true' >> "$GITHUB_OUTPUT"; fi
  sync:
    needs: branch_gate
    if: needs.branch_gate.outputs.allowed == 'true'
    environment: assetlib-sync
    runs-on: ubuntu-latest
    steps:
      # checkout, setup-node and npm ci --ignore-scripts are unchanged
      - name: Register placements
        env:
          # ASSETLIB_TOKEN, ASSETLIB_CONSOLE, ASSETLIB_ORG, ASSETLIB_APP and BUILD_NUMBER are unchanged; APP_VERSION is gone
        run: |
          APP_VERSION="$(node -p "require('./app.json').expo.version")"
          node ./node_modules/@assetlib/cli/bin/assetlib.mjs sync --catalog assetlib.catalog.json --platform expo \
            --app-version "$APP_VERSION" --build-number "$BUILD_NUMBER" --references 'src'
```

### Starter clients written before CLI 0.4.3

`init` and `adopt` never rewrite an existing client module. A starter client written by CLI 0.4.2 or earlier never checks for a release, so the app keeps its bundled images. Add `import { AppState } from 'react-native';` to its imports and these lines after the client is created:

```ts
void client.refresh();
AppState.addEventListener('change', state => { if (state === 'active') void client.refresh(); });
```

For a local console over HTTP, also pass `{ allowInsecureLoopback: __DEV__ }` to `parsePublicConfig` and `createExpoAssetClient`.

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

The TypeScript compiler API parses `.tsx`, `.jsx`, `.ts`, and `.js` with JSX enabled. Two source patterns are supported, when the JSX tag is the `Image` import (aliased or not) from `react-native` or `expo-image`:

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

For identifier sources, `fallback={hero}` and the original constant are retained. The original `Image` import is retained even if unused. Imports for `AssetlibImage`, `AssetlibPlacement`, `AppAssets`, and the client are reused where possible or added with collision-safe aliases; directives such as `'use client'` remain first.

The placement belongs where the artwork is chosen, so the same two source patterns are adopted when the tag is the app's own image component: an import from any other module, a component declared at module scope in the same file, or a member such as `Animated.Image`. The component keeps rendering as it is, with every prop it had, and the call site is wrapped in `AssetlibPlacement` (`@assetlib/sdk-expo` 0.7.12-preview.1 or newer), which hands it the placement's current source:

```tsx
import { AppImage } from '../components/AppImage';

<AppImage source={require('../assets/coast-hero.png')} style={styles.hero} />
```

becomes

```tsx
<AssetlibPlacement client={client} asset={AppAssets.Travel.coastHero} fallback={require('../assets/coast-hero.png')}>{placement => <AppImage source={placement.source} style={styles.hero} />}</AssetlibPlacement>
```

A `key` prop is repeated on `AssetlibPlacement`, so list items stay keyed. The child parameter is `placement`, or `placement2` and so on when the file already uses that name. The component's own `cachePolicy` is left alone. `ImageBackground` from `react-native` or `expo-image` and `Animated.Image` are known to take an image's callbacks, so they also receive `onLoad`, `onError` and `onLayout` from the placement unless the element sets them. The plan notes the other call sites: when the component forwards `onLoad`, `onError` and `onLayout` to its image, also pass `placement.onLoad`, `placement.onError` and `placement.onLayout`, so displays are reported, a failed decode returns to the bundled image, and the image's layout picks the rendition size; see [your own image component](https://github.com/AssetLib/sdk-js/blob/main/packages/sdk-expo/README.md#your-own-image-component) in the Expo README. A tag that is a parameter, a local variable, or an unresolved name is skipped with reason `image-not-imported`.

`TravelScreen.tsx` and `coast-hero.png` become key `travel.coast-hero`, symbol `['Travel', 'coastHero']`, and screen `travel`. A density suffix is not part of the key: `coast-hero.png`, `coast-hero@2x.png` and `coast-hero@3x.png` are one image and one placement. A matching existing key with the same dimensions reuses its existing symbol. Different dimensions are a conflict and are skipped. Distinct images that collide on a key or symbol receive `-2`, `-3`, and corresponding identifier suffixes, reported in the plan; repeat uses of the same image and key share a placement. Invalid names, dimensions outside 1–8192, and additions beyond the catalog's 100-placement limit are skipped. Existing catalog entries are preserved. If every existing placement occupies one line, new placements also occupy one line with the existing indentation and the surrounding file formatting is retained; otherwise the catalog uses expanded JSON with two-space indentation. The CLI generator refreshes the generated file.

`--generated` defaults to `src/assets.generated.ts` relative to the catalog directory. An explicit `--generated`, `--catalog`, or `--src` resolves from the working directory. `--client-import` defaults to `./src/assetlib/client#client`; its relative module path resolves from the catalog directory, then each source receives the appropriate relative import. Use `#default` for a default export, or a valid named binding. A missing local client gets a commented starter module on `--apply` that loads `assetlib.public.json` with `createExpoAssetClient` and checks for a new release at launch and on every return to the foreground, as described under [Set up an Expo app](#set-up-an-expo-app). Inside the module the client is always named `client`, exported under the name you chose. The dry-run diff includes this module. Existing client modules are never overwritten. A bare package import such as `@example/client#client` is accepted and assumes the package already supplies that export; the CLI does not scaffold packages.

Skipped image requires include the following reasons, each with `path:line`:

| Reason | Meaning |
| --- | --- |
| `object-property`, `array-element` | Require or identifier appears in an object or array rather than directly in `source`. |
| `template-string`, `dynamic-path` | The require argument is a template or computed expression. |
| `conditional-expression`, `non-jsx-call`, `unsupported-source` | Conditional, helper-call, or other unsupported source expression. |
| `multiple-uses`, `unused-identifier`, `non-module-const` | The constant pattern cannot be established unambiguously. |
| `image-not-imported`, `shadowed-require`, `attribute-conflict` | The tag is neither `Image` from `react-native` or `expo-image` nor an imported or module-scope component (a parameter, local variable or unresolved name), the require is locally shadowed, or replacement would conflict with existing props. |
| `cache-policy` | The cache policy is not a supported string literal, or is duplicated. |
| `spread-attributes` | A JSX spread could override the rewritten component's delivery props. |
| `icon-sized` | Both edges at 1× (encoded pixels divided by the file's `@<scale>x`) are below `--min-edge` (default 64; allowed 1–8192). |
| `essential` | Basename contains `icon`, `splash`, `adaptive-icon`, `mark`, `logo`, or `brand` (case-insensitive), or an ancestor directory is named `icons`. |
| `image-missing`, `dimensions-unavailable` | File is absent (for `name.png`, so is every `name@<scale>x.png` beside it) or its supported image dimensions cannot be read. |
| `catalog-dimension-conflict`, `invalid-catalog-name-or-dimensions`, `placement-limit` | The placement cannot be appended or safely reused under catalog rules. |
| `non-relative-path`, `image-outside-root`, `symlink-or-outside-root` | The image cannot be read inside the supported local scope. |
| `unreadable-or-byte-limit`, `file-changed-during-scan` | A safe bounded read could not complete. |

Scope is intentionally local and bounded: source directories, generated output, local client modules, and image files must stay inside the catalog directory. Symlinks are not followed. Hidden entries, generated sources, and the same dependency/build directories listed under References below are excluded. Limits are 32 directory levels per selected source root, 20,000 entries, 500 source files, 256 KiB per source file, 2 MiB total source bytes, 32 MiB per image, and 128 MiB total image bytes. Overlapping source roots are scanned once. Parse failures and truncated scans appear as scan issues.

Width and height are a reference size: they fix the aspect ratio every published image must match and identify the placement; the [Expo README](https://github.com/AssetLib/sdk-js/blob/main/packages/sdk-expo/README.md) describes how the SDK sizes its requests. Adopt records them in encoded pixels, not React Native layout dimensions. Metro bundles `name.png` with every `name@<scale>x.png` beside it (and resolves `require('./name.png')` when only scaled files exist), and the device draws the closest scale, so adopt measures the largest file in that set: for `coast-hero.png` with `coast-hero@2x.png` and `coast-hero@3x.png`, the placement is the `@3x` file's width and height, the sharpest art the app bundles. The plan names the measured file when it is not the one in the `require`. Before committing, review every diff, configure the client with the correct public SDK config, ensure the SDK packages are installed, and run the app's typecheck and visual checks. In particular, review retained platform-specific image props for compatibility with `AssetlibImage`. Adoption never calls Git, commits or stashes, sends a network request, uploads an image, deletes or rewrites image bytes, changes app configuration, removes the original `Image` import or constant, or performs unsupported rewrites.

## Map routes, navigation and placements

`assetlib map` draws an Expo Router app as a graph: its routes, the navigation between them, and the catalog's placements on the routes that render them. It reads source only, inside the project, and prints the graph; nothing is sent anywhere.

```sh
assetlib map --catalog assetlib.catalog.json
assetlib map --catalog assetlib.catalog.json --format mermaid > app-flow.mmd
assetlib map --catalog assetlib.catalog.json --app src/app --src src --src packages/ui
```

The app directory is `src/app`, then `app`, under the catalog's directory (or `--root`); `--app <dir>` names another. `--src <dir>` (repeatable) selects the directories scanned for placement references and followed as imports; it defaults to the app directory's parent (`src` for `src/app`, the project root for `app`), and the app directory is always included. `--format json` (the default) prints the report described below; `--format mermaid` prints a `flowchart LR` of layouts, routes, placements and edges, which GitHub, Mermaid Live and most editors render. `--json` makes errors and the partial-scan diagnostic JSON, as for `sync`.

Routes follow Expo Router's file conventions: every `.tsx`, `.ts`, `.jsx` or `.js` file under the app directory is a route, `_layout` files are layouts, `index` is its directory's own route, `(group)` segments are dropped from the path, `[param]` and `[...rest]` are kept as written, platform files (`index.ios.tsx`) collapse onto one route, of which only the unsuffixed file is read, and `+not-found` is a route while `+html`, `+native-intent`, `+api`, `+middleware`, `.d.ts` and generated files are not. A route belongs to the nearest `_layout` above it.

| Source | Edge |
| --- | --- |
| `<Link href>` and `<Redirect href>` from `expo-router` (by name when the file does not import or declare that name itself) | `literal` for a string, a template whose substitutions each fill a whole segment (`/trip/${id}` is written `/trip/[*]`), or an object with a literal `pathname`; `conditional` for each literal branch of `a ? b : c`, `??` or `\|\|`; `dynamic`, with the file and line only, for anything else; a link to another app or site (`https:`, `mailto:`, `//host`) is not an edge |
| `router.push`, `router.replace` and `router.navigate` on a value of `useRouter()`, a destructured method, or `router` (from `expo-router`, or by name when the file does not import or declare it otherwise) | the same |
| `<Stack.Screen name>`, `<Tabs.Screen name>` and `<Drawer.Screen name>` in a layout | `screen`, from the layout to the named file (`index`, `(tabs)` for that group's layout, `trip/[id]`); a name that matches no file is kept with `to: null` |
| a `Tabs` or `Drawer` layout | `navigator` to every route it holds that no `.Screen` names, since the tab bar or drawer shows them all; a `Stack` reaches only its `index`; `Slot` reaches nothing |

An href starting with `.` resolves against the current route as a URL does (`./article` from `/blog/post` is `/blog/article`); a bare name is absolute; a query or fragment is dropped; group segments in an href are ignored. A target goes to the route with the most static segments, so `/trip/new` beats `/trip/[id]`; one that matches no route keeps its target with `to: null`. A route with no incoming edge from another node and no registration is `unlinked`: nothing the scan found leads to it, though a deep link or a typed URL still can. The entry route `/` and `+not-found` are never unlinked.

Placement references use the same matcher as `sync` and are attributed through the code that renders them. A generated symbol (`AppAssets.Travel.coast`) in a route file belongs to that route. In any other file it belongs to the routes that import the function or constant it sits in, directly, through a re-export (`export { default } from '../screens/Travel'`) or as part of a namespace import, following relative imports and the `@/` alias (`compilerOptions.paths` in the root's `tsconfig.json`; without one, `src` beside `src/app`, else the root) through at most 3 files; a file that only lends a route its colors credits it with nothing. A quoted key (`'travel.coast'`) is listed under `mentions` with its file and line and attributes nothing, so a list of key strings on a settings screen is not usage. A symbol no route reaches is `unattributed`, and a placement no route or layout renders counts in `unroutedPlacements`. Names are matched as written, without type information, so a local that shadows an import is followed as the import would be.

The JSON report has `schemaVersion` 1, `app`, `routes` (each with `route`, `file`, `kind` `route` or `layout`, `groups`, `layout`, `entry` and `unlinked` for routes, `navigators` for layouts, and `placements` with `key`, `file`, `line` and the `via` import chain), `edges` (`from`, `to`, `target`, `kind`, `call`, `file`, `line`, `via`), `placements` (`key`, `routes`, `layouts`), `mentions`, `unattributed`, `summary`, `partial` and `issues`. Files are relative to the root with `/` separators. No source text appears in it.

Not handled, and not guessed: hrefs built from variables or partial templates (recorded as `dynamic`), apps on React Navigation without Expo Router, path aliases other than `@/`, the suffixed files of a platform set (`index.ios.tsx` beside `index.tsx`, or `Foo.native.tsx` as an import target), `initialRouteName` and `href: null` settings, and the children a bare `Stack` reaches by name.

The walk and the parse are bounded like the reference scan: the same excluded directories, no symlinks, 32 directory levels, 20,000 entries, 500 files, 256 KiB per file and 2 MiB in total, plus the reference scan's own budget. A budget hit, an unreadable file or an import through a symlink is an issue: the report is still printed, a diagnostic goes to stderr, and the exit code is 2.

## Instructions for coding agents

When `adopt` or `init` adopts something, it also adds or updates one section in `AGENTS.md` beside the catalog, between `<!-- assetlib:start -->` and `<!-- assetlib:end -->`, and creates `AGENTS.md` when it is missing. Coding agents that read the repository then know where the catalog is, render placements with `AssetlibImage` and the generated reference (or through the app's own image component inside `AssetlibPlacement`), and add a placement in the catalog with a bundled fallback instead of in the console. They also render the placement instead of a downloaded copy when they build a screen from Figma, including with Figma's design-to-code skill, and download Figma's image only as the bundled fallback of a key not yet in the catalog: the Assetlib Figma plugin inserts placement art as a component whose description starts with "Assetlib placement" and the key, which Figma's MCP server passes to the agent.

- `CLAUDE.md` gets the same section when it exists and does not import `AGENTS.md` with `@AGENTS.md`. A missing `CLAUDE.md` is not created.
- Text outside the markers is kept. A later run replaces the section where it is, and the dry run shows its diff like any other file.
- A symlinked `AGENTS.md` or `CLAUDE.md` is left unchanged with a note, unless it links to the other one. So is a file with an unmatched or repeated marker, or one over 256 KiB.
- A run that adopts nothing writes nothing, the section included. To add it to an existing integration, paste it and fill in your catalog, generated file and one placement:

```md
<!-- assetlib:start -->
## Artwork that changes after release (Assetlib)

`assetlib adopt` keeps this section up to date; edit outside its markers. Images declared in `assetlib.catalog.json` are Assetlib placements: they can change after the app is released, and the bundled image is the fallback.

- Read `assetlib.catalog.json` before adding or changing artwork.
- Render a placement with `AssetlibImage` from `@assetlib/sdk-expo` and its generated reference, for example `asset={AppAssets.Travel.coastHero}` for `travel.coast-hero`, with the bundled image as `fallback`. When a screen draws artwork through the app's own image component, keep that component and wrap the call site in `AssetlibPlacement`, which hands it `placement.source`. Never point an `Image` at a placement's file instead.
- In Figma, art inserted by the Assetlib plugin is a component whose description starts with "Assetlib placement" and the key, and whose layer name starts with the key. When you build a screen from Figma, including with Figma's design-to-code skill, treat that art as data-supplied imagery whose exact codebase match is the key's generated reference, and render it with that reference. Download the image only when the key isn't in the catalog yet, as its bundled fallback, and use Figma's image as it is rather than redrawing it.
- To add art that should change after release, add a catalog entry and its bundled fallback image in the same change, then regenerate `src/assets.generated.ts` with `assetlib-codegen` (`assetlib adopt` does both for an existing image call site). CI's `assetlib sync` declares it. Never create placements in the Assetlib console.
- Never edit `src/assets.generated.ts` by hand; `assetlib check` compares it. Renaming a key creates a new placement, so ask first.
- Not placements: the app icon, the splash screen, colors, and images that come from user or API data.
- To see what a placement shows in draft, staging and production, where it is used in code, and its release history, use the Assetlib MCP server (add it with `claude mcp add --transport http assetlib https://console.assetlib.dev/mcp`). Through it you may upload images and assign them to placements as a draft.
- Agents never publish, never create placements or tokens in the console, and never put a token in code or chat.
<!-- assetlib:end -->
```

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
| `2` | Completed with a partial scan: `sync`'s reference scan or `map`'s route scan hit a limit or an unreadable path; inspect stderr. |
| `3` | `adopt` found no new supported call sites, or `init` found no image it could adopt. No files changed. |

A placement someone requested in the console with the same key, width, height, states, default state, variants and rendering becomes declared by the build; a different contract is reported as conflicting, and the console keeps its own. A request error takes precedence over the partial-scan exit code. Re-registering the same platform, app version, and build number replaces that build's declarations and references; created, existing, and conflicting placements are summarized. Conflicts are reported without changing the exit code by themselves.

## Verification

Run `npm run verify` from the repository root. Tests include the shared hash vector, core-codegen parity, scanner limits, CI metadata, dry-run, generated-file checks, AST adoption and skip reasons, collision/reuse cases, diff replay, read-only snapshots, apply/idempotence, the map's route naming, edge patterns, attribution and budgets, and real local `node:http` servers for registration and error responses. These HTTP tests require permission to listen on loopback; a sandbox that blocks listening reports failures rather than silently skipping them.
