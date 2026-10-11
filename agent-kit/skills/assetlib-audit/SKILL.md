---
name: assetlib-audit
description: Inventory PNG, JPEG, and WebP artwork in an existing app with Assetlib's read-only local command, explain duplicate and dimension evidence, and propose a small artwork migration that keeps bundled fallbacks. Use when asked to audit, inventory, dedupe, or shrink app images, or to assess moving artwork to remote delivery. Not for deleting files, uploading assets, or installing a delivery SDK.
---

# Assetlib asset audit

Run the deterministic local audit before drawing conclusions about an app's artwork. Preserve the user's repository and framework. The audit reads files and prints a report; it never uploads, transforms, deletes, or rewrites anything.

## Run

Requires Node.js 22 or later. Use the pinned package so results are reproducible:

```sh
npx -y @assetlib/audit@0.2.1 <app-root> --json
```

The first run fetches `@assetlib/audit` and its single dependency from the npm registry. Say so before running if network use matters to the user. The audit itself makes no network calls. If a clone of https://github.com/AssetLib/sdk-js is available, `node <checkout>/packages/audit/bin/assetlib-audit.mjs <app-root> --json` runs the same code without a registry fetch. Do not substitute a different package or an unpinned version.

Read `--help` for the full option list, then choose scope deliberately:

- `--assets <path>`, repeatable, restricts images to known artwork folders so screenshots, documentation media, and test fixtures are not counted as shipped artwork.
- `--references <path>`, repeatable, opts into scanning quoted filename literals in a source directory. Keep it narrow.
- `--history` opts into counting how often in-scope images changed on the checked-out commit's first-parent git history in the 365 days ending at that commit's date, not today (`--history-days` sets the length), split into artwork, icons and logos, and app icons. It needs git 2.44 or later, runs local git only, and reads commit times and paths, never messages or authors. It measures churn in source control, not whether a change could have shipped without an app release.
- `--long-edge`, `--max-files`, `--max-entries`, `--max-file-bytes`, and `--max-bytes` bound the scan.

Exit code 0 means the declared scope completed. Exit code 2 means coverage is partial and the report is valid only for the scanned subset. Exit code 1 means invalid input. Inspect `coverage`, `skipped`, and `issues` in the JSON before interpreting findings. Do not print source-file contents, credentials, or absolute paths from the user's machine in your summary.

## Interpret evidence

- Exact SHA-256 matches establish duplicate file bytes, not interchangeable runtime references or reclaimable application-bundle bytes.
- Long-edge thresholds flag dimension candidates. Actual excess size requires the intended rendered dimensions, density, crop, quality, and target build output.
- Literal matches are hints with file and line evidence, not framework-aware reachability or screen discovery. No match means unresolved, never proof of unused content.
- Keep icons needed for navigation, launch, error handling, accessibility, and offline use bundled unless the user has a specific migration reason. App icons, native symbols, font glyphs, asset-catalog variants, nine-patch resources, and adaptive icons need platform-specific handling beyond this command.

## Report

Return a compact explanation: counts and bytes, duplicate groups, dimension candidates, reference coverage, and uncertainties. Separate on-disk bytes from bundle-size savings. Recommend at most a few high-value artwork placements for a first migration and keep their current files as fallbacks. Recommending no migration is a valid outcome.

## Hand-off to Assetlib

This skill only audits. When the user wants to move the recommended artwork to Assetlib, say where each step lives and act only on what they ask for:

- **Expo and React Native.** The SDK is `@assetlib/sdk-core` with `@assetlib/sdk-expo`, developer previews on npm. Install both at the same exact version, the one the [sdk-js README](https://github.com/AssetLib/sdk-js#install-the-preview-sdks) names. In an Expo app without `assetlib.catalog.json`, `assetlib init` from `@assetlib/cli` adopts chosen bundled images into a catalog and adds a CI sync workflow. It is a dry run unless `--apply`, so show the dry run first. Install the CLI as a dev dependency at an exact version and run its entry file, as its [README](https://github.com/AssetLib/sdk-js/tree/main/packages/cli) shows. Never run `npx assetlib` or install an unscoped `assetlib` package: it is not Assetlib's.
- **SwiftUI and Jetpack Compose.** Follow the READMEs of [AssetLib/sdk-swift](https://github.com/AssetLib/sdk-swift) and [AssetLib/sdk-android](https://github.com/AssetLib/sdk-android) at the exact version each names.
- **The hosted workspace.** The person signs in at https://console.assetlib.dev with GitHub, creates a workspace, copies the public SDK configuration from Settings › Connect, and creates a token with the Declare scope on the Tokens page for CI. They do these steps themselves. Never create an account or a token, and never handle a token's value.

Do not invent imports, package names, versions, API keys, an MCP server, or installation success: read the SDK's version-matched documentation before changing code. When an SDK is installed, prefer an opt-in change to selected image call sites, generated typed placement references, and a reviewable diff. A migration keeps each current image as its bundled fallback and must be verified in the actual target runtime. Never make cleanup, deletion, publishing, analytics enablement, or a repository-wide rewrite an implicit side effect of an audit.
