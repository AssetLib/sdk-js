---
name: assetlib-audit
description: Audit PNG, JPEG, and WebP assets in an existing application with Assetlib's local CLI, explain duplicate and dimension evidence, and propose a small migration that preserves bundled fallbacks. Use for asset inventory or migration assessment; this preview does not install a delivery SDK or publish assets.
---

# Assetlib asset audit

Use the deterministic local audit before drawing conclusions about asset cleanup. Preserve the user's repository and their chosen framework. Do not upload files or assume that an SDK, hosted account, or public npm package exists.

## Locate and run

This skill ships in an Assetlib source checkout. Locate `packages/audit/package.json` relative to the supplied checkout root; when reading this file in its original location, the root is three directories above this skill folder. If the skill was copied separately, obtain the checkout path from task context or ask for it. Do not substitute an unverified registry package.

Read the CLI's `--help` and package README. With Node 22+ and dependencies installed, the supported entry point is:

```sh
node <assetlib-checkout>/packages/audit/bin/assetlib-audit.mjs <app-root> --json
```

Use `--assets` to select known artwork folders when a repository also contains screenshots or documentation media; those files must not silently count as shipped artwork. Use the documented reference-scanning option only for relevant source directories. Dependency installation is separate from offline execution: if needed, use the checkout's lockfile with `npm ci --prefix <sdk-js-checkout>`. Treat installation as code execution under the user's existing authorization, not as a hidden part of reading a report.

Choose bounded limits appropriate to the repository. Inspect report coverage and warnings before interpreting findings. A partial scan supports only conclusions about the scanned subset. Do not print source-file contents, credentials, or full targeting profiles in the report.

## Interpret evidence

- Exact SHA-256 matches establish duplicate file bytes, not interchangeable runtime references or safely reclaimable application-bundle bytes.
- Long-edge thresholds flag dimension candidates. Actual excess size requires the intended rendered dimensions, density, crop, quality, and target build output.
- Literal matches are hints with file/line evidence, not framework-aware reachability or screen discovery. No match is unresolved, never proof of unused content.
- Retain icons needed for navigation, launch, error handling, accessibility, and offline use unless the user has a specific migration reason. App icons, native symbols, font glyphs, asset-catalog variants, nine-patch resources, and adaptive icons need platform-specific handling beyond this CLI.

Return a compact explanation with measured bytes/counts, duplicate groups, dimension candidates, reference coverage, and uncertainties. Separate inventory size from bundle-size savings. Recommend at most a few high-value artwork placements for the first migration and preserve their current resources as fallbacks.

## Migration boundary

This preview only audits. If the user asks to integrate Assetlib, inspect the actual available SDK and its version-matched documentation first. Do not invent imports, package names, API keys, an MCP server, or installation success. If no SDK is present, produce a concrete proposed diff/placement plan and state what remains unimplemented.

When a supported SDK exists, prefer an opt-in change to selected image call sites, generated typed placement references, and a reviewable diff. A future migration must preserve an offline fallback and verify behavior in the actual target runtime. Never make reference cleanup, deletion, publishing, analytics enablement, or a repository-wide rewrite an implicit side effect of an audit.
