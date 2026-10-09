import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AssetClient, createMemoryStorage, hashBytes, parsePublicConfig, verifySignedManifest, SDK_LIMITS } from '../dist/index.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const appId = '22222222-2222-4222-8222-222222222222';
const assetId = '33333333-3333-4333-8333-333333333333';
const keypair = generateKeyPairSync('ed25519');
const publicKey = keypair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
const config = parsePublicConfig({ schemaVersion: 1, orgId, appId, environment: 'production', manifestUrl: `https://assets.example/api/delivery/${orgId}/${appId}/manifest`, pinnedPublicKey: publicKey, keyId });
const ref = { key: 'travel.coast', width: 1200, height: 900 };
const bytes1 = new TextEncoder().encode('test-image-one');
const bytes2 = new TextEncoder().encode('test-image-two');
function envelope(sequence = 1, bytes = bytes1, changes = {}) {
  const payload = JSON.stringify({ schemaVersion: 1, orgId, appId, environment: 'production', sequence, createdAt: '2026-10-07T12:00:00.000Z', slots: [{ ...ref, screen: 'Travel', assetId, sha256: hashBytes(bytes), url: `/api/delivery/${orgId}/${appId}/assets/${assetId}`, mime: 'image/webp', bytes: bytes.length }], ...changes });
  return { algorithm: 'Ed25519', keyId, publicKey, payload, signature: sign(null, Buffer.from(payload), keypair.privateKey).toString('base64') };
}
function delivery() {
  const state = { release: envelope(), bytes: bytes1, offline: false, requests: [] };
  return { state, fetch: async (url, init) => {
    state.requests.push({ url, init });
    if (state.offline) throw new Error('offline');
    return new Response(url.endsWith('/manifest') ? JSON.stringify(state.release) : state.bytes);
  } };
}

