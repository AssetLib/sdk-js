import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { AssetClient, createMemoryStorage, parsePublicConfig } from '../dist/index.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const appId = '22222222-2222-4222-8222-222222222222';
const deliveryPath = `/api/delivery/${orgId}/${appId}`;
const key = generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
const config = parsePublicConfig({ schemaVersion: 1, orgId, appId, environment: 'production', manifestUrl: `https://assets.example${deliveryPath}/environments/production/manifest`, pinnedPublicKey: publicKey });

const assetId = '33333333-3333-4333-8333-333333333333';
const slot = { key: 'home.hero', screen: 'Home', width: 600, height: 400, assetId, sha256: 'a'.repeat(64), url: `${deliveryPath}/assets/${assetId}`, mime: 'image/webp', bytes: 1 };
function envelope(sequence, note = '') {
  const payload = JSON.stringify({ schemaVersion: 1, orgId, appId, environment: 'production', sequence, createdAt: '2026-10-25T06:00:00.000Z', slots: [slot], ...(note ? { note } : {}) });
  return { algorithm: 'Ed25519', keyId, publicKey, payload, signature: sign(null, Buffer.from(payload), key.privateKey).toString('base64') };
}
const etagOf = body => `"${createHash('sha256').update(body).digest('hex')}"`;

/** A delivery service that answers If-None-Match like the console: 304 when the validator matches the current body. */
function service(initial) {
  const state = { body: JSON.stringify(initial), calls: [] };
  state.fetch = async (input, init) => {
    const ifNoneMatch = init.headers['If-None-Match'] ?? null;
    state.calls.push(ifNoneMatch);
    if (ifNoneMatch === etagOf(state.body)) return new Response(null, { status: 304, headers: { ETag: etagOf(state.body) } });
    return new Response(state.body, { headers: { ETag: etagOf(state.body), 'Content-Type': 'application/json' } });
  };
  state.publish = next => { state.body = JSON.stringify(next); };
  return state;
}

test('a refresh after an accepted release is conditional and a 304 counts as the same release', async () => {
  const remote = service(envelope(1));
  const client = new AssetClient(config, { storage: createMemoryStorage(), fetch: remote.fetch });
  assert.deepEqual(await client.refresh(), { updated: true, sequence: 1 });
  assert.deepEqual(await client.refresh(), { updated: false, sequence: 1 });
  assert.deepEqual(await client.refresh(), { updated: false, sequence: 1 });
  assert.deepEqual(remote.calls, [null, etagOf(remote.body), etagOf(remote.body)], 'the first request is unconditional, later ones send the accepted ETag');
  assert.deepEqual(client.getStatus(), { initialized: true, sequence: 1, lastError: null });
});

test('a changed manifest answers 200 with a new release, and the next refresh sends the new ETag', async () => {
  const remote = service(envelope(1));
  const client = new AssetClient(config, { storage: createMemoryStorage(), fetch: remote.fetch });
  await client.refresh();
  const first = etagOf(remote.body);
  remote.publish(envelope(2));
  assert.deepEqual(await client.refresh(), { updated: true, sequence: 2 });
  assert.deepEqual(await client.refresh(), { updated: false, sequence: 2 });
  assert.deepEqual(remote.calls, [null, first, etagOf(remote.body)]);
});

test('a 304 to an unconditional request fails like any other unexpected status', async () => {
  const calls = [];
  const client = new AssetClient(config, { storage: createMemoryStorage(), fetch: async (input, init) => { calls.push(init.headers['If-None-Match'] ?? null); return new Response(null, { status: 304 }); } });
  const result = await client.refresh();
  assert.equal(result.updated, false);
  assert.equal(result.sequence, 0);
  assert.match(result.error, /returned 304/);
  assert.deepEqual(calls, [null]);
});

test('a rejected envelope is never remembered as an ETag', async () => {
  const remote = service(envelope(1));
  const client = new AssetClient(config, { storage: createMemoryStorage(), fetch: remote.fetch });
  await client.refresh();
  const accepted = etagOf(remote.body);
  remote.publish(envelope(1, 'equivocation'));
  const conflict = await client.refresh();
  assert.match(conflict.error, /reused an existing release sequence/);
  assert.deepEqual(await client.refresh(), { updated: false, sequence: 1, error: 'Conflicting content reused an existing release sequence.' });
  assert.deepEqual(remote.calls, [null, accepted, accepted], 'the validator of the accepted release keeps being sent, never the rejected one');
});

test('a shared-storage client that moved ahead stops sending the stale ETag', async () => {
  const storage = createMemoryStorage();
  const remote = service(envelope(1));
  const a = new AssetClient(config, { storage, fetch: remote.fetch });
  const b = new AssetClient(config, { storage, fetch: remote.fetch });
  await a.refresh();
  await b.refresh();
  remote.publish(envelope(2));
  assert.deepEqual(await b.refresh(), { updated: true, sequence: 2 });
  // Client a still holds sequence 1 in memory with its ETag, but durable state is at 2: its next refresh must not pretend
  // the service's answer about release 1 applies, so it goes unconditional and learns release 2.
  remote.calls.length = 0;
  const result = await a.refresh();
  assert.equal(result.sequence, 2);
  assert.deepEqual(remote.calls, [null]);
});

test('ETags that are not quoted validators or are oversized are ignored', async () => {
  for (const etag of ['unquoted', `"${'x'.repeat(201)}"`, '']) {
    const calls = [];
    const client = new AssetClient(config, { storage: createMemoryStorage(), fetch: async (input, init) => { calls.push(init.headers['If-None-Match'] ?? null); return new Response(JSON.stringify(envelope(1)), { headers: etag ? { ETag: etag } : {} }); } });
    await client.refresh();
    await client.refresh();
    assert.deepEqual(calls, [null, null], `an ETag of ${JSON.stringify(etag)} is not sent back`);
  }
  const weak = [];
  const client = new AssetClient(config, { storage: createMemoryStorage(), fetch: async (input, init) => { weak.push(init.headers['If-None-Match'] ?? null); return new Response(JSON.stringify(envelope(1)), { headers: { ETag: 'W/"abc"' } }); } });
  await client.refresh();
  await client.refresh();
  assert.deepEqual(weak, [null, 'W/"abc"'], 'a weak validator is sent back as given');
});

test('a stored-state failure after an ETag was remembered fails closed without a conditional request', async () => {
  const storage = createMemoryStorage();
  const remote = service(envelope(1));
  const client = new AssetClient(config, { storage, fetch: remote.fetch });
  assert.deepEqual(await client.refresh(), { updated: true, sequence: 1 });
  await storage.saveState(JSON.stringify({ version: 1, highestSequence: 1, history: [{ ...envelope(1), signature: 'A'.repeat(86) + '==' }] }));
  remote.calls.length = 0;
  const result = await client.refresh();
  assert.equal(result.updated, false);
  assert.match(result.error, /could not be verified/);
  assert.deepEqual(remote.calls, [], 'no request leaves while durable state cannot be trusted');
});
