import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AssetClient, createMemoryStorage, hashBytes, parsePublicConfig, verifySignedManifest } from '../dist/index.js';

const fixture = name => readFile(new URL(`./fixtures/${name}`, import.meta.url));
const json = async name => JSON.parse(await fixture(name));
const config = parsePublicConfig(await json('config.json'));
const seed = (await fixture('keys/TEST_ONLY_seed.hex')).toString().trim();
const privateKey = createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${seed}`, 'hex'), format: 'der', type: 'pkcs8' });
function signed(value) {
  const payload = JSON.stringify(value);
  return { algorithm: 'Ed25519', keyId: config.keyId, publicKey: config.pinnedPublicKey, payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') };
}
const ref = { key: 'travel.coast', width: 1200, height: 900, variants: { appearance: ['light', 'dark'] } };
const stateRef = { ...ref, states: ['empty', 'growing'] };
const data = new Map();
function descriptor(id) {
  const assetId = `33333333-3333-4333-8333-${String(id).padStart(12, '0')}`;
  const bytes = new TextEncoder().encode(`appearance-artwork-${id}`);
  const url = `/api/delivery/${config.orgId}/${config.appId}/assets/${assetId}`;
  data.set(url, bytes);
  return { assetId, sha256: hashBytes(bytes), url, bytes: bytes.length, mime: 'image/webp' };
}
function release(sequence, { stateful = false, dark = true, light = true } = {}) {
  const any = descriptor(sequence * 10), day = descriptor(sequence * 10 + 2), night = descriptor(sequence * 10 + 4);
  const slot = { ...ref, variants: { appearance: ['light', 'dark'] }, screen: 'Travel', ...any, cells: [] };
  if (stateful) Object.assign(slot, { defaultState: 'empty', states: { empty: any, growing: descriptor(sequence * 10 + 1) } });
  for (const [appearance, enabled, image, offset] of [['light', light, day, 3], ['dark', dark, night, 5]]) {
    if (enabled) slot.cells.push({ appearance, ...image, ...(stateful ? { states: { empty: image, growing: descriptor(sequence * 10 + offset) } } : {}) });
  }
  return { schemaVersion: 1, variantSchemaVersion: 1, ...(stateful ? { stateSchemaVersion: 1 } : {}), orgId: config.orgId, appId: config.appId, environment: config.environment, sequence, createdAt: '2026-10-08T12:00:00.000Z', slots: [slot] };
}
function harness(initial, options = {}) {
  let payload = initial, offline = false;
  const failed = new Set(), requests = [], keys = [];
  const memory = createMemoryStorage();
  const storage = { ...memory, putAsset: async (key, ...rest) => { keys.push(key); await memory.putAsset(key, ...rest); } };
  const fetch = async input => {
    if (input === config.manifestUrl) return new Response(JSON.stringify(signed(payload)));
    const url = new URL(input).pathname; requests.push(url);
    if (offline || failed.has(url)) throw new Error('offline');
    return new Response(data.get(url), { status: data.has(url) ? 200 : 404 });
  };
  const client = new AssetClient(config, { storage, fetch, ...options });
  return { client, storage, fetch, keys, requests, setRelease: value => { payload = value; }, offline: () => { offline = true; }, fail: url => failed.add(url) };
}

test('all signed fixture cases retain their expected verification result and SHA256SUMS match', async () => {
  const cases = await json('cases.json');
  for (const entry of cases.manifests) {
    const envelope = await json(entry.file);
    if (entry.verification === 'accept') assert.doesNotThrow(() => verifySignedManifest(envelope, config), entry.file);
    else assert.throws(() => verifySignedManifest(envelope, config), undefined, entry.file);
  }
  for (const line of (await fixture('SHA256SUMS')).toString().trim().split('\n')) {
    const hash = line.slice(0, 64), file = line.slice(66);
    assert.equal(createHash('sha256').update(await fixture(file)).digest('hex'), hash, file);
  }
});

test('appearance validation rejects malformed declarations, cells, descriptors and state families', () => {
  const invalid = [
    p => { p.variantSchemaVersion = null; },
    p => { p.variantSchemaVersion = true; },
    p => { delete p.variantSchemaVersion; },
    p => { p.slots[0].variants = null; },
    p => { p.slots[0].variants = {}; },
    p => { p.slots[0].variants.appearance = []; },
    p => { p.slots[0].variants.appearance = ['dark', 'dark']; },
    p => { p.slots[0].variants.appearance = ['any']; },
    p => { p.slots[0].variants.locale = ['en']; },
    p => { delete p.slots[0].variants; },
    p => { p.slots[0].cells = null; },
    p => { p.slots[0].cells = [null]; },
    p => { p.slots[0].cells[1] = p.slots[0].cells[0]; },
    p => { p.slots[0].cells[0].appearance = 'system'; },
    p => { p.slots[0].cells[0].assetId = 'wrong'; },
    p => { p.slots[0].cells[0].sha256 = 'wrong'; },
    p => { p.slots[0].cells[0].bytes = 0; },
    p => { p.slots[0].cells[0].bytes = 8 * 1024 * 1024 + 1; },
    p => { p.slots[0].cells[0].mime = 'image/png'; },
    p => { p.slots[0].cells[0].url = 'https://outside.example/image'; },
    p => { p.slots[0].cells[0].accessibility = { defaultLocale: 'en', descriptions: {} }; },
    p => { p.slots[0].cells[0].renditions = []; },
    p => { p.slots[0].cells[0].defaultState = 'empty'; },
    p => { delete p.slots[0].cells[0].states; },
    p => { delete p.slots[0].cells[0].states.growing; },
    p => { p.slots[0].cells[0].states.extra = descriptor(99); },
    p => { p.slots[0].cells[0].states.growing.url = 'https://outside.example/image'; },
    p => { p.slots[0].cells[0].states.empty = descriptor(99); },
    p => { p.slots[0].cells[0].accessibility = { defaultLocale: 'en', descriptions: { en: 'Must match default state' } }; },
  ];
  for (const mutate of invalid) {
    const payload = release(1, { stateful: true }); mutate(payload);
    assert.throws(() => verifySignedManifest(signed(payload), config), undefined, mutate.toString());
  }
  const stateless = release(1); stateless.slots[0].cells[0].states = {};
  assert.throws(() => verifySignedManifest(signed(stateless), config), /stateless/);
  const noCells = release(1, { dark: false, light: false });
  assert.doesNotThrow(() => verifySignedManifest(signed(noCells), config));
  delete noCells.slots[0].cells;
  assert.doesNotThrow(() => verifySignedManifest(signed(noCells), config));
});

for (const policy of ['disk', 'memory', 'none']) test(`${policy}: appearance selects a complete descriptor and isolates its cache`, async () => {
  const payload = release(1), h = harness(payload, { cachePolicy: policy });
  await h.client.refresh();
  const results = {};
  for (const appearance of ['dark', 'light', undefined]) {
    const result = await h.client.resolve(ref, { appearance }); results[String(appearance)] = result;
    assert.equal(result.source, 'remote');
    assert.equal(result.assetId, appearance ? payload.slots[0].cells.find(c => c.appearance === appearance).assetId : payload.slots[0].assetId);
    assert.equal((await h.client.resolve(ref, { appearance })).source, policy === 'none' ? 'remote' : 'cache');
  }
  assert.equal(new Set(Object.values(results).map(result => result.cacheKey)).size, 3);
  assert.equal(results.undefined.cacheKey, results.undefined.sha256);
  if (policy === 'disk') assert.deepEqual(new Set(h.keys), new Set(Object.values(results).map(result => result.cacheKey)));
  h.offline();
  assert.equal((await h.client.resolve(ref, { appearance: 'dark' })).source, policy === 'none' ? 'bundle' : 'cache');
  await assert.rejects(h.client.resolve(ref, { appearance: 'system' }), /appearance/);
  await assert.rejects(h.client.resolveStateSet(stateRef, { appearance: 'any' }), /appearance/);
});

test('an unbound appearance inherits Any but keeps distinct request cache keys across restart', async () => {
  const payload = release(1, { dark: false, light: false }), h = harness(payload);
  await h.client.refresh();
  const dark = await h.client.resolve(ref, { appearance: 'dark' });
  const light = await h.client.resolve(ref, { appearance: 'light' });
  assert.equal(dark.sha256, light.sha256); assert.notEqual(dark.cacheKey, light.cacheKey);
  h.offline();
  const restarted = new AssetClient(config, { storage: h.storage, fetch: h.fetch });
  assert.equal((await restarted.resolve(ref, { appearance: 'dark' })).source, 'cache');
  assert.equal((await restarted.resolve(ref, { appearance: 'light' })).source, 'cache');
  assert.equal((await restarted.resolve(ref)).source, 'bundle');
});

test('historical fallback selects the requested appearance and never borrows cached dark for light', async () => {
  const old = release(1), current = release(2), h = harness(old);
  await h.client.refresh();
  const dark = await h.client.resolve(ref, { appearance: 'dark' });
  h.setRelease(current); await h.client.refresh(); h.offline();
  assert.equal((await h.client.resolve(ref, { appearance: 'dark' })).sha256, dark.sha256);
  assert.equal((await h.client.resolve(ref, { appearance: 'dark' })).sequence, 1);
  assert.equal((await h.client.resolve(ref, { appearance: 'light' })).source, 'bundle');
  assert.equal((await h.client.resolve(ref)).source, 'bundle');
});

test('historical Any fallback is selected for the same request appearance when that old cell was absent', async () => {
  const old = release(1, { dark: false }), h = harness(old);
  await h.client.refresh();
  await h.client.resolve(ref, { appearance: 'dark' });
  h.setRelease(release(2)); await h.client.refresh(); h.offline();
  const result = await h.client.resolve(ref, { appearance: 'dark' });
  assert.equal(result.sequence, 1); assert.equal(result.sha256, old.slots[0].sha256);
});

test('state families use one appearance and release, including history and absent-cell fallback', async () => {
  const old = release(1, { stateful: true }), h = harness(old);
  await h.client.refresh();
  const initial = await h.client.resolveStateSet(stateRef, { appearance: 'dark' });
  assert.equal(initial.source, 'remote');
  for (const name of stateRef.states) assert.equal(initial.states[name].sha256, old.slots[0].cells[1].states[name].sha256);
  const next = release(2, { stateful: true }); h.setRelease(next);
  h.fail(next.slots[0].cells[1].states.growing.url); await h.client.refresh();
  const historical = await h.client.resolveStateSet(stateRef, { appearance: 'dark' });
  assert.equal(historical.sequence, 1); assert.ok(Object.values(historical.states).every(value => value.sequence === 1));
  h.offline(); assert.equal((await h.client.resolveStateSet(stateRef, { appearance: 'light' })).source, 'bundle');
  const missing = release(3, { stateful: true, dark: false }), other = harness(missing);
  await other.client.refresh();
  const inherited = await other.client.resolveStateSet(stateRef, { appearance: 'dark' });
  for (const name of stateRef.states) assert.equal(inherited.states[name].sha256, missing.slots[0].states[name].sha256);
  other.setRelease(release(4, { stateful: true })); await other.client.refresh(); other.offline();
  assert.equal((await other.client.resolveStateSet(stateRef, { appearance: 'dark' })).sequence, 3);
});

test('failed dark state never borrows a matching Any state from the current family', async () => {
  const payload = release(1, { stateful: true }), h = harness(payload);
  await h.client.refresh(); await h.client.resolveStateSet(stateRef);
  h.fail(payload.slots[0].cells[1].states.growing.url);
  assert.equal((await h.client.resolveStateSet(stateRef, { appearance: 'dark' })).source, 'bundle');
});

test('additive image fields cannot override the validated placement canvas during resolution', async () => {
  const payload = release(1, { stateful: true });
  const cell = payload.slots[0].cells[1];
  Object.assign(cell, { width: 0, height: 0, key: 'unrelated' });
  for (const state of Object.values(cell.states)) Object.assign(state, { width: 0, height: 0, key: 'unrelated' });
  const h = harness(payload); assert.equal((await h.client.refresh()).error, undefined);
  assert.equal((await h.client.resolve(ref, { appearance: 'dark' })).source, 'remote');
  assert.notEqual((await h.client.resolveStateSet(stateRef, { appearance: 'dark' })).source, 'bundle');
});

test('appearance descriptor does not inherit Any accessibility or renditions', async () => {
  const payload = JSON.parse((await json('manifests/valid-renditions-seq4.json')).payload);
  const dark = descriptor(88);
  payload.variantSchemaVersion = 1;
  payload.slots[0].accessibility = { defaultLocale: 'en', descriptions: { en: 'Any artwork only' } };
  payload.slots[0].variants = { appearance: ['dark'] };
  payload.slots[0].cells = [{ appearance: 'dark', ...dark }];
  const h = harness(payload); await h.client.refresh();
  const result = await h.client.resolve(ref, { appearance: 'dark', pixelWidth: 120, pixelHeight: 90 });
  assert.equal(result.sha256, dark.sha256); assert.equal(result.accessibility, undefined);
  assert.deepEqual(h.requests, [dark.url]);
});

test('animation always uses Any even when a dark image is requested', async () => {
  const payload = JSON.parse((await json('manifests/valid-animation-poster-seq5.json')).payload);
  const animation = payload.slots[0].animation;
  data.set(animation.url, new Uint8Array(await fixture('assets/animation.json')));
  payload.variantSchemaVersion = 1;
  payload.slots[0].variants = { appearance: ['dark'] };
  payload.slots[0].cells = [{ appearance: 'dark', ...descriptor(88) }];
  const h = harness(payload); await h.client.refresh();
  const result = await h.client.resolveAnimation(ref, { appearance: 'dark' });
  assert.equal(result.source, 'remote'); assert.equal(result.assetId, payload.slots[0].assetId);
  assert.deepEqual(h.keys, [animation.sha256]);
  assert.equal((await h.client.resolveAnimation(ref, { appearance: 'light' })).source, 'cache');
});
