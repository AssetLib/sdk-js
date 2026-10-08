# Use Assetlib from a coding agent

The audit skill ships as the `assetlib-audit` plugin in [AssetLib/agent-plugins](https://github.com/AssetLib/agent-plugins). It wraps the published `@assetlib/audit` command and is the supported way to install it:

```sh
claude plugin marketplace add AssetLib/agent-plugins
claude plugin install assetlib-audit@assetlib
```

```sh
codex plugin marketplace add AssetLib/agent-plugins
```

This folder keeps a copy of the same skill for use directly from a checkout of this repository, for example while changing the audit itself. Point your agent at `agent-kit/skills/assetlib-audit/SKILL.md`, or paste this prompt with real paths:

> Read `<sdk-js-checkout>/agent-kit/skills/assetlib-audit/SKILL.md` and audit `<my-app-repository>`. Explain measured image sizes, exact duplicates, dimension candidates, and reference coverage. Recommend at most three artwork placements for a possible migration, and preserve existing bundled fallbacks. Treat missing references as unresolved. Do not delete or upload assets.

The skill runs `npx -y @assetlib/audit@0.1.0`. To run the checkout's own code instead, use `node packages/audit/bin/assetlib-audit.mjs <app-root> --json` after `npm ci`. Neither path connects to a hosted workspace, publishes releases, or installs a delivery SDK.
