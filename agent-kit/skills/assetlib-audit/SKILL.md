---
name: assetlib-audit
description: Inventory PNG, JPEG, and WebP artwork in an existing app with Assetlib's read-only local command, explain duplicate and dimension evidence, and propose a small artwork migration that keeps bundled fallbacks. Use when asked to audit, inventory, dedupe, or shrink app images, or to assess moving artwork to remote delivery. Not for deleting files, uploading assets, or installing a delivery SDK.
---

# Assetlib asset audit

Run the deterministic local audit before drawing conclusions about an app's artwork. Preserve the user's repository and framework. The audit reads files and prints a report; it never uploads, transforms, deletes, or rewrites anything.

## Run

Requires Node.js 22 or later. Use the pinned package so results are reproducible:

```sh
npx -y @assetlib/audit@0.1.0 <app-root> --json
```

The first run fetches `@assetlib/audit` and its single dependency from the npm registry. Say so before running if network use matters to the user. The audit itself makes no network calls. If a clone of https://github.com/AssetLib/sdk-js is available, `node <checkout>/packages/audit/bin/assetlib-audit.mjs <app-root> --json` runs the same code without a registry fetch. Do not substitute a different package or an unpinned version.

Read `--help` for the full option list, then choose scope deliberately:

- `--assets <path>`, repeatable, restricts images to known artwork folders so screenshots, documentation media, and test fixtures are not counted as shipped artwork.
- `--references <path>`, repeatable, opts into scanning quoted filename literals in a source directory. Keep it narrow.
- `--long-edge`, `--max-files`, `--max-entries`, `--max-file-bytes`, and `--max-bytes` bound the scan.

Exit code 0 means the declared scope completed. Exit code 2 means coverage is partial and the report is valid only for the scanned subset. Exit code 1 means invalid input. Inspect `coverage`, `skipped`, and `issues` in the JSON before interpreting findings. Do not print source-file contents, credentials, or absolute paths from the user's machine in your summary.

## Interpret evidence

- Exact SHA-256 matches establish duplicate file bytes, not interchangeable runtime references or reclaimable application-bundle bytes.
- Long-edge thresholds flag dimension candidates. Actual excess size requires the intended rendered dimensions, density, crop, quality, and target build output.
- Literal matches are hints with file and line evidence, not framework-aware reachability or screen discovery. No match means unresolved, never proof of unused content.
- Keep icons needed for navigation, launch, error handling, accessibility, and offline use bundled unless the user has a specific migration reason. App icons, native symbols, font glyphs, asset-catalog variants, nine-patch resources, and adaptive icons need platform-specific handling beyond this command.

## Report

Return a compact explanation: counts and bytes, duplicate groups, dimension candidates, reference coverage, and uncertainties. Separate on-disk bytes from bundle-size savings. Recommend at most a few high-value artwork placements for a first migration and keep their current files as fallbacks. Recommending no migration is a valid outcome.

## Boundaries

This skill only audits. If the user asks to integrate Assetlib delivery, inspect the actual SDK available in their project and its version-matched documentation first. Do not invent imports, package names, API keys, an MCP server, or installation success. If no SDK is present, produce a concrete proposed placement plan and state what remains unimplemented.

When a supported SDK exists, prefer an opt-in change to selected image call sites, generated typed placement references, and a reviewable diff. A migration must preserve an offline fallback and be verified in the actual target runtime. Never make cleanup, deletion, publishing, analytics enablement, or a repository-wide rewrite an implicit side effect of an audit.
