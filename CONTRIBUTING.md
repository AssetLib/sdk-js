# Contributing

Use Node.js 22 or later, clone this repository, and run `npm ci` at its root. The root lockfile resolves the local SDK workspaces; the Expo adapter's exact core version is not fetched from the npm registry during workspace development.

Run `npm run verify` before proposing a change. For protocol, persistence, or fallback changes, add a regression test that demonstrates the behavior being protected. Review core and adapter behavior together, including browser storage and actual native behavior when affected.

Keep delivery code free of admin credentials and analytics side effects. Preserve the existing signed schema unless the protocol is explicitly versioned. Do not weaken verification to make a demo pass. Preserve a bundled image when changing example integrations.

The audit is a read-only tool. Do not convert its hints into automatic cleanup, uploads, or source rewrites. Distinguish filesystem bytes from actual application download sizes.

`npm run pack:release` prepares local release artifacts only. Maintainers review, tag, and publish releases separately. Do not publish packages under the Assetlib namespace without maintainer authorization.
