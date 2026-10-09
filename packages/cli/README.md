# @assetlib/cli

Register a checked-in Assetlib catalog with the console from an application build. Node.js 22 or newer; no runtime dependencies.

## Install

```sh
npm install --save-dev @assetlib/cli
npx assetlib --help
```

The workspace can also be run directly before publication:

```sh
node packages/cli/bin/assetlib.mjs --help
```

## Commands

```sh
assetlib sync --catalog assetlib.catalog.json \
  --platform ios --app-version 1.6.0 --build-number 231 \
  --references src --references ios \
  --console https://console.example.com \
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

The CLI copies the existing core codegen and accessibility validation to remain standalone without dependencies. A parity test compares its output to `packages/sdk-core/bin/codegen.mjs`; update the copy when the generator changes. Registration additionally rejects a supplied `defaultState` that is not one of the declared states. Catalog files are limited to 128 KiB and requests to 256 KiB.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ASSETLIB_TOKEN` | App API token with `declare` scope. Required only for a real sync. Supply through your shell/CI secret store; there is no token flag. |
| `ASSETLIB_CONSOLE` | Console HTTP(S) origin, such as `https://console.example.com`. |
| `ASSETLIB_ORG` | Organization UUID. |
| `ASSETLIB_APP` | App UUID. |

`--console`, `--org`, and `--app` override environment defaults. The console must be an origin without a path, credentials, query, or fragment. Sync posts to `/api/apps/{org}/{app}/builds` with Bearer authentication and JSON content type, a 30-second timeout, and no followed redirects. Tokens are never printed, including in echoed server errors. There is no session cookie or stored credential file.

VCS/CI metadata is detected in this order:

1. GitHub Actions: `GITHUB_SHA`, `GITHUB_REF_NAME`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_HEAD_REF` (preferred branch), and PR number from `GITHUB_REF=refs/pull/N/merge`.
2. CircleCI: `CIRCLE_SHA1`, `CIRCLE_BRANCH`, `CIRCLE_PROJECT_USERNAME`, `CIRCLE_PROJECT_REPONAME`, `CIRCLE_BUILD_NUM`, and PR number from `CIRCLE_PULL_REQUEST`. A recognized `CIRCLE_REPOSITORY_URL` identifies GitHub or Bitbucket.
3. Local Git: `git rev-parse HEAD` and `git rev-parse --abbrev-ref HEAD`, run from the catalog's directory. Missing Git or repository metadata does not prevent sync.

Detected strings are limited to 200 characters; absent or invalid metadata is omitted. The CI marker variables `GITHUB_ACTIONS` and `CIRCLECI` are also recognized.

## References and data sent

Only the catalog, build identity, VCS/CI metadata, canonical hash, and placement-key/`path:line` references are sent. No source contents or image bytes are uploaded. The token is sent only in the Authorization header. `hash`, `check`, and dry-run do not contact the console.

References are literal hints: a quoted placement key (single, double, or backtick quotes), or a symbol such as `AppAssets.Travel.coast`, `AssetCatalog.Travel.coast`, or `artwork.Travel.coast`. Computed names and interpolated keys are not resolved. Comments and unrelated matching strings may be counted; absence is not evidence that a placement is unused.

Scanning uses the audit's source extensions (`swift`, `m`, `mm`, `h`, `kt`, `java`, `xml`, `dart`, `js`, `jsx`, `mjs`, `cjs`, `ts`, `tsx`, `json`, `html`, `css`, `scss`) and bounds: 32 directory levels, 20,000 directory entries, 500 source files, 256 KiB per file, and 2 MiB total source bytes. Hidden entries, symlinks, and `node_modules`, `vendor`, `Pods`, `Carthage`, `build`, `Build`, `dist`, `out`, `coverage`, `DerivedData`, `target`, and `graft` directories are excluded. Generated names matching `*.generated.*` (including `assets.generated.ts` and `Artwork.generated.swift`) and `AppAssets.kt` are excluded.

References are deduplicated and selected in sorted POSIX path order, up to 200 total. Paths must fit 300 characters and remain inside the chosen root. Limits, unreadable files, or files changing during reads produce a partial-scan diagnostic and exit 2. Use a trusted, quiescent checkout as for the local audit.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Completed successfully within the selected scope. |
| `1` | Invalid arguments/catalog, stale generated file, network failure, rejected server response, or HTTP error. HTTP errors include the server message. |
| `2` | Completed with a partial reference scan; inspect stderr for limits or unreadable paths. |

A request error takes precedence over the partial-scan exit code. Re-registering the same platform, app version, and build number replaces that build's declarations and references; created, existing, and conflicting placements are summarized. Conflicts are reported without changing the exit code by themselves.

## Verification

Run `npm run verify` from the repository root. Tests include the shared hash vector, core-codegen parity, scanner limits, CI metadata, dry-run, generated-file checks, and real local `node:http` servers for registration and error responses. These HTTP tests require permission to listen on loopback; a sandbox that blocks listening reports failures rather than silently skipping them.