test('Node-signed Ed25519 fixture verifies against independent pin and rejects tampering/forged self-pins', () => {
  assert.equal(verifySignedManifest(envelope(), config).payload.sequence, 1);
  assert.throws(() => verifySignedManifest({ ...envelope(), payload: envelope().payload.replace('Travel', 'Forged') }, config), /signature/);
  const attacker = generateKeyPairSync('ed25519');
  const forged = { ...envelope(), publicKey: attacker.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  forged.signature = sign(null, Buffer.from(forged.payload), attacker.privateKey).toString('base64');
  assert.throws(() => verifySignedManifest(forged, config), /envelope/);
});

test('rejects cross-app, unknown schema, duplicate slots, external URLs and unsupported formats', () => {
  for (const changes of [{ appId: orgId }, { orgId: appId }, { environment: 'staging' }, { schemaVersion: 2 }]) assert.throws(() => verifySignedManifest(envelope(1, bytes1, changes), config));
  const slot = JSON.parse(envelope().payload).slots[0];
  for (const slots of [[slot, slot], [{ ...slot, url: 'https://attacker.example/image.webp' }], [{ ...slot, mime: 'image/svg+xml' }], [{ ...slot, bytes: SDK_LIMITS.assetBytes + 1 }]]) assert.throws(() => verifySignedManifest(envelope(1, bytes1, { slots }), config));
});

test('HTTPS is mandatory except an explicit loopback development option', () => {
  const local = { ...config, manifestUrl: config.manifestUrl.replace('https://assets.example', 'http://localhost:3000') };
  assert.throws(() => parsePublicConfig(local), /HTTPS/);
  assert.equal(parsePublicConfig(local, { allowInsecureLoopback: true }).manifestUrl, local.manifestUrl);
  assert.throws(() => parsePublicConfig({ ...local, manifestUrl: local.manifestUrl.replace('localhost', '192.168.1.2') }, { allowInsecureLoopback: true }), /HTTPS/);
});

test('first render uses bundle; signed update downloads and hashes then survives offline restart', async () => {
  const service = delivery(); const storage = createMemoryStorage();
  const client = new AssetClient(config, { storage, fetch: service.fetch });
  assert.equal((await client.resolve(ref)).source, 'bundle');
  assert.equal(service.state.requests.length, 0);
  assert.deepEqual(await client.refresh(), { updated: true, sequence: 1 });
  const downloaded = await client.resolve(ref);
  assert.equal(downloaded.source, 'remote'); assert.deepEqual(downloaded.bytes, bytes1);
  assert.equal(service.state.requests[0].init.credentials, 'omit');
  assert.equal(service.state.requests[0].init.redirect, 'error');
  service.state.offline = true;
  const restarted = new AssetClient(config, { storage, fetch: service.fetch });
  assert.equal((await restarted.initialize()).sequence, 1);
  assert.equal((await restarted.resolve(ref)).source, 'cache');
  assert.equal((await restarted.refresh()).error, 'offline');
});

test('rejects byte mismatch and falls back to verified cached previous release', async () => {
  const service = delivery(); const client = new AssetClient(config, { storage: createMemoryStorage(), fetch: service.fetch });
  await client.refresh(); await client.resolve(ref);
  service.state.release = envelope(2, bytes2); service.state.bytes = new Uint8Array(bytes2.length);
  assert.equal((await client.refresh()).sequence, 2);
  const fallback = await client.resolve(ref);
  assert.equal(fallback.source, 'cache'); assert.equal(fallback.sequence, 1); assert.deepEqual(fallback.bytes, bytes1);
  assert.match(fallback.message, /do not match/);
});

test('replay is rejected across restarts; legitimate rollback uses a new monotonic sequence', async () => {
  const service = delivery(); const storage = createMemoryStorage();
  const first = new AssetClient(config, { storage, fetch: service.fetch });
  service.state.release = envelope(5); await first.refresh();
  const restarted = new AssetClient(config, { storage, fetch: service.fetch });
  service.state.release = envelope(4);
  assert.match((await restarted.refresh()).error, /older release/);
  service.state.release = envelope(5, bytes2);
  assert.match((await restarted.refresh()).error, /Conflicting/);
  service.state.release = envelope(6, bytes1);
  assert.deepEqual(await restarted.refresh(), { updated: true, sequence: 6 });
});

test('corrupt stored replay state fails closed and cache contents are rehashed', async () => {
  const service = delivery(); const storage = createMemoryStorage();
  const client = new AssetClient(config, { storage, fetch: service.fetch });
  await client.refresh(); await client.resolve(ref);
  await storage.putAsset(hashBytes(bytes1), new Uint8Array(bytes1.length));
  service.state.offline = true;
  assert.equal((await client.resolve(ref)).source, 'bundle');
  const corrupt = new AssetClient(config, { storage: { ...storage, loadState: async () => '{broken' }, fetch: service.fetch });
  assert.match((await corrupt.initialize()).lastError, /could not be verified/);
  assert.match((await corrupt.refresh()).error, /could not be verified/);
  assert.equal((await corrupt.resolve(ref)).source, 'bundle');
});

test('storage failure never advances active release; mismatched placement contracts use bundle', async () => {
  const service = delivery();
  const client = new AssetClient(config, { storage: { ...createMemoryStorage(), saveState: async () => { throw new Error('quota'); } }, fetch: service.fetch });
  assert.equal((await client.refresh()).error, 'quota');
  assert.equal(client.getStatus().sequence, 0);
  const working = new AssetClient(config, { storage: createMemoryStorage(), fetch: service.fetch });
  await working.refresh();
  assert.equal((await working.resolve({ ...ref, height: 800 })).source, 'bundle');
});

test('bounds streamed bodies without relying on Content-Length and enforces total request deadline', async () => {
  const oversized = new AssetClient(config, { storage: createMemoryStorage(), fetch: async () => new Response(new Uint8Array(SDK_LIMITS.manifestBytes + 1)) });
  assert.match((await oversized.refresh()).error, /byte limit/);
  const stalled = new AssetClient(config, { storage: createMemoryStorage(), fetch: async () => new Promise(() => {}), timeoutMs: 20 });
  assert.match((await stalled.refresh()).error, /timed out/);
});

test('offline codegen emits nested typed references and rejects symbol collisions', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'assetlib-codegen-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = path.join(root, 'catalog.json');
  await writeFile(catalog, JSON.stringify({ schemaVersion: 1, placements: [{ ...ref, symbol: ['Travel', 'coast'] }] }));
  const run = () => spawnSync(process.execPath, ['bin/codegen.mjs', catalog], { encoding: 'utf8' });
  const good = run(); assert.equal(good.status, 0, good.stderr); assert.match(good.stdout, /"Travel"/); assert.match(good.stdout, /as const/);
  await writeFile(catalog, JSON.stringify({ schemaVersion: 1, placements: [{ ...ref, symbol: ['Travel'] }, { ...ref, key: 'travel.ridge', symbol: ['Travel', 'ridge'] }] }));
  assert.equal(run().status, 1);
});

