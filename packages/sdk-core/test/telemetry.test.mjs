import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { AssetClient, createMemoryStorage, hashBytes } from '../dist/index.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const appId = '22222222-2222-4222-8222-222222222222';
const basePath = `/api/delivery/${orgId}/${appId}`;
const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyId = hashBytes(new TextEncoder().encode(publicKey)).slice(0, 16);
const ref = { key: 'travel.coast', width: 1200, height: 900 };
const telemetry = { enabled: true, installId: 'test-install-1234', flushIntervalMs: 60_000 };
// The default reported SDK version must follow every release bump of this package.
const packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const signed = data => {
  const payload = JSON.stringify(data);
  return { algorithm: 'Ed25519', keyId, publicKey, payload, signature: sign(null, Buffer.from(payload), pair.privateKey).toString('base64') };
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let loopbackUnavailable = false;

async function receiver(t, options = {}) {
  const bodies = [], requests = [], assets = new Map();
  const state = { status: 202, gate: null, assetMode: 'ok', corruptManifest: false, offlineAssets: new Set() };
  const descriptor = number => {
    const assetId = `33333333-3333-4333-8333-${String(number).padStart(12, '0')}`;
    const bytes = Buffer.from(`verified-artwork-${number}`);
    const url = `${basePath}/assets/${assetId}`;
    assets.set(url, bytes);
    return { assetId, sha256: hashBytes(bytes), url, mime: 'image/webp', bytes: bytes.length };
  };
  const image = descriptor(1);
  const manifest = { schemaVersion: 1, orgId, appId, environment: 'production', sequence: 1, createdAt: '2026-10-08T12:00:00Z', slots: [{ ...ref, screen: 'Travel', ...image }] };
  // Both transports exercise the same HTTP request/response handler. Restricted
  // build environments can validate the protocol without opening a socket.
  const handle = async request => {
    const url = new URL(request.url), path = url.pathname + url.search;
    requests.push({ method: request.method, path, headers: Object.fromEntries(request.headers) });
    if (path === `${basePath}/observations`) {
      const raw = Buffer.from(await request.arrayBuffer());
      bodies.push({ raw, body: JSON.parse(raw.toString()) });
      if (state.gate) await state.gate.promise;
      return Response.json({ accepted: bodies.at(-1).body.events.length, dropped: 0 }, { status: state.status });
    }
    if (path.endsWith('/manifest')) {
      const envelope = signed(manifest);
      if (state.corruptManifest) envelope.signature = 'A'.repeat(86) + '==';
      return Response.json(envelope);
    }
    if (path.startsWith(`${basePath}/releases/`)) {
      return Response.json(signed({ kind: 'asset-page', schemaVersion: 1, orgId, appId, environment: 'production', sequence: 1, createdAt: manifest.createdAt, assets: [{ ...image, width: ref.width, height: ref.height }], cursor: null, nextCursor: null }));
    }
    if (assets.has(path)) {
      if (state.assetMode === 'offline' || state.offlineAssets.has(path)) throw new TypeError('fetch failed');
      if (state.assetMode === 'missing') return new Response(null, { status: 404 });
      return new Response(state.assetMode === 'corrupt' ? Buffer.alloc(assets.get(path).length) : assets.get(path));
    }
    return new Response(null, { status: 404 });
  };
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const result = await handle(new Request(`http://127.0.0.1:${server.address().port}${request.url}`, { method: request.method, headers: request.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch { request.socket.destroy(); }
  });
  if (!loopbackUnavailable) {
    server.listen(0, '127.0.0.1');
    try { await once(server, 'listening'); }
    catch (error) {
      if (error.code !== 'EPERM' || process.env.ASSETLIB_TEST_REQUIRE_HTTP === '1') throw error;
      loopbackUnavailable = true;
      t.diagnostic('Loopback sockets unavailable (EPERM); testing the mock HTTP receiver in process.');
    }
  }
  t.after(async () => {
    state.gate?.resolve();
    if (server.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
  const config = { schemaVersion: 1, orgId, appId, environment: 'production', manifestUrl: `http://127.0.0.1:${server.address()?.port ?? 3100}${basePath}/manifest`, pinnedPublicKey: publicKey };
  const fetcher = loopbackUnavailable ? async (input, init) => handle(new Request(input, init)) : globalThis.fetch;
  const storage = options.storage ?? createMemoryStorage();
  const client = new AssetClient(config, { storage, allowInsecureLoopback: true, fetch: fetcher, ...options });
  t.after(() => client.dispose());
  return { client, config, storage, state, bodies, requests, manifest, image, descriptor, fetch: fetcher };
}

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('Timed out waiting for mock observation request.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('telemetry is opt-in: disabled clients create no identity and send no observations', async t => {
  let identityCalls = 0;
  const storage = { ...createMemoryStorage(), async getOrCreateInstallId() { identityCalls++; throw new Error('must not run'); } };
  const h = await receiver(t, { storage });
  const bundle = await h.client.resolve(ref);
  h.client.reportDisplay(ref, bundle);
  h.client.reportFallback(ref, bundle, 'decode');
  await h.client.flush();
  assert.equal(h.requests.length, 0);
  await h.client.refresh();
  const image = await h.client.resolve(ref);
  h.client.reportDisplay(ref, image);
  await h.client.flush();
  assert.equal(h.bodies.length, 0);
  assert.equal(identityCalls, 0);
});

test('mock server receives only contract fields with coalesced resolve and explicit display events', async t => {
  const h = await receiver(t, { telemetry: { ...telemetry, build: { platform: 'ios', appVersion: '1.6.0', buildNumber: '231', secret: 'private' }, sdk: { name: 'sdk-custom', version: '0.3.0-preview.1', secret: 'private' } } });
  await h.client.refresh();
  const remote = await h.client.resolve(ref);
  await h.client.resolve(ref); await h.client.resolve(ref);
  assert.equal(h.bodies.length, 0, 'resolution records in memory without sending');
  h.client.reportDisplay(ref, { ...remote, customerEmail: 'private@example.test' });
  h.client.reportDisplay(ref, remote);
  await h.client.flush();
  assert.equal(h.bodies.length, 1);
  const batch = h.bodies[0].body;
  assert.deepEqual(Object.keys(batch).sort(), ['build', 'environment', 'events', 'installId', 'schemaVersion', 'sdk', 'sentAt']);
  assert.equal(batch.schemaVersion, 1); assert.equal(batch.environment, 'production');
  assert.deepEqual(batch.sdk, { name: 'sdk-custom', version: '0.3.0-preview.1' });
  assert.deepEqual(batch.build, { platform: 'ios', appVersion: '1.6.0', buildNumber: '231' });
  assert.equal(batch.installId, telemetry.installId);
  assert.ok(Math.abs(Date.now() - Date.parse(batch.sentAt)) < 5000);
  assert.equal(batch.events.find(event => event.kind === 'resolve' && event.source === 'remote').count, 1);
  assert.equal(batch.events.find(event => event.kind === 'resolve' && event.source === 'cache').count, 2);
  assert.equal(batch.events.find(event => event.kind === 'display').count, 2);
  for (const event of batch.events) {
    assert.equal(event.key, ref.key); assert.equal(event.assetId, h.image.assetId); assert.equal(event.sequence, 1);
    assert.ok(Object.keys(event).every(key => ['kind', 'key', 'assetId', 'sequence', 'source', 'arm', 'appearance', 'count'].includes(key)));
  }
  assert.doesNotMatch(h.bodies[0].raw.toString(), /private|sha256|bytes|message|cacheKey|armSource/);
  const request = h.requests.find(request => request.method === 'POST');
  assert.equal(request.path, `${basePath}/observations`);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers.authorization, undefined);
  await h.client.flush(); assert.equal(h.bodies.length, 1, 'empty flush sends no request');
});

test('a failed flush keeps counts; overlapping flushes send once and preserve events added in flight', async t => {
  const h = await receiver(t, { telemetry });
  await h.client.refresh();
  const image = await h.client.resolve(ref);
  h.client.reportDisplay(ref, image);
  h.state.status = 503;
  await assert.doesNotReject(h.client.flush());
  assert.equal(h.bodies.length, 1);
  h.state.status = 202;
  h.state.gate = deferred();
  const first = h.client.flush(), second = h.client.flush();
  await until(() => h.bodies.length === 2);
  h.client.reportDisplay(ref, image);
  await h.client.resolve(ref);
  h.state.gate.resolve(); h.state.gate = null;
  await Promise.all([first, second]);
  assert.deepEqual(h.bodies[0].body.events, h.bodies[1].body.events);
  assert.equal(h.bodies.length, 2);
  await h.client.flush();
  assert.deepEqual(h.bodies[2].body.events.map(event => [event.kind, event.source, event.count]).sort(), [['display', 'remote', 1], ['resolve', 'cache', 1]].sort());
});

test('the configured batch cap drains one bounded batch per flush', async t => {
  const h = await receiver(t, { telemetry: { ...telemetry, maxBatch: 2 } });
  for (let i = 0; i < 6; i++) await h.client.resolve({ ...ref, key: `travel.slot${i}` });
  for (let i = 0; i < 3; i++) await h.client.flush();
  assert.equal(h.bodies.length, 3);
  assert.ok(h.bodies.every(({ raw, body }) => raw.length <= 64 * 1024 && body.events.length === 2));
  assert.equal(h.bodies.flatMap(({ body }) => body.events).length, 6);
  await h.client.flush(); assert.equal(h.bodies.length, 3);
});

test('the shared 200-event and 10000-count limits apply even to larger configured limits', async t => {
  const h = await receiver(t, { telemetry: { ...telemetry, maxBatch: 1000 } });
  await h.client.refresh(); const image = await h.client.resolve(ref); await h.client.flush(); h.bodies.length = 0;
  for (let i = 0; i < 10_001; i++) h.client.reportDisplay(ref, image);
  await h.client.flush();
  await h.client.flush();
  const counted = h.bodies.flatMap(({ body }) => body.events);
  assert.equal(counted.reduce((sum, event) => sum + event.count, 0), 10_001);
  assert.ok(counted.every(event => event.count >= 1 && event.count <= 10_000));
  h.bodies.length = 0;
  for (let i = 0; i < 205; i++) h.client.reportDisplay({ ...ref, key: `placement.${i}` }, image);
  await h.client.flush();
  assert.equal(h.bodies.length, 1); assert.equal(h.bodies[0].body.events.length, 200);
  await h.client.flush(); assert.equal(h.bodies[1].body.events.length, 5);
  assert.ok(h.bodies.every(({ raw }) => raw.length <= 64 * 1024));
});

test('pending observation coordinates are bounded when delivery stays unavailable', async t => {
  const h = await receiver(t, { telemetry });
  await h.client.refresh(); const image = await h.client.resolve(ref); await h.client.flush(); h.bodies.length = 0;
  for (let i = 0; i < 2100; i++) h.client.reportDisplay({ ...ref, key: `placement.${i}` }, image);
  for (let i = 0; i < 11; i++) await h.client.flush();
  assert.equal(h.bodies.flatMap(({ body }) => body.events).length, 2000);
});

test('JSON-escaped identifiers and maximal coordinates cannot produce a batch over 64 KiB', async t => {
  const h = await receiver(t, { telemetry: { ...telemetry, installId: '\u0000'.repeat(64), sdk: { name: 's'.repeat(64), version: 'v'.repeat(64) }, build: { platform: 'android', appVersion: 'v'.repeat(64), buildNumber: 'b'.repeat(64) } } });
  await h.client.refresh(); const resolved = await h.client.resolve(ref); await h.client.flush(); h.bodies.length = 0;
  const image = { ...resolved, sequence: 2_147_483_647, arm: 'b'.repeat(20), appearance: 'light' };
  for (let i = 0; i < 200; i++) {
    const placement = { ...ref, key: `placement.${i}`.padEnd(120, 'x') };
    for (let count = 0; count < 100; count++) h.client.reportFallback(placement, image, 'verification');
  }
  await h.client.flush();
  assert.ok(h.bodies[0].body.events.length < 200, 'the byte bound reduces the event-count cap');
  await h.client.flush();
  assert.ok(h.bodies.every(({ raw }) => raw.length <= 64 * 1024));
  assert.equal(h.bodies.flatMap(({ body }) => body.events).reduce((sum, event) => sum + event.count, 0), 20_000);
});

test('invalid optional telemetry metadata never changes artwork resolution', async t => {
  for (const invalid of [
    { installId: 'short' },
    { installId: 'x'.repeat(65) },
    { build: { platform: 'macos', appVersion: '1', buildNumber: '1' } },
    { build: { platform: 'ios', appVersion: 'invalid version', buildNumber: '1' } },
    { sdk: { name: 'sdk-core', version: 'x'.repeat(65) } },
    { sdk: { name: 'sdk-core', version: '1\n' } },
  ]) {
    const h = await receiver(t, { telemetry: { ...telemetry, ...invalid } });
    await h.client.refresh();
    assert.equal((await h.client.resolve(ref)).source, 'remote');
    await assert.doesNotReject(h.client.flush()); assert.equal(h.bodies.length, 0);
  }
});

test('install metadata I/O remains independent of resolution; disposal drops pending observations', async t => {
  const identity = deferred();
  const h = await receiver(t, { storage: { ...createMemoryStorage(), getOrCreateInstallId: () => identity.promise }, telemetry: { enabled: true } });
  await h.client.refresh();
  assert.equal((await h.client.resolve(ref)).source, 'remote');
  const flushing = h.client.flush();
  assert.equal((await h.client.resolve(ref)).source, 'cache');
  h.client.dispose(); identity.resolve('a'.repeat(32));
  await flushing;
  const result = await h.client.resolve(ref);
  h.client.reportDisplay(ref, result); await h.client.flush();
  assert.equal(h.bodies.length, 0);
});

test('generated install ids persist across concurrent clients and are scoped by app, not environment', async t => {
  const h = await receiver(t, { telemetry: { enabled: true } });
  const other = new AssetClient(h.config, { storage: h.storage, fetch: h.fetch, allowInsecureLoopback: true, telemetry: { enabled: true } });
  await Promise.all([h.client.resolve(ref), other.resolve(ref)]);
  await Promise.all([h.client.flush(), other.flush()]);
  const firstId = h.bodies[0].body.installId;
  assert.match(firstId, /^[a-f0-9]{32}$/);
  assert.ok(h.bodies.every(({ body }) => body.installId === firstId));
  const staging = { ...h.config, environment: 'staging', manifestUrl: h.config.manifestUrl.replace('/manifest', '/environments/staging/manifest') };
  const restarted = new AssetClient(staging, { storage: h.storage, fetch: h.fetch, allowInsecureLoopback: true, telemetry: { enabled: true } });
  await restarted.resolve(ref); await restarted.flush();
  assert.equal(h.bodies.at(-1).body.installId, firstId);
  assert.equal(h.bodies.at(-1).body.environment, 'staging');
  const reset = new AssetClient(h.config, { storage: createMemoryStorage(), fetch: h.fetch, allowInsecureLoopback: true, telemetry: { enabled: true } });
  await reset.resolve(ref); await reset.flush();
  assert.notEqual(h.bodies.at(-1).body.installId, firstId);
});

test('missing or failing install-id persistence never affects resolution or sends an unstable identity', async t => {
  for (const persist of [undefined, async () => { throw new Error('disk full'); }]) {
    const storage = { ...createMemoryStorage(), getOrCreateInstallId: persist };
    const h = await receiver(t, { storage, telemetry: { enabled: true } });
    await h.client.refresh();
    assert.equal((await h.client.resolve(ref)).source, 'remote');
    await assert.doesNotReject(h.client.flush()); assert.equal(h.bodies.length, 0);
    const explicit = new AssetClient(h.config, { storage, fetch: h.fetch, allowInsecureLoopback: true, telemetry });
    assert.equal((await explicit.resolve(ref)).source, 'cache');
    await explicit.flush(); assert.equal(h.bodies[0].body.installId, telemetry.installId);
  }
});

test('default SDK/build metadata and missing, offline, verification and decode fallback reasons are bounded', async t => {
  const h = await receiver(t, { telemetry, cachePolicy: 'none' });
  const bundle = await h.client.resolve(ref);
  h.client.reportDisplay(ref, bundle);
  await h.client.flush();
  const initial = h.bodies[0].body;
  assert.deepEqual(initial.sdk, { name: 'sdk-core', version: packageVersion });
  assert.deepEqual(initial.build, { platform: 'web', appVersion: 'unknown', buildNumber: 'unknown' });
  assert.equal(initial.events.find(event => event.kind === 'fallback').reason, 'missing');
  assert.equal(initial.events.some(event => event.kind === 'display'), false);
  assert.equal(initial.events.some(event => event.kind === 'resolve'), false);
  assert.ok(initial.events.every(event => !('assetId' in event) && !('sequence' in event)));
  await h.client.refresh();
  for (const [mode, reason] of [['offline', 'offline'], ['corrupt', 'verification'], ['missing', 'missing']]) {
    h.state.assetMode = mode;
    assert.equal((await h.client.resolve(ref)).source, 'bundle');
    await h.client.flush();
    assert.equal(h.bodies.at(-1).body.events.find(event => event.kind === 'fallback').reason, reason);
  }
  h.state.assetMode = 'ok'; const image = await h.client.resolve(ref);
  h.client.reportFallback(ref, image, 'decode'); await h.client.flush();
  const decode = h.bodies.at(-1).body.events.find(event => event.kind === 'fallback');
  assert.equal(decode.reason, 'decode'); assert.equal(decode.assetId, image.assetId); assert.equal(decode.sequence, 1);
});

test('observations use the effective selected arm and appearance, including control-any fallback', async t => {
  const h = await receiver(t, { telemetry });
  h.manifest.variantSchemaVersion = 1;
  h.manifest.slots[0].variants = { arm: ['b'], appearance: ['dark'] };
  h.manifest.slots[0].cells = [{ ...h.descriptor(2), arm: 'b', appearance: 'dark' }];
  await h.client.refresh();
  const selected = await h.client.resolve(ref, { arm: 'b', appearance: 'dark' });
  h.client.reportDisplay(ref, selected);
  await h.client.resolve(ref, { arm: 'b', appearance: 'light' });
  await h.client.flush();
  const events = h.bodies[0].body.events;
  const cell = events.filter(event => event.assetId === selected.assetId);
  assert.equal(cell.length, 2); assert.ok(cell.every(event => event.arm === 'b' && event.appearance === 'dark'));
  const control = events.find(event => event.assetId === h.image.assetId);
  assert.equal(control.arm, undefined); assert.equal(control.appearance, undefined);
});

test('state sets report only committed members and never partially resolved discarded family members', async t => {
  const h = await receiver(t, { telemetry });
  const stateRef = { ...ref, states: ['empty', 'growing'] };
  h.manifest.stateSchemaVersion = 1;
  h.manifest.slots[0].states = { empty: h.image, growing: h.descriptor(2) };
  h.manifest.slots[0].defaultState = 'empty';
  await h.client.refresh();
  const result = await h.client.resolveStateSet(stateRef);
  await h.client.flush();
  assert.deepEqual(h.bodies[0].body.events.map(event => event.assetId).sort(), Object.values(result.states).map(value => value.assetId).sort());
  assert.ok(h.bodies[0].body.events.every(event => event.kind === 'resolve' && event.source === 'remote'));
  h.state.offlineAssets.add(h.manifest.slots[0].states.growing.url);
  const failed = await h.client.resolveStateSet(stateRef, { cachePolicy: 'none' });
  assert.equal(failed.source, 'bundle'); await h.client.flush();
  assert.equal(h.bodies[1].body.events.filter(event => event.kind === 'resolve').length, 0);
  assert.equal(h.bodies[1].body.events.find(event => event.kind === 'fallback').reason, 'offline');
});

test('dynamic catalog handles emit no observations because the contract requires a placement key', async t => {
  const h = await receiver(t, { telemetry });
  h.manifest.catalogSchemaVersion = 1; h.manifest.catalog = { url: `${basePath}/releases/1/assets`, count: 1 };
  await h.client.refresh(); const page = await h.client.loadAssetPage();
  const result = await h.client.resolveAsset(page.items[0]);
  h.client.reportDisplay(page.items[0], result);
  h.client.reportFallback(page.items[0], result, 'decode');
  await h.client.flush();
  assert.equal(h.bodies.length, 0);
});

test('refresh triggers a nonblocking flush and pending events also flush on the interval', async t => {
  const h = await receiver(t, { telemetry });
  await h.client.resolve(ref); h.state.gate = deferred();
  assert.equal((await h.client.refresh()).updated, true);
  await until(() => h.bodies.length === 1);
  h.state.gate.resolve(); h.state.gate = null; await h.client.flush();
  const automatic = await receiver(t, { telemetry: { ...telemetry, flushIntervalMs: 20 } });
  await automatic.client.resolve(ref);
  await until(() => automatic.bodies.length === 1);
  await automatic.client.flush();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(automatic.bodies.length, 1, 'the timer does not send empty batches');
});

test('a stalled observation request times out after five seconds without failing the client', async t => {
  const h = await receiver(t, { telemetry });
  await h.client.resolve(ref); h.state.gate = deferred();
  const start = Date.now(); await assert.doesNotReject(h.client.flush());
  assert.ok(Date.now() - start >= 4900); assert.ok(Date.now() - start < 7000);
  h.state.gate.resolve(); h.state.gate = null;
  await new Promise(resolve => setTimeout(resolve, 20));
  await h.client.flush(); assert.equal(h.bodies.length, 2);
  assert.deepEqual(h.bodies[0].body.events, h.bodies[1].body.events);
});
