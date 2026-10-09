import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { AssetClient, createMemoryStorage, hashBytes, parsePublicConfig, verifySignedManifest, verifySignedAssetPage } from '../dist/index.js';

const orgId = '11111111-1111-4111-8111-111111111111', appId = '22222222-2222-4222-8222-222222222222';
const key = generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
const config = parsePublicConfig({ schemaVersion: 1, orgId, appId, environment: 'production', manifestUrl: `https://images.example/api/delivery/${orgId}/${appId}/manifest`, pinnedPublicKey: publicKey });
const path = `/api/delivery/${orgId}/${appId}`;
const now = '2026-10-08T12:00:00.000Z';
const signPayload = data => { const payload = JSON.stringify(data); return { algorithm: 'Ed25519', keyId, publicKey, payload, signature: sign(null, Buffer.from(payload), key.privateKey).toString('base64') }; };
const ref = { key: 'tasks.garden', width: 600, height: 400, states: ['empty', 'started', 'growing', 'complete'] };
const data = new Map();
function descriptor(n) {
  const assetId = `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
  const bytes = new TextEncoder().encode(`verified image ${n}`);
  const url = `${path}/assets/${assetId}`;
  data.set(url, bytes);
  return { assetId, sha256: hashBytes(bytes), url, mime: 'image/webp', bytes: bytes.length };
}
function release(sequence, offset = 0, catalogCount = 0) {
  const states = Object.fromEntries(ref.states.map((name, index) => [name, descriptor(offset + index + 1)]));
  return signPayload({ schemaVersion: 1, stateSchemaVersion: 1, orgId, appId, environment: 'production', sequence, createdAt: now,
    slots: [{ key: ref.key, screen: 'Tasks', width: ref.width, height: ref.height, ...states.empty, states, defaultState: 'empty' }],
    ...(catalogCount ? { catalogSchemaVersion: 1, catalog: { url: `${path}/releases/${sequence}/assets`, count: catalogCount } } : {}) });
}
function harness(options = {}) {
  let manifest = release(1), offline = false, corrupted = new Set();
  let imageReads = 0, imageWrites = 0, metadataWrites = 0;
  const storage = createMemoryStorage(), requests = [];
  const durable = { ...storage, getAsset: async h => { imageReads++; return storage.getAsset(h); }, putAsset: async (...a) => { imageWrites++; return storage.putAsset(...a); }, saveState: async s => { metadataWrites++; return storage.saveState(s); } };
  const fetch = async (url, init) => {
    requests.push({ url, init });
    if (offline) throw new Error('offline');
    if (url === config.manifestUrl) return new Response(JSON.stringify(manifest));
    const p = new URL(url).pathname;
    if (corrupted.has(p)) return new Response('broken');
    return new Response(data.get(p), { status: data.has(p) ? 200 : 404 });
  };
  const client = new AssetClient(config, { storage: durable, fetch, ...options });
  return { client, storage: durable, fetch, requests, setRelease: value => { manifest = value; }, offline: () => { offline = true; }, corrupt: p => { corrupted.add(p); }, counters: () => ({ imageReads, imageWrites, metadataWrites }) };
}

test('a state family activates completely, pins one release, and falls back as a complete family', async () => {
  const h = harness(); await h.client.refresh();
  const first = await h.client.resolveStateSet(ref);
  assert.equal(first.source, 'remote'); assert.equal(first.sequence, 1);
  assert.deepEqual(Object.keys(first.states), ref.states);
  const next = release(2, 10); h.setRelease(next);
  h.corrupt(JSON.parse(next.payload).slots[0].states.growing.url);
  await h.client.refresh();
  const fallback = await h.client.resolveStateSet(ref);
  assert.equal(fallback.source, 'cache'); assert.equal(fallback.sequence, 1);
  assert.ok(Object.values(fallback.states).every(item => item.sequence === 1));
  assert.ok(Object.values(first.states).every(item => item.sequence === 1));
  const lastRequestCount = h.requests.length;
  assert.equal(first.states.complete.sequence, 1); // Selecting another already-resolved stage is synchronous.
  assert.equal(h.requests.length, lastRequestCount);
  const noOldGroup = harness(); noOldGroup.setRelease(next); noOldGroup.corrupt(JSON.parse(next.payload).slots[0].states.started.url);
  await noOldGroup.client.refresh();
  assert.deepEqual((await noOldGroup.client.resolveStateSet(ref)).states, {});
  assert.equal((await h.client.resolveStateSet({ ...ref, states: ['empty', 'complete'] })).source, 'bundle');
});

test('state schema fails closed for incomplete default, unsafe names, foreign URLs and oversized groups', () => {
  const original = JSON.parse(release(1).payload);
  const bad = [
    p => { p.stateSchemaVersion = 2; },
    p => { delete p.slots[0].states.empty; },
    p => { p.slots[0].states.started.url = 'https://other.example/image'; },
    p => { p.slots[0].defaultState = 'complete'; },
    p => { p.slots[0].states.constructor = p.slots[0].states.started; },
    p => { p.slots[0].states = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`stage${i}`, { ...p.slots[0], bytes: 8 * 1024 * 1024, states: undefined }])); p.slots[0].defaultState = 'stage0'; },
  ];
  for (const mutate of bad) { const copy = structuredClone(original); mutate(copy); assert.throws(() => verifySignedManifest(signPayload(copy), config)); }
});

for (const policy of ['memory', 'none']) test(`${policy} skips persistent image storage but preserves durable replay protection`, async () => {
  const h = harness({ cachePolicy: policy }); await h.client.refresh();
  const first = await h.client.resolve(ref); assert.equal(first.source, 'remote'); assert.equal(first.cachePolicy, policy);
  assert.equal((await h.client.resolve(ref)).source, policy === 'memory' ? 'cache' : 'remote');
  assert.deepEqual(h.counters(), { imageReads: 0, imageWrites: 0, metadataWrites: 1 });
  assert.ok(h.requests.filter(r => r.url !== config.manifestUrl).every(r => r.init.cache === 'no-store'));
  h.setRelease(release(2)); await h.client.refresh();
  const restarted = new AssetClient(config, { storage: h.storage, cachePolicy: policy, fetch: h.fetch });
  h.setRelease(release(1)); assert.match((await restarted.refresh()).error, /older/);
  h.offline(); assert.equal((await restarted.resolve(ref)).source, 'bundle');
  h.client.clearMemoryCache(); assert.equal((await h.client.resolve(ref)).source, 'bundle');
});

test('per-request retention overrides do not read or write the disk cache', async () => {
  const h = harness(); await h.client.refresh(); await h.client.resolve(ref);
  assert.equal(h.counters().imageWrites, 1);
  const baseline = h.counters();
  assert.equal((await h.client.resolve(ref, { cachePolicy: 'none' })).source, 'remote');
  assert.equal((await h.client.resolve(ref, { cachePolicy: 'memory' })).source, 'remote');
  assert.deepEqual(h.counters(), baseline);
  await assert.rejects(h.client.resolve(ref, { cachePolicy: 'forever' }), /policy/);
});

function catalogHarness(count = 125, extra = {}) {
  const assets = Array.from({ length: count }, (_, i) => ({ ...descriptor(1000 + i), width: 600, height: 400, name: `Destination ${i + 1}` }));
  let current = release(1, 0, count), modifyPage = p => p;
  const calls = [];
  const storage = createMemoryStorage();
  const fetch = async (input, init) => {
    const url = new URL(input); calls.push({ url, init });
    if (url.pathname.endsWith('/manifest')) return new Response(JSON.stringify(current));
    if (url.pathname.includes('/releases/')) {
      const cursor = url.searchParams.get('cursor'), limit = Number(url.searchParams.get('limit') || 20);
      const remaining = assets.filter(a => !cursor || a.assetId > cursor), page = remaining.slice(0, limit);
      const sequence = Number(url.pathname.split('/').at(-2));
      return new Response(JSON.stringify(signPayload(modifyPage({ kind: 'asset-page', schemaVersion: 1, orgId, appId, environment: 'production', sequence, createdAt: now, assets: page, cursor, nextCursor: remaining.length > page.length ? page.at(-1).assetId : null }))));
    }
    if (extra.imageFetch) return extra.imageFetch(input, init);
    return new Response(data.get(url.pathname));
  };
  const client = new AssetClient(config, { storage, fetch, cachePolicy: 'memory', ...extra.options });
  return { client, fetch, storage, assets, calls, setRelease: p => { current = p; }, modifyPage: fn => { modifyPage = fn; } };
}

test('catalog paginates beyond the placement limit, fetching no image bodies until requested', async () => {
  const h = catalogHarness(); await h.client.refresh();
  let cursor, count = 0, selected, sequence;
  do { const page = await h.client.loadAssetPage({ limit: 30, cursor, sequence }); sequence = page.sequence; count += page.items.length; selected ??= page.items[0]; cursor = page.nextCursor ?? undefined; } while (cursor);
  assert.equal(count, 125); assert.equal(h.calls.length, 6);
  assert.equal(selected.name, 'Destination 1'); assert.ok(Object.isFrozen(selected));
  assert.equal((await h.client.resolveAsset(selected)).source, 'remote');
  assert.equal(h.calls.length, 7); assert.equal((await h.client.resolveAsset(selected)).source, 'cache');
  await assert.rejects(h.client.resolveAsset({ ...selected }), /verified catalog/);
  const other = catalogHarness(); await assert.rejects(other.client.resolveAsset(selected), /verified catalog/);
  h.setRelease(release(2, 10, 125)); await h.client.refresh();
  const pinned = await h.client.loadAssetPage({ sequence: 1, limit: 1 }); assert.equal(pinned.sequence, 1);
  assert.equal((await h.client.resolveAsset(selected)).sequence, 1);
  assert.equal(h.client.getStatus().sequence, 2);
});

test('catalog rejects mismatched scope, request cursor, sequence, duplicate assets and URL escapes', async () => {
  const h = catalogHarness(2); await h.client.refresh();
  for (const change of [p => ({ ...p, appId: orgId }), p => ({ ...p, sequence: 2 }), p => ({ ...p, cursor: h.assets[0].assetId }), p => ({ ...p, assets: [p.assets[0], p.assets[0]] }), p => ({ ...p, assets: [{ ...p.assets[0], url: 'https://foreign.example/a' }] })]) {
    h.modifyPage(change); await assert.rejects(h.client.loadAssetPage());
  }
  const standalone = signPayload({ kind: 'asset-page', schemaVersion: 1, orgId, appId, environment: 'production', sequence: 1, createdAt: now, assets: [], cursor: null, nextCursor: null });
  assert.equal(verifySignedAssetPage(standalone, config).payload.assets.length, 0);
  assert.throws(() => verifySignedAssetPage({ ...standalone, payload: standalone.payload.replace('asset-page', 'forged') }, config));
  const empty = { ...JSON.parse(release(1, 0, 2).payload), slots: [] };
  assert.equal(verifySignedManifest(signPayload(empty), config).payload.slots.length, 0);
});

test('independent image requests run concurrently within a limit and cancelled queued work never starts', async () => {
  const pending = [], started = [];
  const h = catalogHarness(5, { options: { maxConcurrentDownloads: 2 }, imageFetch: async (url, init) => {
    started.push(url);
    return new Promise((resolve, reject) => {
      pending.push(() => resolve(new Response(data.get(new URL(url).pathname))));
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  } });
  await h.client.refresh(); const page = await h.client.loadAssetPage();
  const ac = new AbortController();
  const a = h.client.resolveAsset(page.items[0]), b = h.client.resolveAsset(page.items[1]);
  const c = h.client.resolveAsset(page.items[2], { signal: ac.signal }); const cancelled = assert.rejects(c, /cancelled/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 2); ac.abort(); await cancelled;
  // A metadata refresh is not held behind image I/O.
  h.setRelease(release(2, 0, 5)); assert.equal((await h.client.refresh()).sequence, 2);
  pending.shift()(); pending.shift()(); await Promise.all([a, b]);
  assert.equal(started.length, 2);
});

test('active cancellation rejects even when a transport ignores abort and never retains bytes', async () => {
  const h = catalogHarness(1, { imageFetch: async () => new Promise(() => {}) });
  await h.client.refresh(); const { items } = await h.client.loadAssetPage();
  const ac = new AbortController();
  const result = h.client.resolveAsset(items[0], { signal: ac.signal, cachePolicy: 'none' });
  const rejected = assert.rejects(result, /cancelled/); ac.abort(); await rejected;
});
