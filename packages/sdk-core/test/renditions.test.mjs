import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AssetClient, createMemoryStorage, parsePublicConfig, verifySignedManifest } from '../dist/index.js';

const bytes = file => readFile(new URL(`./fixtures/${file}`, import.meta.url));
const json = async file => JSON.parse(await bytes(file));
const config = parsePublicConfig(await json('config.json'));
const fixture = await json('renditions.json');
const manifest = await json(fixture.manifest);
const ref = (await json('catalog.json')).placements[0];
const cases = await json('cases.json');
for (const item of cases.manifests) test(`shared signed contract: ${item.file}`, async () => {
  const value = await json(item.file);
  if (item.verification === 'reject') assert.throws(() => verifySignedManifest(value, config));
  else assert.ok(verifySignedManifest(value, config).payload.sequence > 0);
});

function harness(formats) {
  const storage = createMemoryStorage();
  const requests = [];
  let offline = false, corrupt = new Set();
  const fetch = async (url, init) => {
    requests.push({ url, init });
    if (offline) throw new Error('offline');
    if (url === config.manifestUrl) return new Response(JSON.stringify(manifest));
    const file = fixture.files.find(item => url.endsWith(item.sha256));
    if (file && !corrupt.has(file.sha256)) return new Response(await bytes(file.file));
    if (!url.includes('/renditions/')) return new Response(await bytes('assets/coast.webp'));
    return new Response('wrong');
  };
  return { client: new AssetClient(config, { storage, fetch, formats }), storage, fetch, requests,
    offline() { offline = true; }, corrupt(hash) { corrupt.add(hash); } };
}

test('selects adequate size, PNG MIME and exact bytes; undersized uses largest rendition', async () => {
  const h = harness(); await h.client.refresh();
  for (const selection of fixture.selections) {
    const result = await h.client.resolve(ref, { pixelWidth: selection.width, pixelHeight: selection.height });
    assert.equal(result.sha256, selection.sha256); assert.equal(result.mime, selection.mime);
    assert.ok(result.pixelWidth > 0); assert.ok(result.pixelHeight > 0);
    assert.equal(result.assetId, JSON.parse(manifest.payload).slots[0].assetId);
  }
  assert.equal(h.requests.some(request => request.url.endsWith(fixture.vector.sha256)), false);
  const pngRequest = h.requests.find(request => request.url.endsWith(fixture.selections[0].sha256));
  assert.equal(pngRequest.init.headers.Accept, 'image/png');
  assert.equal(pngRequest.init.credentials, 'omit'); assert.equal(pngRequest.init.redirect, 'error');
});

test('browser explicitly opts into SVG; generic client remains raster by default', async () => {
  const h = harness(['image/webp','image/png','image/svg+xml']); await h.client.refresh();
  const result = await h.client.resolve(ref);
  assert.equal(result.mime, 'image/svg+xml'); assert.equal(result.sha256, fixture.vector.sha256);
  assert.deepEqual(result.bytes, new Uint8Array(await bytes('assets/vector.svg')));
});

test('PNG survives independent offline restart and invalid cached/downloaded version falls back', async () => {
  const h = harness(); await h.client.refresh();
  const small = fixture.selections[0];
  const target = { pixelWidth: small.width, pixelHeight: small.height };
  assert.equal((await h.client.resolve(ref, target)).mime, 'image/png');
  h.offline();
  const restarted = new AssetClient(config, { storage: h.storage, fetch: h.fetch });
  const result = await restarted.resolve(ref, target);
  assert.equal(result.source, 'cache'); assert.equal(result.sha256, small.sha256);
  assert.equal(result.sequence, 4);
  const other = harness(); await other.client.refresh(); other.corrupt(small.sha256);
  await other.storage.putAsset(small.sha256, new Uint8Array(10));
  const recovered = await other.client.resolve(ref, target);
  assert.equal(recovered.sha256, fixture.selections[1].sha256);
  assert.equal(recovered.mime, 'image/png');
});

test('target and local decoder capabilities are bounded and explicit', async () => {
  const h = harness();
  for (const options of [null, {pixelWidth:0,pixelHeight:1}, {pixelWidth:2}, {pixelWidth:NaN,pixelHeight:3}, {pixelWidth:8193,pixelHeight:1}, {pixelWidth:1.5,pixelHeight:1}, {pixelWidth:true,pixelHeight:1}]) await assert.rejects(h.client.resolve(ref, options));
  for (const formats of [[], ['image/png'], ['image/webp','image/webp'], ['image/webp','image/gif']]) assert.throws(() => harness(formats));
});

test('legacy schema reader accepts the new signed payload without needing new image support', () => {
  // The mandatory schema-1 slot remains an ordinary WebP at its unchanged URL.
  const payload = JSON.parse(manifest.payload);
  assert.equal(payload.schemaVersion, 1);
  for (const slot of payload.slots) {
    assert.equal(slot.mime, 'image/webp');
    assert.equal(slot.url, `/api/delivery/${config.orgId}/${config.appId}/assets/${slot.assetId}`);
  }
});