test('a generic fixed-contract renderer adopts an unseen backend key and later artwork revisions without a checked-in key registry', async () => {
  const service = delivery(), storage = createMemoryStorage();
  const client = new AssetClient(config, { storage, fetch: service.fetch });
  const renderContract = Object.freeze({ width: 800, height: 500 });
  // Only the render contract is app-owned; the artwork key arrives as backend data.
  const backendAssignment = JSON.parse('{"artworkKey":"cards.platinum"}');
  const runtimeRef = Object.freeze({ key: backendAssignment.artworkKey, ...renderContract });
  const slot = (key, id, bytes) => ({ key, ...renderContract, screen: 'Wallet', assetId: id,
    sha256: hashBytes(bytes), url: `/api/delivery/${orgId}/${appId}/assets/${id}`, mime: 'image/webp', bytes: bytes.length });
  const classic = slot('cards.classic', assetId, bytes1);
  service.state.release = envelope(1, bytes1, { slots: [classic] });
  await client.refresh(); service.state.requests = [];
  assert.equal((await client.resolve(runtimeRef)).source, 'bundle');
  assert.equal(service.state.requests.length, 0, 'an unpublished assignment never becomes a URL');

  const newArtworkId = '44444444-4444-4444-8444-444444444444';
  const platinum = slot(backendAssignment.artworkKey, newArtworkId, bytes1);
  service.state.release = envelope(2, bytes1, { slots: [classic, platinum] });
  await client.refresh(); service.state.requests = [];
  const first = await client.resolve(runtimeRef);
  assert.equal(first.source, 'remote'); assert.equal(first.sequence, 2);
  assert.equal(first.assetId, newArtworkId); assert.equal(first.sha256, hashBytes(bytes1));
  assert.deepEqual(service.state.requests.map(request => new URL(request.url).pathname), [platinum.url]);
  assert.equal((await client.resolve(runtimeRef)).source, 'cache');
  assert.equal(service.state.requests.length, 1, 'only assigned artwork is downloaded and repeat access hits cache');

  // Publishing a new immutable asset rebinds the stable key; backend assignment stays identical.
  const replacementId = '55555555-5555-4555-8555-555555555555';
  const replacement = slot(backendAssignment.artworkKey, replacementId, bytes2);
  service.state.release = envelope(3, bytes2, { slots: [classic, replacement] }); service.state.bytes = bytes2;
  await client.refresh(); service.state.requests = [];
  const revised = await client.resolve(runtimeRef);
  assert.equal(revised.source, 'remote'); assert.equal(revised.sequence, 3);
  assert.equal(revised.assetId, replacementId); assert.equal(revised.sha256, hashBytes(bytes2));
  assert.notEqual(revised.sha256, first.sha256); assert.equal(runtimeRef.key, backendAssignment.artworkKey);
  assert.deepEqual(service.state.requests.map(request => new URL(request.url).pathname), [replacement.url]);

  service.state.offline = true; service.state.requests = [];
  const restarted = new AssetClient(config, { storage, fetch: service.fetch });
  assert.equal((await restarted.initialize()).sequence, 3);
  const offline = await restarted.resolve({ key: backendAssignment.artworkKey, ...renderContract });
  assert.equal(offline.source, 'cache'); assert.equal(offline.sequence, 3);
  assert.deepEqual(offline.bytes, bytes2); assert.equal(service.state.requests.length, 0);
});

test('runtime artwork keys cannot supply URLs or bypass the app-owned render dimensions', async () => {
  const service = delivery();
  const card = { key: 'cards.classic', width: 800, height: 500 };
  const published = { ...JSON.parse(envelope().payload).slots[0], ...card };
  service.state.release = envelope(1, bytes1, { slots: [published] });
  const client = new AssetClient(config, { storage: createMemoryStorage(), fetch: service.fetch });
  await client.refresh(); service.state.requests = [];
  assert.equal((await client.resolve({ ...card, key: 'cards.unknown' })).source, 'bundle');
  assert.equal((await client.resolve({ ...card, width: 801 })).source, 'bundle');
  assert.equal((await client.resolve({ ...card, height: 501 })).source, 'bundle');
  for (const key of ['https://attacker.example/image.webp', 'cards/escape', '', '.cards', 'a'.repeat(121)]) {
    await assert.rejects(client.resolve({ ...card, key }), /Invalid generated asset reference/);
  }
  for (const width of [0, 8193, 800.5, NaN, true]) await assert.rejects(client.resolve({ ...card, width }), /Invalid generated asset reference/);
  assert.equal(service.state.requests.length, 0, 'unknown, malformed or incompatible references never fetch bodies');
  // An extra caller-provided URL is ignored; only the independently signed descriptor can supply it.
  const resolved = await client.resolve({ ...card, url: 'https://attacker.example/image.webp' });
  assert.equal(resolved.source, 'remote');
  assert.deepEqual(service.state.requests.map(request => request.url), [new URL(published.url, config.manifestUrl).href]);
});
