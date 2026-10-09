# Workstream B implementation report

Implemented the standalone `@assetlib/cli` workspace and `assetlib sync`, `hash`, and `check`, plus the B2 environment support. Changes remain in the working tree. Existing uncommitted SDK changes were preserved. No commits, stashes, discarded changes, runtime dependencies, existing-package version bumps, publication, deployment, or hosted database changes were made.

## 1. Files added and changed; migrations

Added:

- `packages/cli/LICENSE`
- `packages/cli/README.md`
- `packages/cli/bin/assetlib.mjs`
- `packages/cli/package.json`
- `packages/cli/src/accessibility.mjs`
- `packages/cli/src/catalog.mjs`
- `packages/cli/src/cli.mjs`
- `packages/cli/src/codegen.mjs`
- `packages/cli/src/detection.mjs`
- `packages/cli/src/references.mjs`
- `packages/cli/test/catalog.test.mjs`
- `packages/cli/test/cli.test.mjs`
- `packages/cli/test/detection.test.mjs`
- `packages/cli/test/references.test.mjs`
- `packages/sdk-core/test/environment.test.mjs`
- `WORKSTREAM-B-REPORT.md`

Changed for this workstream:

- `package.json`
- `package-lock.json`
- `packages/sdk-core/src/types.ts`
- `packages/sdk-core/src/index.ts`
- `packages/sdk-core/src/delivery.ts`
- `packages/sdk-core/README.md`

`delivery.ts` was already an untracked file when work began; this workstream modifies its catalog URL validation only. Other pre-existing modified/untracked files in `git status` are not part of this implementation. The existing root/core/Expo version `0.3.0-preview.1` was retained. The new CLI package starts at `0.1.0`. No migrations added.

## 2. Verification commands and exact output

Runtime: Node `v24.21.0`, npm `11.19.0` (satisfies Node 22+).

Required command, run from the repository root:

```sh
npm run verify
```

Exit code: **1**. Core: 136 passed; Expo: 14 passed; audit: 9 passed; CLI: 25 passed, 10 failed. Every CLI failure is the sandbox's refusal to bind the required local HTTP test server: `listen EPERM: operation not permitted 127.0.0.1`. No test was skipped. Transport-mock tests covering request/response behavior pass, but they do not establish real socket behavior.

Exact combined stdout/stderr:

```text

> assetlib-sdk-js@0.3.0-preview.1 verify
> npm test && npm run typecheck && npm run verify --workspace @assetlib/cli


> assetlib-sdk-js@0.3.0-preview.1 test
> npm test --workspace @assetlib/sdk-core && npm test --workspace @assetlib/sdk-expo && npm test --workspace @assetlib/audit && npm test --workspace @assetlib/cli


> @assetlib/sdk-core@0.3.0-preview.1 test
> npm run build && node --test test/*.test.mjs


> @assetlib/sdk-core@0.3.0-preview.1 build
> tsc -p tsconfig.json

✔ localized descriptions use case-insensitive exact, parent subtags, then the explicit default (0.534792ms)
✔ metadata validation bounds locales and UTF-16 descriptions and rejects ambiguous defaults (0.356541ms)
✔ signed placement, state, and catalog descriptors reject invalid accessibility metadata (20.634334ms)
✔ metadata stays with selected release, verified cache, retained fallback, and bundled artwork (29.172417ms)
✔ legacy remote images never borrow bundled descriptions (3.156083ms)
✔ each state and each pinned dynamic reference keeps its own metadata (7.80125ms)
✔ offline catalog generation preserves bundled descriptions and validates state ownership (70.912417ms)
✔ vector-v1 accepts bounded static and keyframed shapes without rewriting original bytes (1.361167ms)
✔ animated properties reject renderer-incompatible scalar values, empty timelines and malformed interpolation (1.877125ms)
✔ animated vectors and paths retain renderer-compatible dimensions, vertices and tangents (0.436542ms)
✔ vector-v1 rejects external resources, expressions, unsupported features and malformed transforms (0.464583ms)
✔ vector-v1 enforces byte, timeline, dimensions, nesting and shape complexity limits (5.530125ms)
✔ signed animation extension rejects unknown schema, bad metadata/profile and URL escape (29.319833ms)
✔ catalog selection fetches only assigned bodies, caches repeat access, and unknown keys never become URLs (15.005542ms)
✔ ordinary image resolution uses its mandatory poster without downloading animation (2.806042ms)
✔ verified animation survives offline restart; first-use offline returns a poster outcome (5.274042ms)
✔ tampered animation and signed unsupported profile bytes are never passed to player or cached (10.866125ms)
✔ current corrupted cache is reverified and replaced; offline corruption returns poster (4.020792ms)
✔ failed current animation falls back only to verified historical cache, then legitimate rollback reuses it (14.872417ms)
✔ removing animation or its placement returns poster without resurrecting historical animation (7.819167ms)
✔ animation download bounds, redirects and storage failures return poster outcomes (5.716834ms)
✔ Node-signed Ed25519 fixture verifies against independent pin and rejects tampering/forged self-pins (13.964917ms)
✔ rejects cross-app, unknown schema, duplicate slots, external URLs and unsupported formats (8.84525ms)
✔ HTTPS is mandatory except an explicit loopback development option (0.125917ms)
✔ first render uses bundle; signed update downloads and hashes then survives offline restart (15.950166ms)
✔ rejects byte mismatch and falls back to verified cached previous release (5.491625ms)
✔ replay is rejected across restarts; legitimate rollback uses a new monotonic sequence (6.227042ms)
✔ corrupt stored replay state fails closed and cache contents are rehashed (3.183291ms)
✔ storage failure never advances active release; mismatched placement contracts use bundle (2.62675ms)
✔ bounds streamed bodies without relying on Content-Length and enforces total request deadline (21.6725ms)
✔ offline codegen emits nested typed references and rejects symbol collisions (68.46475ms)
✔ a generic fixed-contract renderer adopts an unseen backend key and later artwork revisions without a checked-in key registry (14.670833ms)
✔ runtime artwork keys cannot supply URLs or bypass the app-owned render dimensions (4.08225ms)
✔ a state family activates completely, pins one release, and falls back as a complete family (33.504959ms)
✔ state schema fails closed for incomplete default, unsafe names, foreign URLs and oversized groups (6.166625ms)
✔ memory skips persistent image storage but preserves durable replay protection (12.687208ms)
✔ none skips persistent image storage but preserves durable replay protection (11.110292ms)
✔ per-request retention overrides do not read or write the disk cache (3.874583ms)
✔ catalog paginates beyond the placement limit, fetching no image bodies until requested (15.934417ms)
✔ catalog rejects mismatched scope, request cursor, sequence, duplicate assets and URL escapes (12.812458ms)
✔ independent image requests run concurrently within a limit and cancelled queued work never starts (6.187417ms)
✔ active cancellation rejects even when a transport ignores abort and never retains bytes (2.708959ms)
✔ public configuration accepts both environment routes and the legacy production route (1.196292ms)
✔ public configuration rejects cross-environment and malformed manifest routes (0.127958ms)
✔ signed manifests and asset pages require the configured environment in both directions (18.868ms)
✔ catalog URLs preserve production compatibility and reject other environments or releases (7.232834ms)
✔ staging refresh and pagination use staging metadata routes with the unchanged asset byte route (13.747667ms)
✔ shared signed contract: manifests/valid-seq1.json (14.658375ms)
✔ shared signed contract: manifests/valid-seq2.json (2.458958ms)
✔ shared signed contract: manifests/valid-rollback-seq3.json (1.770916ms)
✔ shared signed contract: manifests/valid-pretty-seq1.json (1.429875ms)
✔ shared signed contract: manifests/valid-absolute-url.json (1.941542ms)
✔ shared signed contract: manifests/valid-logical-dimensions.json (1.42875ms)
✔ shared signed contract: manifests/valid-screen-utf16-boundary.json (1.581375ms)
✔ shared signed contract: manifests/invalid/bad-signature.json (0.790875ms)
✔ shared signed contract: manifests/invalid/payload-tamper.json (1.406291ms)
✔ shared signed contract: manifests/invalid/pinned-pem-text.json (0.88275ms)
✔ shared signed contract: manifests/invalid/key-id.json (0.475667ms)
✔ shared signed contract: manifests/invalid/algorithm.json (0.436167ms)
✔ shared signed contract: manifests/invalid/base64-signature.json (0.45475ms)
✔ shared signed contract: manifests/invalid/cross-app.json (1.431208ms)
✔ shared signed contract: manifests/invalid/cross-org.json (1.221625ms)
✔ shared signed contract: manifests/invalid/environment.json (1.270667ms)
✔ shared signed contract: manifests/invalid/schema-version.json (1.360083ms)
✔ shared signed contract: manifests/invalid/external-url.json (1.707167ms)
✔ shared signed contract: manifests/invalid/cross-app-url.json (1.475708ms)
✔ shared signed contract: manifests/invalid/asset-id-url.json (1.413541ms)
✔ shared signed contract: manifests/invalid/query-url.json (1.312875ms)
✔ shared signed contract: manifests/invalid/fragment-url.json (1.531166ms)
✔ shared signed contract: manifests/invalid/userinfo-url.json (1.286917ms)
✔ shared signed contract: manifests/invalid/mime.json (1.238875ms)
✔ shared signed contract: manifests/invalid/uppercase-hash.json (1.272708ms)
✔ shared signed contract: manifests/invalid/invalid-key.json (1.336792ms)
✔ shared signed contract: manifests/invalid/duplicate-key.json (1.188208ms)
✔ shared signed contract: manifests/invalid/empty-slots.json (1.465875ms)
✔ shared signed contract: manifests/invalid/too-many-slots.json (2.24575ms)
✔ shared signed contract: manifests/invalid/dimension-zero.json (1.323042ms)
✔ shared signed contract: manifests/invalid/dimension-limit.json (1.291791ms)
✔ shared signed contract: manifests/invalid/screen-utf16-limit.json (1.294833ms)
✔ shared signed contract: manifests/invalid/bytes-zero.json (1.421042ms)
✔ shared signed contract: manifests/invalid/bytes-limit.json (1.287542ms)
✔ shared signed contract: manifests/invalid/sequence-zero.json (1.167459ms)
✔ shared signed contract: manifests/invalid/sequence-fractional.json (1.120792ms)
✔ shared signed contract: manifests/invalid/sequence-boolean.json (1.32825ms)
✔ shared signed contract: manifests/invalid/sequence-limit.json (1.104959ms)
✔ shared signed contract: manifests/invalid/invalid-time.json (1.04525ms)
✔ shared signed contract: manifests/stateful/stale-seq1.json (1.219209ms)
✔ shared signed contract: manifests/stateful/equivocation-seq2.json (1.368958ms)
✔ shared signed contract: manifests/stateful/reformatted-seq2.json (1.115292ms)
✔ shared signed contract: manifests/stateful/unicode-equivalent-seq2.json (1.24425ms)
✔ shared signed contract: manifests/valid-renditions-seq4.json (1.185333ms)
✔ shared signed contract: manifests/valid-rendition-extension-legacy-slot.json (1.258167ms)
✔ shared signed contract: manifests/invalid/rendition-version.json (1.02975ms)
✔ shared signed contract: manifests/invalid/rendition-null-version.json (1.155667ms)
✔ shared signed contract: manifests/invalid/rendition-boolean-version.json (1.246833ms)
✔ shared signed contract: manifests/invalid/rendition-missing-version.json (1.347584ms)
✔ shared signed contract: manifests/invalid/rendition-null-array.json (1.134ms)
✔ shared signed contract: manifests/invalid/rendition-empty-array.json (1.173459ms)
✔ shared signed contract: manifests/invalid/rendition-too-many.json (1.200542ms)
✔ shared signed contract: manifests/invalid/rendition-duplicate-hash.json (1.384667ms)
✔ shared signed contract: manifests/invalid/rendition-external-url.json (1.286875ms)
✔ shared signed contract: manifests/invalid/rendition-wrong-url-hash.json (1.233917ms)
✔ shared signed contract: manifests/invalid/rendition-query.json (1.073ms)
✔ shared signed contract: manifests/invalid/rendition-fragment.json (1.316833ms)
✔ shared signed contract: manifests/invalid/rendition-mime.json (1.078417ms)
✔ shared signed contract: manifests/invalid/rendition-zero-width.json (1.143458ms)
✔ shared signed contract: manifests/invalid/rendition-fractional-width.json (1.190417ms)
✔ shared signed contract: manifests/invalid/rendition-boolean-width.json (1.617833ms)
✔ shared signed contract: manifests/invalid/rendition-huge-dimensions.json (1.1785ms)
✔ shared signed contract: manifests/invalid/rendition-aspect.json (1.115166ms)
✔ shared signed contract: manifests/invalid/rendition-bytes.json (1.244666ms)
✔ shared signed contract: manifests/invalid/rendition-svg-bytes.json (1.575ms)
✔ shared signed contract: manifests/valid-animation-poster-seq5.json (1.253125ms)
✔ shared signed contract: manifests/valid-accessibility-seq6.json (1.339958ms)
✔ shared signed contract: manifests/valid-accessibility-utf16-boundary.json (1.248792ms)
✔ shared signed contract: manifests/invalid/accessibility-null.json (1.416709ms)
✔ shared signed contract: manifests/invalid/accessibility-array.json (1.320584ms)
✔ shared signed contract: manifests/invalid/accessibility-missing-default.json (1.102333ms)
✔ shared signed contract: manifests/invalid/accessibility-missing-descriptions.json (1.21625ms)
✔ shared signed contract: manifests/invalid/accessibility-empty.json (1.279917ms)
✔ shared signed contract: manifests/invalid/accessibility-unknown-default.json (1.153667ms)
✔ shared signed contract: manifests/invalid/accessibility-duplicate-locale.json (1.104167ms)
✔ shared signed contract: manifests/invalid/accessibility-invalid-locale.json (1.086166ms)
✔ shared signed contract: manifests/invalid/accessibility-newline-locale.json (1.320541ms)
✔ shared signed contract: manifests/invalid/accessibility-long-locale.json (1.161209ms)
✔ shared signed contract: manifests/invalid/accessibility-blank.json (0.993541ms)
✔ shared signed contract: manifests/invalid/accessibility-unicode-blank.json (0.93975ms)
✔ shared signed contract: manifests/invalid/accessibility-non-string.json (1.1945ms)
✔ shared signed contract: manifests/invalid/accessibility-utf16-limit.json (1.144083ms)
✔ shared signed contract: manifests/invalid/accessibility-too-many-locales.json (1.113209ms)
✔ selects adequate size, PNG MIME and exact bytes; undersized uses largest rendition (18.056417ms)
✔ browser explicitly opts into SVG; generic client remains raster by default (2.758292ms)
✔ PNG survives independent offline restart and invalid cached/downloaded version falls back (6.691208ms)
✔ target and local decoder capabilities are bounded and explicit (0.360333ms)
✔ legacy schema reader accepts the new signed payload without needing new image support (0.0445ms)
✔ a state without renditions never inherits the default state artwork (29.0815ms)
ℹ tests 136
ℹ suites 0
ℹ pass 136
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 229.424208

> @assetlib/sdk-expo@0.3.0-preview.1 test
> node --test test/*.test.mjs

react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer
✔ native memory and none policies render exact bytes without filesystem access (0.669292ms)
✔ data URI encoding handles padding and chunk boundaries and rejects unsupported payloads (3.992084ms)
✔ factory preserves durable storage while forwarding image retention policy (0.072917ms)
react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer
✔ state changes select a pinned complete family without refetching or mixing fallbacks (6.912292ms)
react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer
✔ state decode failure returns every state to its own bundled fallback until revision changes (1.161209ms)
react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer
✔ incomplete state family releases prepared images and keeps the whole family bundled (0.418833ms)
react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer
✔ dynamic references cancel replaced requests and ignore stale results (0.762875ms)
react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer
✔ legacy placement requests abort on unmount (0.348833ms)
react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer
✔ an image URI completing after unmount is released without publishing stale status (0.386917ms)
react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer
✔ opt-in descriptions follow displayed artwork and return to bundle metadata on decode failure (0.687084ms)
react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer
✔ description mode retains bundled artwork for unlabeled legacy content and permits native app overrides (0.749917ms)
react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer
✔ dynamic request changes immediately pair the new bundle and its description, ignoring stale metadata (0.610417ms)
react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer
✔ state selection and family decode fallback keep each description with its image (0.632416ms)
✔ a state family missing one description stays entirely bundled in description mode (0.438542ms)
ℹ tests 14
ℹ suites 0
ℹ pass 14
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 223.476417

> @assetlib/audit@0.1.0 test
> node --test

✔ measures generated PNG dimensions and exact duplicate evidence without mutating files (6.439209ms)
✔ reference hints expose only locations; absent hints never classify an image as unused (2.46825ms)
✔ skips symlinks, hidden entries, dependencies, and build directories (3.254167ms)
✔ image count and byte limits explicitly report partial coverage (8.31275ms)
✔ entry, depth, source byte, and hint limits remain visible (3.833667ms)
✔ unparseable image content is retained as evidence but reports partial dimensions (0.968ms)
✔ JSON is deterministic and does not disclose the absolute checkout location (1.484333ms)
✔ asset-path selection excludes QA screenshots while retaining app-root source references (2.421833ms)
✔ CLI returns complete/partial/error codes with parseable JSON and no files written (146.813709ms)
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 235.509542

> @assetlib/cli@0.1.0 test
> node --test test/*.test.mjs

✔ shared canonical catalog hash test vector (0.648667ms)
✔ canonicalization sorts numeric and Unicode keys by code point and preserves JSON values/array order (0.523ms)
✔ standalone generation is byte-identical to the existing core codegen (38.286792ms)
✔ catalog validation rejects malformed catalogs, placements, states, symbols and descriptions (11.308833ms)
✔ dry-run emits only the registration contract without credentials or network configuration (46.120875ms)
✔ hash prints the canonical hash, and check matches existing generated output without writing it (109.161875ms)
✖ sync posts the exact body and bearer header, with flags overriding environment defaults (4.552625ms)
✖ sync accepts environment defaults and summarizes existing and conflicting placements (2.436125ms)
✖ HTTP 401 returns exit 1 with the server message and redacts echoed tokens (1.012875ms)
✖ HTTP 400 returns exit 1 with the server message and redacts echoed tokens (0.81575ms)
✖ HTTP 403 returns exit 1 with the server message and redacts echoed tokens (0.748666ms)
✖ HTTP 413 returns exit 1 with the server message and redacts echoed tokens (0.714125ms)
✖ HTTP 429 returns exit 1 with the server message and redacts echoed tokens (0.81275ms)
✖ HTTP 500 returns exit 1 with the server message and redacts echoed tokens (0.793292ms)
✖ sync does not follow redirects (0.830292ms)
✔ invalid flags and build identity fail locally; token is environment-only (263.334583ms)
✔ partial scans return exit 2 and JSON diagnostics separately from the exact payload (49.884084ms)
✖ partial scans still register bounded references and return exit 2 after HTTP success (1.186083ms)
✔ transport mock covers request contract, successful and rejected responses without a listening socket (83.093917ms)
✔ POST uses a 30-second abort signal and never exposes timeout secrets (9.944625ms)
✔ GitHub Actions wins over CircleCI and uses the PR head branch (0.728084ms)
✔ GitHub variables detect CI without the marker and use the regular branch (0.10625ms)
✔ CircleCI identifies the repository, build, and pull request (0.133959ms)
✔ CircleCI supports Bitbucket and omits an unknown VCS provider (0.138708ms)
✔ unusable metadata is omitted rather than truncated or inherited from process.env (0.072459ms)
✔ missing git, a non-repository, and an unavailable catalog directory never fail (16.246458ms)
✔ git fallback reads HEAD and branch from the catalog repository (29.41925ms)
✔ finds literal keys and prefixed symbols while excluding dynamic and generated references (6.609709ms)
✔ uses globally sorted POSIX paths and deduplicates overlapping references (3.911375ms)
✔ skips audit exclusions, unsupported extensions, and symlinks without following them (7.707916ms)
✔ requires a common root and resolves explicit root and reference paths from cwd (1.757083ms)
✔ caps at 200 references in sorted path order and reports actual truncation (2.139334ms)
✔ enforces the audit per-file, total-byte, and source-file budgets (83.610875ms)
✔ reports depth and wire-path limits instead of sending invalid paths (13.415583ms)
✔ stops traversal at the audit 20,000-entry budget (5993.936291ms)
ℹ tests 35
ℹ suites 0
ℹ pass 25
ℹ fail 10
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6158.804667

✖ failing tests:

test at test/cli.test.mjs:85:1
✖ sync posts the exact body and bearer header, with flags overriding environment defaults (4.552625ms)
  Error: listen EPERM: operation not permitted 127.0.0.1
      at Server.setupListenHandle [as _listen2] (node:net:2306:21)
      at listenInCluster (node:net:2437:12)
      at node:net:2666:7
      at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {
    code: 'EPERM',
    errno: -1,
    syscall: 'listen',
    address: '127.0.0.1'
  }

test at test/cli.test.mjs:101:1
✖ sync accepts environment defaults and summarizes existing and conflicting placements (2.436125ms)
  Error: listen EPERM: operation not permitted 127.0.0.1
      at Server.setupListenHandle [as _listen2] (node:net:2306:21)
      at listenInCluster (node:net:2437:12)
      at node:net:2666:7
      at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {
    code: 'EPERM',
    errno: -1,
    syscall: 'listen',
    address: '127.0.0.1'
  }

test at test/cli.test.mjs:109:3
✖ HTTP 401 returns exit 1 with the server message and redacts echoed tokens (1.012875ms)
  Error: listen EPERM: operation not permitted 127.0.0.1
      at Server.setupListenHandle [as _listen2] (node:net:2306:21)
      at listenInCluster (node:net:2437:12)
      at node:net:2666:7
      at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {
    code: 'EPERM',
    errno: -1,
    syscall: 'listen',
    address: '127.0.0.1'
  }

test at test/cli.test.mjs:109:3
✖ HTTP 400 returns exit 1 with the server message and redacts echoed tokens (0.81575ms)
  Error: listen EPERM: operation not permitted 127.0.0.1
      at Server.setupListenHandle [as _listen2] (node:net:2306:21)
      at listenInCluster (node:net:2437:12)
      at node:net:2666:7
      at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {
    code: 'EPERM',
    errno: -1,
    syscall: 'listen',
    address: '127.0.0.1'
  }

test at test/cli.test.mjs:109:3
✖ HTTP 403 returns exit 1 with the server message and redacts echoed tokens (0.748666ms)
  Error: listen EPERM: operation not permitted 127.0.0.1
      at Server.setupListenHandle [as _listen2] (node:net:2306:21)
      at listenInCluster (node:net:2437:12)
      at node:net:2666:7
      at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {
    code: 'EPERM',
    errno: -1,
    syscall: 'listen',
    address: '127.0.0.1'
  }

test at test/cli.test.mjs:109:3
✖ HTTP 413 returns exit 1 with the server message and redacts echoed tokens (0.714125ms)
  Error: listen EPERM: operation not permitted 127.0.0.1
      at Server.setupListenHandle [as _listen2] (node:net:2306:21)
      at listenInCluster (node:net:2437:12)
      at node:net:2666:7
      at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {
    code: 'EPERM',
    errno: -1,
    syscall: 'listen',
    address: '127.0.0.1'
  }

test at test/cli.test.mjs:109:3
✖ HTTP 429 returns exit 1 with the server message and redacts echoed tokens (0.81275ms)
  Error: listen EPERM: operation not permitted 127.0.0.1
      at Server.setupListenHandle [as _listen2] (node:net:2306:21)
      at listenInCluster (node:net:2437:12)
      at node:net:2666:7
      at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {
    code: 'EPERM',
    errno: -1,
    syscall: 'listen',
    address: '127.0.0.1'
  }

test at test/cli.test.mjs:109:3
✖ HTTP 500 returns exit 1 with the server message and redacts echoed tokens (0.793292ms)
  Error: listen EPERM: operation not permitted 127.0.0.1
      at Server.setupListenHandle [as _listen2] (node:net:2306:21)
      at listenInCluster (node:net:2437:12)
      at node:net:2666:7
      at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {
    code: 'EPERM',
    errno: -1,
    syscall: 'listen',
    address: '127.0.0.1'
  }

test at test/cli.test.mjs:117:1
✖ sync does not follow redirects (0.830292ms)
  Error: listen EPERM: operation not permitted 127.0.0.1
      at Server.setupListenHandle [as _listen2] (node:net:2306:21)
      at listenInCluster (node:net:2437:12)
      at node:net:2666:7
      at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {
    code: 'EPERM',
    errno: -1,
    syscall: 'listen',
    address: '127.0.0.1'
  }

test at test/cli.test.mjs:148:1
✖ partial scans still register bounded references and return exit 2 after HTTP success (1.186083ms)
  Error: listen EPERM: operation not permitted 127.0.0.1
      at Server.setupListenHandle [as _listen2] (node:net:2306:21)
      at listenInCluster (node:net:2437:12)
      at node:net:2666:7
      at process.processTicksAndRejections (node:internal/process/task_queues:90:21) {
    code: 'EPERM',
    errno: -1,
    syscall: 'listen',
    address: '127.0.0.1'
  }
npm error Lifecycle script `test` failed with error:
npm error code 1
npm error path <repository root>/packages/cli
npm error workspace @assetlib/cli@0.1.0
npm error location <repository root>/packages/cli
npm error command failed
npm error command sh -c node --test test/*.test.mjs
```

