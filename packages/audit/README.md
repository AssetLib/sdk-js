# Assetlib Audit

A small, read-only command for inventorying an existing app's raster artwork before choosing a migration. It measures evidence; it does not decide what can be deleted or safely served remotely.

Distributed on npm as [`@assetlib/audit`](https://www.npmjs.com/package/@assetlib/audit) under the MIT license. Source lives in [AssetLib/sdk-js](https://github.com/AssetLib/sdk-js/tree/main/packages/audit). The same command powers the `assetlib-audit` plugin for Claude Code and Codex in [AssetLib/agent-plugins](https://github.com/AssetLib/agent-plugins).

## Run

Requires Node.js 22 or later. Pin the exact version so results are reproducible:

```sh
npx -y @assetlib/audit@0.1.0 /path/to/your-app
npx -y @assetlib/audit@0.1.0 /path/to/your-app --references src --json
npx -y @assetlib/audit@0.1.0 /path/to/your-app --assets public --references src
npx -y @assetlib/audit@0.1.0 /path/to/your-app --long-edge 2048 --max-files 500
```

The first run downloads the package and its one dependency from the npm registry. **The audit itself has no network calls, telemetry, account, upload, transforms, deletion, or source rewrites.** Reports go to stdout. If you choose shell redirection to save a report, use a destination that will not overwrite an existing file.

From a clone of this repository instead:

```sh
npm ci
node packages/audit/bin/assetlib-audit.mjs /path/to/your-app --references src --json
node packages/audit/bin/assetlib-audit.mjs packages/audit/examples/sample-app --references src
```

The included synthetic sample has two identical PNGs and one tall PNG.

`--assets` is optional and repeatable: select known artwork files/directories to avoid mixing QA screenshots, documentation images, or unrelated media into the inventory. Source references can still be examined elsewhere inside the same app root. Without `--assets`, the whole root is the image scope.

`--references` is optional and repeatable. Selected asset and source paths must exist inside the audit root, must not contain symlinks, and must not be excluded by the default ignore rules. Use a narrow source directory or individual source file. It scans quoted filename, basename, and relative-path literals in Swift, Objective-C, Kotlin, Java, XML, Dart, JavaScript, TypeScript, JSON, HTML, CSS, and SCSS. Output includes relative source paths and line numbers, never the source lines themselves.

Exit status `0` means the declared scope completed; `2` means coverage is partial and a report was still produced; `1` means invalid input or an unrecoverable failure. A partial result must not be treated as a full inventory. JSON has a versioned shape (`schemaVersion: 1`), sorted paths, no timestamps, and no absolute root path. It can still reveal private filenames and source locations; inspect it before sharing.

## What it establishes

- PNG, JPEG, and WebP files: measured bytes, SHA-256, encoded pixel dimensions, and format where headers can be parsed.
- Exact duplicate groups: identical file contents. `extraCopyBytes` is an observation about copies on disk, not promised app-size savings.
- Dimension candidates: the encoded long edge exceeds a configurable threshold. Without intended display size, density, crop, device support, and format requirements, this is only a review heuristic.
- Optional literal-reference hints: candidate source locations to inspect. No code is executed, and no usage graph or rendering telemetry exists.

**No match does not mean unused.** Generated identifiers, dynamic paths, resource catalogs, Android resource names, Swift asset symbols, density variants, remote configuration, generated files, and older shipped binaries can all preserve a real dependency. Comments and unrelated strings can produce false matches. Different directories with the same basename can match the same literal. This first version is a generic raster audit, not a framework-aware migration tool.

Dimensions are extracted by [`image-size`](https://codeberg.org/image-size/image-size). Header parsing does not prove that the entire image can be decoded. Width and height describe encoded pixels before JPEG EXIF orientation. PDFs, SVG, GIF, HEIC/AVIF, fonts, video, app icons in container formats, and compiled resource archives are outside this version's scope.

## Bounds and exclusions

Defaults: 2,000 images; 20,000 visited directory entries; 32 MiB per image; 128 MiB image bytes; 500 source files; 256 KiB per source file; 2 MiB source bytes; 10 hints per asset; directory depth 32. The CLI exposes image count/byte, entry, and dimension limits; the programmatic API also exposes the source/depth/hint limits. Configuration has hard ceilings to prevent accidental unbounded scans.

Hidden entries, symlinks, non-regular files, and common dependency/build directories are excluded. Ignored directory names match exactly; the list includes both `vendor` and `Vendor`. The full ignore list, thresholds, asset and reference paths, skipped counts, and issues are included in JSON. Exclusions are scope choices and do not mean those files are unused. The scanner does not interpret `.gitignore`; select known artwork paths with `--assets` when a checkout contains unrelated media.

Each directory's names are read and sorted before processing; the entry limit bounds traversal, not the memory needed to list one unusually large directory. Audit a trusted, stable local checkout: symlink checks and `O_NOFOLLOW` reject existing links but are not a security boundary against an adversary replacing parent directories during the scan. File size/mtime changes during a read produce partial coverage. Permission failures and corrupt image headers are reported rather than silently discarded.

## Migration rehearsal

1. Run the inventory against the app, then opt into the relevant source directories.
2. Inspect coverage before interpreting candidates. Verify hinted call sites and asset-catalog/resource references manually.
3. Choose one non-critical artwork placement with a known bundled fallback. Keep launch visuals, navigation icons, accessibility essentials, and offline-critical assets bundled initially.
4. Record the current app behavior and desired delivery contract. A future SDK integration should be a reviewable code change, with offline and failed-download checks.
5. Keep originals. This command does not upload, register placements, generate symbols, integrate an SDK, publish a release, or remove assets.

## Programmatic use and checks

```js
import { auditAssets } from '@assetlib/audit';

const report = await auditAssets('/path/to/app', {
  assets: ['public'],
  references: ['src'],
  longEdge: 2048,
  maxFiles: 500,
});
```

```sh
npm test --workspace @assetlib/audit
```

Tests create synthetic PNG artwork in temporary directories and remove the fixtures afterwards. They check evidence, duplicates, scoped reference locations, partial coverage, symlinks, deterministic output, CLI exit codes, and preservation of audited files. The CLI is an early local tool; it is not a hosted Assetlib service or an installable mobile SDK.

## Releasing

Maintainers publish from a clean checkout after `npm run verify` passes:

```sh
npm publish --workspace @assetlib/audit
```

Bump `version` here and the pinned `npx` version in this README, the CLI help text, and the `assetlib-audit` plugin skill together.
