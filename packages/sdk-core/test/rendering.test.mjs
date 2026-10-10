// JavaScript-only tintable icon checks over the shared corpus: state members,
// retained releases and cached bytes. The shared cases are in shared-contract.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AssetClient, createMemoryStorage, parsePublicConfig, verifySignedAssetPage, verifySignedManifest } from '../dist/index.js';

const root = new URL('./fixtures/shared/', import.meta.url);
const bytes = file => readFile(new URL(file, root));
const json = async file => JSON.parse(await bytes(file));
const config = parsePublicConfig(await json('config.json'));
const assets = await json('assets.json');
const coast = await bytes(assets.coast.file), ridge = await bytes(assets.ridge.file);
const seed = (await bytes('keys/TEST_ONLY_seed.hex')).toString().trim();
const privateKey = createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${seed}`, 'hex'), format: 'der', type: 'pkcs8' });
const signed = value => {
  const payload = JSON.stringify(value);
  return { algorithm: 'Ed25519', keyId: config.keyId, publicKey: config.pinnedPublicKey, payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') };
};
const template = await json('manifests/valid-rendering-template-seq9.json');
const states = await json('manifests/valid-rendering-template-states-seq10.json');
const mismatch = await json('manifests/valid-rendering-cell-mismatch-seq10.json');
const icon = { key: 'icons.coast', width: 40, height: 30 };
const templateIcon = { ...icon, rendering: 'template' };

function harness(manifest, initialAssets = []) {
  const storage = createMemoryStorage();
  let active = manifest;
  const requests = [];
  const ready = Promise.all(initialAssets.map(([key, body]) => storage.putAsset(key, body)));
  const fetch = async url => {
    await ready;
    requests.push(url);
    if (url === config.manifestUrl) return new Response(JSON.stringify(active));
    const body = url.endsWith(assets.coast.assetId) ? coast : url.endsWith(assets.ridge.assetId) ? ridge : null;
    return body ? new Response(body) : new Response(null, { status: 404 });
  };
  return { client: new AssetClient(config, { storage, fetch }), requests, setManifest(value) { active = value; } };
}

test('state members carry their own rendering and validate', () => {
  const { payload } = verifySignedManifest(states, config);
  const slot = payload.slots.find(value => value.key === icon.key);
  assert.deepEqual(Object.values(slot.states).map(value => value.rendering), ['template', 'template']);
  for (const value of [null, 1, '', 'Template', 'template ', `t${'x'.repeat(32)}`]) {
    const malformed = JSON.parse(states.payload);
    malformed.slots[1].states.active.rendering = value;
    assert.throws(() => verifySignedManifest(signed(malformed), config), /rendering/, JSON.stringify(value));
  }
  const unknown = JSON.parse(states.payload);
  unknown.slots[1].states.active.rendering = 'palette';
  assert.doesNotThrow(() => verifySignedManifest(signed(unknown), config), 'A well-formed unknown value is not a manifest error.');
});

test('a template state set resolves as a whole; a mismatch or unknown member keeps the bundled family without downloads', async () => {
  const ref = { ...templateIcon, states: ['idle', 'active'] };
  const h = harness(states);
  await h.client.refresh();
  const family = await h.client.resolveStateSet(ref);
  assert.equal(family.source, 'remote');
  assert.equal(family.states.idle.rendering, 'template');
  assert.equal(family.states.active.rendering, 'template');
  assert.equal(family.states.idle.assetId, assets.coast.assetId);
  assert.equal(family.states.active.assetId, assets.ridge.assetId);

  const original = harness(states);
  await original.client.refresh();
  const bundled = await original.client.resolveStateSet({ ...icon, states: ['idle', 'active'] });
  assert.equal(bundled.source, 'bundle');
  assert.equal(bundled.fallbackReason, 'missing');
  assert.deepEqual(original.requests, [config.manifestUrl]);

  const unknown = JSON.parse(states.payload);
  unknown.slots[1].states.active.rendering = 'palette';
  const partial = harness(signed(unknown));
  await partial.client.refresh();
  assert.equal((await partial.client.resolveStateSet(ref)).source, 'bundle');
  assert.equal((await partial.client.resolve({ key: 'travel.coast', width: 1200, height: 900 })).source, 'remote', 'Other placements are unaffected.');
});

test('the rule applies to retained releases and cached bytes', async () => {
  // A cached body never bypasses the rule: the original reference gets the bundle.
  const cached = harness(template, [[assets.coast.sha256, coast]]);
  await cached.client.refresh();
  const refused = await cached.client.resolve(icon);
  assert.equal(refused.source, 'bundle');
  assert.equal(refused.fallbackReason, 'missing');
  assert.deepEqual(cached.requests, [config.manifestUrl]);
  // The matching reference uses the same cache entry.
  const hit = await cached.client.resolve(templateIcon);
  assert.equal(hit.source, 'cache');
  assert.equal(hit.rendering, 'template');

  // Release 10's dark cell is original, so a template reference skips it and
  // uses release 9's matching descriptor from the cache, never downloading for it.
  const h = harness(template);
  await h.client.refresh();
  assert.equal((await h.client.resolve(templateIcon, { appearance: 'dark' })).source, 'remote');
  h.setManifest(mismatch);
  assert.deepEqual(await h.client.refresh(), { updated: true, sequence: 10 });
  const before = h.requests.length;
  const retained = await h.client.resolve(templateIcon, { appearance: 'dark' });
  assert.equal(retained.source, 'cache');
  assert.equal(retained.sequence, 9);
  assert.equal(retained.assetId, assets.coast.assetId);
  assert.equal(retained.rendering, 'template');
  assert.equal(h.requests.length, before);
  // An original reference matches neither release's descriptor for Any appearance.
  assert.equal((await h.client.resolve(icon)).source, 'bundle');
  assert.equal(h.requests.length, before);
});

test('only an absent or template reference rendering is valid', async () => {
  const h = harness(template);
  await h.client.refresh();
  for (const value of ['original', 'Template', null, 1]) {
    await assert.rejects(h.client.resolve({ ...icon, rendering: value }), /Invalid generated asset reference/);
    await assert.rejects(h.client.resolveStateSet({ ...icon, rendering: value, states: ['idle', 'active'] }), /Invalid generated asset reference/);
  }
});

test('asset pages share the descriptor check: malformed rendering rejects the page', async () => {
  const base = { kind: 'asset-page', schemaVersion: 1, orgId: config.orgId, appId: config.appId, environment: config.environment, sequence: 9, createdAt: '2026-10-09T00:00:00.000Z', cursor: null, nextCursor: null };
  const asset = { assetId: assets.coast.assetId, sha256: assets.coast.sha256, mime: 'image/webp', bytes: assets.coast.bytes, url: `/api/delivery/${config.orgId}/${config.appId}/assets/${assets.coast.assetId}`, width: 40, height: 30 };
  assert.doesNotThrow(() => verifySignedAssetPage(signed({ ...base, assets: [asset] }), config));
  assert.doesNotThrow(() => verifySignedAssetPage(signed({ ...base, assets: [{ ...asset, rendering: 'template' }] }), config));
  assert.throws(() => verifySignedAssetPage(signed({ ...base, assets: [{ ...asset, rendering: null }] }), config), /rendering/);
});