The root verification chain stops at the failing test command, so its later checks were run separately.

```sh
npm run typecheck
```

Exit code: **0**. Exact output:

```text

> assetlib-sdk-js@0.3.0-preview.1 typecheck
> npm run build && npm run typecheck --workspace @assetlib/sdk-expo


> assetlib-sdk-js@0.3.0-preview.1 build
> npm run build --workspace @assetlib/sdk-core


> @assetlib/sdk-core@0.3.0-preview.1 build
> tsc -p tsconfig.json


> @assetlib/sdk-expo@0.3.0-preview.1 typecheck
> tsc --noEmit

```

```sh
npm run verify --workspace @assetlib/cli
```

Exit code: **0**. Exact output:

```text

> @assetlib/cli@0.1.0 verify
> node --check bin/assetlib.mjs && node bin/assetlib.mjs --help

Usage:
  assetlib sync --catalog <path> --platform <ios|android|web|expo> --app-version <v> --build-number <n>
    [--references <dir|file>]... [--root <dir>] [--console <origin>] [--org <uuid>] [--app <uuid>]
    [--sdk-version <v>] [--dry-run] [--json]
  assetlib hash --catalog <path>
  assetlib check --catalog <path> --generated <path>

ASSETLIB_TOKEN supplies the sync token; ASSETLIB_CONSOLE, ASSETLIB_ORG, and ASSETLIB_APP supply defaults.
Exit codes: 0 success, 1 error or generated-file mismatch, 2 partial reference scan.
```

