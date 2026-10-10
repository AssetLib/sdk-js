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

The first run downloads the package and its one dependency from the npm registry. **The audit itself has no network calls, telemetry, account, upload, transforms, deletion, or source rewrites.** Reports go to stdout; the text report escapes control characters in file names. If you choose shell redirection to save a report, use a destination that will not overwrite an existing file.

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

## Change history

Added after 0.1.0 and not yet on npm. Until the next audit release, run it from a clone of this repository:

```sh
node packages/audit/bin/assetlib-audit.mjs /path/to/your-app --assets assets --history
node packages/audit/bin/assetlib-audit.mjs /path/to/your-app --history-days 180 --json
```

`--history` (or `history: true` in the API) answers how often the app's artwork actually changes. It runs local `git log` in the audit root and counts changes on the first-parent line of the checked-out commit: a merge commit counts once with everything it brought in, while a rebased or fast-forwarded pull request counts once per commit. A change counts when it added, modified, or deleted an in-scope image file, including images that no longer exist. In scope means the `--assets` selection and the same hidden and ignored-directory rules as the inventory. History counts more formats than the inventory: PNG, JPEG, WebP, SVG, PDF inside an asset-catalog `.imageset`, and Lottie (`.lottie`, or `.json` under a path that names `lottie`, `animation`, or `anim`). It does not count GIF, HEIC, AVIF, or Android vector drawable XML. The window is `--history-days` long (default 365, at most 3650) and ends at the checked-out commit's date, not today's, so the same checkout gives the same report. Every first-parent commit is checked against the window by its committer date, so a commit with a wrong clock neither hides older changes nor pulls in changes dated after the checked-out commit. In a shallow clone whose history ends inside the window, the cut-off commit itself is not counted, because git cannot tell what it changed. Changes inside a git submodule belong to that submodule's repository and are not counted; a submodule in scope makes history partial, and its images get `history: null`.

Copies of one image count as one image: every file in an asset-catalog set (`.imageset`, `.appiconset`, `.symbolset`, `.dataset` and similar), Android density and night variants under `drawable-*` or `mipmap-*`, `@2x`/`@3x` and `~ipad` suffixes, and Flutter `2.0x`/`3.0x` folders. A logical image is named by its path without those suffixes and without the extension, for example `Assets.xcassets/Hero.imageset` or `app/src/main/res/drawable/bg_welcome`.

Each image is sorted by path conventions into one of three kinds:

- `appIconsLaunchAndStore`: app icon sets (`.appiconset`, Icon Composer `.icon`, Android `mipmap` and `ic_launcher`, alternate app icons), launch and splash screens, favicons, an Expo-style `icon` file, and store screenshots or packaging art.
- `iconsAndLogos`: SF Symbol sets, Android `ic_` resources, images in directories such as `icons`, `tab-icons`, `Symbols.xcassets`, `emoji`, `flags` or `logos`, and names that end in `icon`, contain `icon` or `icons` as a word separated by `-` or `_` (`tab_icon_home`, `icons-cart`, but not `iconHome`), or contain `logo` or `wordmark` anywhere.
- `artwork`: everything else. An icon named for what it shows (`box`, `gear`) lands here, and artwork named with `logo`, `wordmark`, or `icon` as above lands in `iconsAndLogos`. Checked against 1,750 hand-labeled changes in 42 open-source apps, these rules kept 94% of artwork changes in `artwork` and moved 56% of icon and logo changes and 86% of app-icon and launch changes out of it.

The `history` object reports `changesUnderRoot` (changes that touched anything under the audit root), `imageChanges` and `imageOnlyChanges` (no other file under the root changed, except asset-catalog `Contents.json` files), then for each kind: `changes`, `imageOnlyChanges`, `images` (distinct logical images), `fileChanges`, `maxImagesInOneChange` (how large changes were, such as a restyle of a whole set), `monthsWithChanges`, and `changesByMonth`. It also reports `fileChangesByFormat` (`raster`, `vector`, `animation`) and `mostChangedArtwork`, the 20 artwork images changed most often. Each PNG, JPEG, or WebP asset in the inventory gains `history.changes` and `history.lastChanged` for that file. Auditing a subdirectory such as `apps/mobile` counts only changes under it.

This is churn in source control. It does not show what users saw, and it does not say whether a change could have shipped without an app release: a change that also edited code can still be an artwork swap, and an image-only change can still be a cleanup. Work that people wanted but skipped never reaches git.

History reads commit times, changed paths, and the directory and submodule paths at the checked-out commit, never commit messages, authors, hashes or object IDs, or file contents. Git is found through absolute `PATH` entries that are outside the audited checkout and outside any `node_modules` (which `npx` and `npm exec` put on `PATH`), so a `git` binary in the checkout, its dependencies, or the current directory is never run. Paths from git are matched to files on disk the way that checkout's git matches them (`core.ignorecase`, `core.precomposeunicode`), and asset-catalog folders above the audit root still count. Every git call passes `--no-lazy-fetch`, so a partial clone missing trees reports `history_git_log_failed` instead of fetching; a git older than 2.44 does not know that option and gets `history_git_too_old`. Inherited `GIT_*` variables are ignored, the root commit is always included whatever `log.showRoot` says, and signature checks, pagers, external diffs, and fsmonitor are turned off so repository configuration cannot run programs. Defaults: 20,000 changes under the audit root and 64 MiB of git output (ceilings 200,000 and 512 MiB, set with `maxHistoryCommits` and `maxHistoryBytes` in the API). A directory outside a git work tree, a repository without commits, a shallow clone whose first-parent history ends inside the window (a default depth-1 CI checkout, for example; fetch with `--shallow-since` before the window start instead), or a reached limit reports partial coverage with a `history_*` issue and exit status `2`. When history could not be measured at all (`git_unavailable`, `git_too_old` for git older than 2.44, `not_a_git_work_tree`, `no_commits`, `invalid_commit_date` for a commit date JavaScript cannot represent, or a failed or oversized `git log`), its counts and each asset's `history` are `null`, not zero. When the submodule check fails, each asset's `history` is `null`. History needs git 2.44 or later.

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

Tests create synthetic PNG artwork and git repositories with fixed commit dates in temporary directories and remove the fixtures afterwards. They check evidence, duplicates, scoped reference locations, partial coverage, symlinks, deterministic output, history counts and limits, that history ignores inherited git variables, never runs the repository's signature program or a git binary from the current directory, and never fetches in a partial clone, CLI exit codes, and preservation of audited files. The CLI is an early local tool; it is not a hosted Assetlib service or an installable mobile SDK.

## Releasing

Maintainers publish from a clean checkout after `npm run verify` passes:

```sh
npm publish --workspace @assetlib/audit
```

Bump `version` here and the pinned `npx` version in this README, the CLI help text, and the `assetlib-audit` plugin skill together.
