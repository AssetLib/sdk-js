import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The release checklist in AGENTS.md lists version strings that must change
// together. This test fails when a release bump misses one of them.
const text = file => readFile(new URL(`../../../${file}`, import.meta.url), 'utf8');
const json = async file => JSON.parse(await text(file));

test('package versions, the lockfile and the Expo core dependency agree', async () => {
  const { version } = await json('package.json');
  const lock = await json('package-lock.json');
  assert.equal((await json('packages/sdk-core/package.json')).version, version);
  const expo = await json('packages/sdk-expo/package.json');
  assert.equal(expo.version, version);
  assert.equal(expo.dependencies['@assetlib/sdk-core'], version);
  assert.equal(lock.version, version);
  assert.equal(lock.packages['packages/sdk-core'].version, version);
  assert.equal(lock.packages['packages/sdk-expo'].version, version);
  assert.equal(lock.packages['packages/sdk-expo'].dependencies['@assetlib/sdk-core'], version);
  assert.equal(lock.packages['packages/cli'].version, (await json('packages/cli/package.json')).version);
});

test('docs name the current release tag, tarballs and supported version', async () => {
  const { version } = await json('package.json');
  const cli = (await json('packages/cli/package.json')).version;
  const release = `https://github.com/AssetLib/sdk-js/releases/download/v${version}/`;
  const docs = Object.fromEntries(await Promise.all(['README.md', 'packages/cli/README.md', 'packages/sdk-expo/README.md', 'SECURITY.md'].map(async file => [file, await text(file)])));
  for (const tarball of [`assetlib-sdk-core-${version}.tgz`, `assetlib-sdk-expo-${version}.tgz`]) assert.ok(docs['README.md'].includes(release + tarball), `README.md must link ${tarball}`);
  assert.ok(docs['README.md'].includes(`assetlib-cli-${cli}.tgz`), 'README.md must name the CLI tarball');
  assert.ok(docs['packages/cli/README.md'].includes(`${release}assetlib-cli-${cli}.tgz`), 'CLI README must link the CLI tarball');
  assert.ok(docs['packages/sdk-expo/README.md'].includes(`\`sdk-expo\` version \`${version}\``), 'Expo README must state the reported SDK version');
  assert.ok(docs['SECURITY.md'].includes(`\`${version}\``), 'SECURITY.md must name the supported version');
  for (const [file, body] of Object.entries(docs)) {
    for (const [, tag] of body.matchAll(/github\.com\/AssetLib\/sdk-js\/releases\/download\/([^/\s]+)\//g)) assert.equal(tag, `v${version}`, `${file} links release ${tag}`);
  }
});
