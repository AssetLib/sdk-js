import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, randomUUID, sign } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AssetClient, createMemoryStorage, hashBytes, parsePublicConfig, verifyStoredState } from '../dist/index.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const appId = '22222222-2222-4222-8222-222222222222';
const keypair = generateKeyPairSync('ed25519');
const publicKey = keypair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
const config = parsePublicConfig({ schemaVersion: 1, orgId, appId, environment: 'production', manifestUrl: `https://assets.example/api/delivery/${orgId}/${appId}/manifest`, pinnedPublicKey: publicKey, keyId });
const ref = { key: 'screen.image', width: 1200, height: 900 };

function signed(payload) {
  return { algorithm: 'Ed25519', keyId, publicKey, payload, signature: sign(null, Buffer.from(payload), keypair.privateKey).toString('base64') };
}

function envelope(value) {
  return signed(JSON.stringify(value));
}

function body(bytes) {
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), { headers: { 'content-length': String(bytes.length) } });
}

function delivery(refs = [ref]) {
  let release;
  const assets = new Map();
  const service = {
    assetsFail: false,
    // `nestedDepth` adds an unknown field nested that deep; validators ignore unknown fields.
    publish(sequence, { nestedDepth = 0 } = {}) {
      const bytes = new TextEncoder().encode(`test-image-release-${sequence}`);
      const slots = refs.map(reference => {
        const assetId = randomUUID();
        const url = `/api/delivery/${orgId}/${appId}/assets/${assetId}`;
        assets.set(new URL(url, config.manifestUrl).href, bytes);
        return { ...reference, screen: 'Screen', assetId, sha256: hashBytes(bytes), url, mime: 'image/webp', bytes: bytes.length };
      });
      const payload = JSON.stringify({ schemaVersion: 1, orgId, appId, environment: 'production', sequence, createdAt: '2026-10-13T12:00:00.000Z', slots });
      release = signed(nestedDepth ? `${payload.slice(0, -1)},"nested":${'{"x":'.repeat(nestedDepth)}0${'}'.repeat(nestedDepth)}}` : payload);
    },
    async fetch(url) {
      if (url === config.manifestUrl) return body(new TextEncoder().encode(JSON.stringify(release)));
      if (service.assetsFail) return new Response(null, { status: 404 });
      const bytes = assets.get(url);
      assert.ok(bytes, `Unexpected delivery URL: ${url}`);
      return body(bytes);
    },
  };
  return service;
}

async function accept(client, service, sequence, options) {
  service.publish(sequence, options);
  assert.deepEqual(await client.refresh(), { updated: true, sequence });
}

async function assertStickyFailure(client, restore) {
  const result = await client.resolve(ref);
  assert.equal(result.source, 'bundle');
  assert.equal(result.fallbackReason, 'verification');
  const error = client.getStatus().lastError;
  assert.match(error, /Stored release state could not be verified/);
  await restore();
  const restored = await client.resolve(ref);
  assert.equal(restored.source, 'bundle');
  assert.equal(restored.fallbackReason, 'verification');
  assert.equal(client.getStatus().lastError, error, 'restoring valid storage must not clear the verification failure');
}