Other checks:

- Initial `npm test --workspace @assetlib/cli`: exit 1, 22 passed / 11 failed, all failures were the same `listen EPERM` restriction. Tests were subsequently separated so non-socket argument and partial-scan checks report independently, and transport-mock coverage was added. The complete final verification output above supersedes that earlier test layout.
- `npm run build --workspace @assetlib/sdk-core && node --test packages/sdk-core/test/environment.test.mjs`: exit 0; 5 passed / 0 failed.
- `node --test packages/cli/test/detection.test.mjs`: exit 0; 7 passed / 0 failed.
- `node --test packages/cli/test/references.test.mjs`: exit 0; 8 passed / 0 failed, including the 20,000-entry cutoff fixture.
- `npm install --package-lock-only --offline --ignore-scripts --no-audit --no-fund --cache <temporary npm cache directory>`: exit 0 (`up to date in 297ms`); registered the workspace in the lockfile with no runtime dependencies.
- `npm pack --workspace @assetlib/cli --dry-run --json --cache <temporary npm cache directory>`: exit 0; 10 package entries, executable binary, all six source modules, README and MIT license; 12,699 packed / 35,327 unpacked bytes. Nothing published.
- `git diff --check`: exit 0, no output.

## 3. Deviations and interpretation

- As explicitly permitted by B1, catalog generation/validation and its accessibility helper were copied from the existing core implementation so the published CLI has no runtime dependencies. `check` uses that generator copy, with byte-for-byte parity tested against the existing core executable. Null/malformed placement input gets a clear error; a supplied `defaultState` is additionally checked against its states for the registration contract. Keep the copy synchronized with future core generator changes.
- B2 includes matching environment-scoped manifest and catalog URL validation, in addition to the requested type/parser changes. The old validation rejected the shared contract's staging URLs; this small extension makes them usable and preserves the legacy production routes and config/payload environment equality.
- `--root` is implemented as required by the reference-scan paragraph, though it is omitted from the spec's compact command synopsis. Partial-scan diagnostics go to stderr (JSON with `--json`) so stdout remains the exact request/response contract. The bounded registration is still attempted and successful partial scans return 2; HTTP/request failure returns 1.
- No other intentional functional deviations. Real HTTP mock-server tests remain enabled and fail explicitly under this sandbox instead of silently being skipped or replaced.

## 4. Unfinished

Implementation is complete. Successful verification of the real HTTP transport remains unconfirmed because this environment denies loopback listening. Run `npm run verify` where local `node:http` servers may listen to complete those ten tests and the full verification chain. No hosted registration, publication, or deployment was attempted or required.
