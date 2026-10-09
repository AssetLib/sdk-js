import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as core from '../dist/index.js';

const fixture = name => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const config = core.parsePublicConfig(JSON.parse(await fixture('config.json')));
const secondKey = await fixture('pinned-keys/keys/TEST_ONLY_second_public.pem');
const state = await fixture('state/after-rollback-seq3.json');

test('durable namespace ignores key rotation and the production manifest route, but isolates identity and environment', () => {
  assert.equal(typeof core.storageNamespace, 'function');
  const namespace = core.storageNamespace(config);
  assert.match(namespace, /^[a-f0-9]{32}$/);
  const origin = new URL(config.manifestUrl).origin;
  const environmentUrl = `${origin}/api/delivery/${config.orgId}/${config.appId}/environments/production/manifest`;
  for (const changed of [
    { ...config, pinnedPublicKeys: [config.pinnedPublicKey, secondKey] },
    { ...config, pinnedPublicKey: secondKey, pinnedPublicKeys: [secondKey] },
    { ...config, manifestUrl: environmentUrl },
  ]) assert.equal(core.storageNamespace(changed), namespace);
  for (const changed of [
    { ...config, environment: 'staging' },
    { ...config, orgId: config.appId },
    { ...config, appId: config.orgId },
    { ...config, manifestUrl: config.manifestUrl.replace(origin, 'https://different.example') },
  ]) assert.notEqual(core.storageNamespace(changed), namespace);
});

test('migration verifier accepts signed retained state using the current pin set and rejects corrupt or foreign state', async () => {
  assert.equal(typeof core.verifyStoredState, 'function');
  assert.deepEqual(core.verifyStoredState(state, { ...config, pinnedPublicKeys: [config.pinnedPublicKey, secondKey] }), JSON.parse(state));
  assert.throws(() => core.verifyStoredState(state, { ...config, pinnedPublicKey: secondKey, pinnedPublicKeys: [secondKey] }), /envelope/);
  assert.throws(() => core.verifyStoredState(state, { ...config, environment: 'staging' }), /cross-app/);
  for (const filename of ['state/corrupt-highest.json', 'state/corrupt-order.json']) {
    const corrupt = await fixture(filename);
    assert.throws(() => core.verifyStoredState(corrupt, config));
  }
  for (const serialized of ['{broken', '{}', JSON.stringify({ version: 1, highestSequence: 0, history: [] }), ' '.repeat(core.SDK_LIMITS.stateBytes + 1)]) {
    assert.throws(() => core.verifyStoredState(serialized, config));
  }
});