test('100 cached lookups with eight retained releases cost less than verifying the stored history five times, before and after a relaunch', async t => {
  const refs = Array.from({ length: 100 }, (_, index) => ({ key: `screen.image_${index}`, width: 1200, height: 900 }));
  const service = delivery(refs), storage = createMemoryStorage();
  const client = new AssetClient(config, { storage, fetch: service.fetch, cachePolicy: 'disk' });
  for (let sequence = 1; sequence <= 8; sequence++) await accept(client, service, sequence);
  const raw = await storage.loadState();
  assert.equal(JSON.parse(raw).history.length, 8);
  // Calibrate on this machine: one full check of the stored history is eight signature checks.
  const samples = [];
  for (let index = 0; index < 5; index++) {
    const started = performance.now();
    verifyStoredState(await storage.loadState(), config);
    samples.push(performance.now() - started);
  }
  const unit = samples.sort((a, b) => a - b)[2];
  // Fixed code takes about 0.1 units. Re-verifying on every lookup takes about 100.
  const secondPass = async (label, subject) => {
    for (const reference of refs) assert.notEqual((await subject.resolve(reference)).source, 'bundle');
    // Best of three, so one scheduler stall on a busy runner cannot fail correct code.
    let elapsed = Infinity;
    for (let pass = 0; pass < 3; pass++) {
      const results = [];
      const started = performance.now();
      for (const reference of refs) results.push(await subject.resolve(reference));
      elapsed = Math.min(elapsed, performance.now() - started);
      for (const result of results) assert.equal(result.source, 'cache');
    }
    t.diagnostic(`${label}: ${elapsed.toFixed(2)} ms for 100 cached lookups; one stored-history check takes ${unit.toFixed(2)} ms.`);
    assert.ok(elapsed < 5 * unit, `${label} took ${elapsed.toFixed(2)} ms; expected under ${(5 * unit).toFixed(2)} ms.`);
  };
  await secondPass('Refreshing client', client);
  const relaunched = new AssetClient(config, { storage, fetch: service.fetch, cachePolicy: 'disk' });
  assert.deepEqual(await relaunched.refresh(), { updated: false, sequence: 8 });
  await secondPass('Relaunched client', relaunched);
});

test('a release with deep unknown nesting is accepted, survives a relaunch, and a later rollback still fails closed', async () => {
  const service = delivery();
  let raw = null;
  // A writable state adapter models restoring an older storage snapshot exactly.
  const storage = { ...createMemoryStorage(), async loadState() { return raw; }, async saveState(value) { raw = value; } };
  const client = new AssetClient(config, { storage, fetch: service.fetch, cachePolicy: 'memory' });
  await accept(client, service, 1);
  const release1 = await storage.loadState();
  await accept(client, service, 2, { nestedDepth: 20_000 });
  assert.equal((await client.resolve(ref)).sequence, 2);
  const relaunched = new AssetClient(config, { storage, fetch: service.fetch, cachePolicy: 'memory' });
  assert.equal((await relaunched.resolve(ref)).sequence, 2);
  const release2 = await storage.loadState();
  await storage.saveState(release1);
  await assertStickyFailure(client, () => storage.saveState(release2));
});

test('only the eight retained releases are consulted after a ninth is accepted', async () => {
  const service = delivery(), storage = createMemoryStorage();
  // Disk policy keeps release 1's bytes in the shared storage, so the relaunch check below can fail.
  const client = new AssetClient(config, { storage, fetch: service.fetch, cachePolicy: 'disk' });
  await accept(client, service, 1);
  assert.equal((await client.resolve(ref)).sequence, 1);
  service.assetsFail = true;
  for (let sequence = 2; sequence <= 9; sequence++) await accept(client, service, sequence);
  assert.equal(JSON.parse(await storage.loadState()).history.length, 8);
  const result = await client.resolve(ref);
  assert.notEqual(result.sequence, 1);
  assert.equal(result.source, 'bundle', 'release 1 is no longer retained, so its cached bytes must not be used');
  const relaunched = new AssetClient(config, { storage, fetch: service.fetch, cachePolicy: 'disk' });
  assert.equal((await relaunched.resolve(ref)).source, 'bundle');
});

test('a client adopts newer shared storage on lookup without refreshing', async () => {
  const service = delivery(), storage = createMemoryStorage();
  const clientA = new AssetClient(config, { storage, fetch: service.fetch, cachePolicy: 'memory' });
  const clientB = new AssetClient(config, { storage, fetch: service.fetch, cachePolicy: 'memory' });
  await accept(clientA, service, 1);
  assert.equal((await clientA.resolve(ref)).sequence, 1);
  assert.equal((await clientB.resolve(ref)).sequence, 1);
  await accept(clientA, service, 2);
  const result = await clientB.resolve(ref);
  assert.notEqual(result.source, 'bundle');
  assert.equal(result.sequence, 2);
});

