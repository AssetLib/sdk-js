# Security

This is an early preview. Keep the SDK and its pinned dependencies up to date, and review changes to signing-key provisioning, URL boundaries, parsing, caching, or sequence persistence carefully.

Do not publish signing private keys, session cookies, database credentials, private assets, or complete customer configurations in issues. Public keys are not secrets, but app IDs and asset URLs can still reveal private project information.

For a suspected vulnerability, use GitHub private vulnerability reporting if it is enabled on this repository. Otherwise, contact the AssetLib organization maintainers through GitHub to arrange a private report before sharing exploit details. Do not claim a dedicated security inbox exists.

The supported preview version is `0.5.0-preview.1` of `@assetlib/sdk-core` and `@assetlib/sdk-expo`, together with the `@assetlib/cli` tarball attached to that release and the latest `@assetlib/audit` on npm. No formal security audit or response-time guarantee is claimed. Tests validate the documented signatures, hashes, replay checks, URL boundaries, and limits; they do not establish that every runtime is secure. Mobile device compromise and deliberate local-state replacement are outside the current threat model.
