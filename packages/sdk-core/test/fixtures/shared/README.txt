Byte-identical copy of the shared signed contract corpus. AssetLib/sdk-swift
and AssetLib/sdk-android vendor the same files. Every file except this one is
listed in SHA256SUMS. Never edit these files by hand; replace the whole
directory with a regenerated corpus and update the other SDKs at the same time.
test/shared-contract.test.mjs runs every case against @assetlib/sdk-core.