test('tampered retained storage fails closed after adoption and stays failed after repair', async () => {
  const service = delivery(), storage = createMemoryStorage();
  const client = new AssetClient(config, { storage, fetch: service.fetch, cachePolicy: 'memory' });
  await accept(client, service, 1);
  await accept(client, service, 2);
  assert.equal((await client.resolve(ref)).sequence, 2);
  const good = await storage.loadState();
  const tampered = JSON.parse(good);
  const payload = JSON.parse(tampered.history[1].payload);
  payload.slots[0].screen = 'Tampered';
  tampered.history[1].payload = JSON.stringify(payload);
  const serialized = JSON.stringify(tampered);
  assert.throws(() => verifyStoredState(serialized, config), /signature/);
  await storage.saveState(serialized);
  // A client that never accepted sequence 1 has no conflict check to fall back on.
  const fresh = new AssetClient(config, { storage, fetch: service.fetch, cachePolicy: 'memory' });
  const freshResult = await fresh.resolve(ref);
  assert.equal(freshResult.source, 'bundle');
  assert.equal(freshResult.fallbackReason, 'verification');
  await assertStickyFailure(client, () => storage.saveState(good));
});

test('stored state that moved backwards fails closed after adoption', async () => {
  const service = delivery(), storage = createMemoryStorage();
  let restored;
  const client = new AssetClient(config, { storage: { ...storage, loadState: () => restored === undefined ? storage.loadState() : Promise.resolve(restored) }, fetch: service.fetch, cachePolicy: 'memory' });
  await accept(client, service, 1);
  const older = await storage.loadState();
  await accept(client, service, 2);
  assert.equal((await client.resolve(ref)).sequence, 2);
  // The memory adapter rejects rollback writes; model restored storage at its read boundary.
  restored = older;
  await assertStickyFailure(client, () => { restored = undefined; });
});

test('stored state that disappeared fails closed after adoption', async () => {
  const service = delivery(), storage = createMemoryStorage();
  let disappeared = false;
  const client = new AssetClient(config, { storage: { ...storage, loadState: () => disappeared ? Promise.resolve(null) : storage.loadState() }, fetch: service.fetch, cachePolicy: 'memory' });
  await accept(client, service, 1);
  assert.equal((await client.resolve(ref)).sequence, 1);
  disappeared = true;
  await assertStickyFailure(client, () => { disappeared = false; });
});

test('validly signed stored history that conflicts with an accepted release fails closed', async () => {
  const service = delivery(), storage = createMemoryStorage();
  const client = new AssetClient(config, { storage, fetch: service.fetch, cachePolicy: 'memory' });
  await accept(client, service, 1);
  await accept(client, service, 2);
  assert.equal((await client.resolve(ref)).sequence, 2);
  const good = await storage.loadState();
  const conflicting = JSON.parse(good);
  const payload = JSON.parse(conflicting.history[1].payload);
  payload.slots[0].screen = 'Conflicting';
  conflicting.history[1] = envelope(payload);
  const serialized = JSON.stringify(conflicting);
  assert.equal(verifyStoredState(serialized, config).highestSequence, 2, 'the conflicting history is independently valid');
  await storage.saveState(serialized);
  await assertStickyFailure(client, () => storage.saveState(good));
});

test('twenty repeated cached resolutions return deep-equal results', async () => {
  const service = delivery(), storage = createMemoryStorage();
  const client = new AssetClient(config, { storage, fetch: service.fetch, cachePolicy: 'memory' });
  await accept(client, service, 1);
  assert.equal((await client.resolve(ref)).source, 'remote');
  const expected = await client.resolve(ref);
  assert.equal(expected.source, 'cache');
  for (let index = 1; index < 20; index++) assert.deepEqual(await client.resolve(ref), expected);
});
