// Placement membership (contract revision of 2026-10-11): the latest accepted release alone
// decides whether a placement has published artwork. A key it does not publish resolves to the
// bundled fallback without reading the cache or any older release. The shared corpus covers
// single images and clips (fixtures/shared/history.json); these cover state sets, animations and arms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AssetClient, createMemoryStorage, hashBytes, parsePublicConfig } from '../dist/index.js';

const fixture = name => readFile(new URL(`./fixtures/${name}`, import.meta.url));
const config = parsePublicConfig(JSON.parse(await fixture('config.json')));
const seed = (await fixture('keys/TEST_ONLY_seed.hex')).toString().trim();
const privateKey = createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${seed}`, 'hex'), format: 'der', type: 'pkcs8' });
const prefix = `/api/delivery/${config.orgId}/${config.appId}`;
const objects = new Map();
const save = { key: 'travel.save', width: 40, height: 30 };
const coast = { key: 'travel.coast', width: 1200, height: 900 };
const saveStates = { ...save, states: ['empty', 'filled'] };
const bundledAccessibility = { defaultLocale: 'en', descriptions: { en: 'Bundled save icon' } };

function image(id) {
  const assetId = `33333333-3333-4333-8333-${String(id).padStart(12, '0')}`;
  const bytes = new TextEncoder().encode(`history-artwork-${id}`), url = `${prefix}/assets/${assetId}`;
  objects.set(url, bytes);
  return { assetId, sha256: hashBytes(bytes), url, mime: 'image/webp', bytes: bytes.length };
}
const constant = k => ({ a: 0, k });
function animation(id, assetUrl) {
  const lottie = { v: '5.13.0', fr: 30, ip: 0, op: 60, w: 120, h: 90, nm: `History ${id}`, ddd: 0, assets: [], layers: [{ ty: 4, ind: 1, ip: 0, op: 60, st: 0, sr: 1,
    ks: { o: constant(100), r: constant(0), p: constant([0, 0]), a: constant([0, 0]), s: constant([100, 100]) },
    shapes: [{ ty: 'rc', p: constant([60, 45]), s: constant([120, 90]), r: constant(4) }, { ty: 'fl', c: constant([0.1, 0.4, id / 100, 1]), o: constant(100), r: 1 }] }] };
  const bytes = new TextEncoder().encode(JSON.stringify(lottie)), sha256 = hashBytes(bytes), url = `${assetUrl}/animations/${sha256}`;
  objects.set(url, bytes);
  return { format: 'lottie', profile: 'vector-v1', mime: 'application/json', sha256, url, bytes: bytes.length, width: lottie.w, height: lottie.h, frameRate: lottie.fr, inPoint: lottie.ip, outPoint: lottie.op };
}
const plain = (ref, id) => ({ ...ref, screen: 'Travel', ...image(id) });
function stateful(id, names = saveStates.states) {
  const states = Object.fromEntries(names.map((name, index) => [name, image(id + index)]));
  return { ...save, screen: 'Travel', ...states[names[0]], defaultState: names[0], states };
}
const armed = id => ({ ...coast, screen: 'Travel', ...image(id), variants: { arm: ['b'] }, cells: [{ arm: 'b', ...image(id + 1) }] });
const release = (sequence, slots) => ({ schemaVersion: 1, stateSchemaVersion: 1, variantSchemaVersion: 1, animationSchemaVersion: 1, orgId: config.orgId, appId: config.appId, environment: config.environment, sequence, createdAt: '2026-10-11T12:00:00.000Z', slots });
function signed(value) {
  const payload = JSON.stringify(value);
  return { algorithm: 'Ed25519', keyId: config.keyId, publicKey: config.pinnedPublicKey, payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') };
}
async function harness(first, options = {}) {
  let current = first;
  const storage = createMemoryStorage(), requests = [];
  const fetch = async input => {
    if (input === config.manifestUrl) return new Response(JSON.stringify(signed(current)));
    const url = new URL(input).pathname; requests.push(url);
    return new Response(objects.get(url), { status: objects.has(url) ? 200 : 404 });
  };
  const client = new AssetClient(config, { storage, fetch, ...options });
  assert.equal((await client.refresh()).error, undefined);
  return { client, storage, requests, async publish(next) { current = next; assert.equal((await client.refresh()).sequence, next.sequence); requests.length = 0; } };
}

test('a state set whose key the current release does not publish gives the complete bundled family', async () => {
  const family = stateful(100);
  const h = await harness(release(1, [family, plain(coast, 110)]));
  assert.equal((await h.client.resolveStateSet(saveStates)).source, 'remote');
  await h.publish(release(2, [plain(coast, 110)]));
  const state = await h.storage.loadState();
  const result = await h.client.resolveStateSet(saveStates);
  assert.equal(result.source, 'bundle');
  assert.equal(result.sequence, null);
  assert.equal(result.arm, null);
  assert.equal(result.armSource, 'control');
  assert.equal(result.fallbackReason, 'missing');
  assert.equal(result.message, 'Using the complete bundled state set. The current release does not publish this placement.');
  assert.deepEqual(result.states, {});
  assert.deepEqual(h.requests, []);
  assert.equal(await h.storage.loadState(), state, 'Resolution never changes durable state.');
  for (const name of saveStates.states) assert.notEqual(await h.storage.getAsset(family.states[name].sha256), null, 'Cached bytes stay until normal eviction.');
  // Publishing the same family again is an ordinary cache hit.
  await h.publish(release(3, [family, plain(coast, 110)]));
  const again = await h.client.resolveStateSet(saveStates);
  assert.equal(again.source, 'cache');
  assert.equal(again.sequence, 3);
  assert.deepEqual(h.requests, []);
});

test('a state set whose current state names differ still uses the older cached family', async () => {
  const family = stateful(200);
  const h = await harness(release(1, [family]));
  assert.equal((await h.client.resolveStateSet(saveStates)).source, 'remote');
  await h.publish(release(2, [stateful(210, ['empty', 'filled', 'pressed'])]));
  const result = await h.client.resolveStateSet(saveStates);
  assert.equal(result.source, 'cache');
  assert.equal(result.sequence, 1);
  for (const name of saveStates.states) assert.equal(result.states[name].sha256, family.states[name].sha256);
  assert.deepEqual(h.requests, [], 'Neither the incompatible current family nor an older release is downloaded.');
});

test('removing a placement gives the animation poster and the bundled still image', async () => {
  const still = plain(coast, 300), animated = { ...still, animation: animation(30, still.url) };
  const h = await harness(release(1, [animated]));
  assert.equal((await h.client.resolve(coast)).source, 'remote');
  assert.equal((await h.client.resolveAnimation(coast)).source, 'remote');
  await h.publish(release(2, [plain(save, 310)]));
  const motion = await h.client.resolveAnimation(coast);
  assert.equal(motion.source, 'poster');
  assert.equal(motion.sequence, null);
  const poster = await h.client.resolve({ ...coast, bundledAccessibility });
  assert.equal(poster.source, 'bundle');
  assert.equal(poster.sequence, null);
  assert.equal(poster.fallbackReason, 'missing');
  assert.equal(poster.message, 'Using bundled artwork. The current release does not publish this placement.');
  assert.deepEqual(poster.accessibility, bundledAccessibility);
  assert.equal(poster.bytes, undefined);
  assert.deepEqual(h.requests, []);
  assert.notEqual(await h.storage.getAsset(animated.sha256), null);
  assert.notEqual(await h.storage.getAsset(animated.animation.sha256), null);
});

test('an explicit arm for a key the current release does not publish gives the bundle without a decision', async () => {
  let calls = 0;
  const slot = armed(400);
  const h = await harness(release(1, [slot]), { decide: () => { calls++; return 'b'; } });
  const before = await h.client.resolve(coast, { arm: 'b' });
  assert.equal(before.source, 'remote');
  assert.equal(before.assetId, slot.cells[0].assetId);
  await h.publish(release(2, [plain(save, 410)]));
  for (const method of ['resolve', 'resolveStateSet']) {
    const result = await h.client[method](method === 'resolve' ? coast : { ...coast, states: ['empty', 'filled'] }, { arm: 'b' });
    assert.equal(result.source, 'bundle', method);
    assert.equal(result.arm, null);
    assert.equal(result.armSource, 'explicit');
    assert.equal(result.fallbackReason, 'missing');
  }
  assert.equal(calls, 0);
  assert.deepEqual(h.requests, []);
});

test('the decision callback is not called for a key the current release does not publish', async () => {
  let calls = 0;
  const slot = armed(500);
  const h = await harness(release(1, [slot]), { decide: () => { calls++; return 'b'; } });
  const decided = await h.client.resolve(coast);
  assert.equal(decided.source, 'remote');
  assert.equal(decided.armSource, 'decision');
  assert.equal(decided.assetId, slot.cells[0].assetId);
  assert.equal((await h.client.resolve(coast, { arm: 'control' })).source, 'remote');
  assert.equal(calls, 1);
  await h.publish(release(2, [plain(save, 510)]));
  const result = await h.client.resolve(coast);
  assert.equal(result.source, 'bundle');
  assert.equal(result.armSource, 'control');
  assert.equal(result.fallbackReason, 'missing');
  assert.equal(calls, 1);
  assert.deepEqual(h.requests, []);
});
