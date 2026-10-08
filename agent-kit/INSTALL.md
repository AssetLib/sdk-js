# Use Assetlib from a coding agent

This repository includes a local audit skill. It is not an installed marketplace plugin or an MCP connection.

Clone the repository, then run `npm ci` from its root. The CLI itself makes no network calls, uploads, or modifications to your app:

```sh
node packages/audit/bin/assetlib-audit.mjs /path/to/app --assets assets --references src --json
```

Replace the asset and source paths with real folders inside your app. Omit either optional selector when appropriate. Read the [audit README](../packages/audit/README.md) before interpreting coverage or reference hints.

Copy this prompt into Codex or Claude Code, replacing the paths:

> Read `<sdk-js-checkout>/agent-kit/skills/assetlib-audit/SKILL.md` and audit `<my-app-repository>`. Explain measured image sizes, exact duplicates, dimension candidates, and reference coverage. Recommend at most three artwork placements for a possible migration, and preserve existing bundled fallbacks. Treat missing references as unresolved. Do not delete or upload assets. If I ask for SDK integration, use the actual versioned SDK and generated references, show the code change, and verify the app's offline behavior.

The skill can also be registered through your agent's supported local-skill mechanism. Keep access to the matching CLI checkout. Do not substitute an unverified `npx` package or claim a marketplace installation exists.
