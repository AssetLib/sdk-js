import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { AssetClient, createMemoryStorage, parsePublicConfig, verifySignedManifest, verifySignedAssetPage } from '../dist/index.js';

const fixture = name => readFile(new URL(`./fixtures/${name}`, import.meta.url));
const json = async name => JSON.parse(await fixture(name));
const legacyInput = await json('config.json');
const setInput = await json('pinned-keys/config.json');
const legacyConfig = parsePublicConfig(legacyInput);
const config = parsePublicConfig(setInput);
const first = await json('manifests/valid-seq1.json');
const second = await json('pinned-keys/manifests/second-key-seq2.json');
const outside = await json('pinned-keys/manifests/outside-key-seq2.json');
const keyId = pem => createHash('sha256').update(pem).digest('hex').slice(0, 16);
const privateKey = async name => createPrivateKey({
  key: Buffer.from(`302e020100300506032b657004220420${(await fixture(name)).toString().trim()}`, 'hex'),
  format: 'der', type: 'pkcs8',
});
const originalPrivateKey = await privateKey('keys/TEST_ONLY_seed.hex');
const secondPrivateKey = await privateKey('pinned-keys/keys/TEST_ONLY_second_seed.hex');
const outsidePrivateKey = await privateKey('pinned-keys/keys/TEST_ONLY_outside_seed.hex');
const signed = (value, key = secondPrivateKey) => {
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  const publicKey = createPublicKey(key).export({ format: 'pem', type: 'spki' }).toString();
  return { algorithm: 'Ed25519', keyId: keyId(publicKey), publicKey, payload, signature: sign(null, Buffer.from(payload), key).toString('base64') };
};
const setOnly = () => {
  const { pinnedPublicKey, keyId, ...input } = structuredClone(setInput);
  return input;
};

test('key-set fixtures are reproducible Node signatures with complete SHA256SUMS entries', async () => {
  const payload = (await fixture('payloads/seq2.utf8')).toString();
  for (const [name, envelope, key] of [['second', second, secondPrivateKey], ['outside', outside, outsidePrivateKey]]) {
    assert.equal(envelope.payload, payload);
    assert.equal(envelope.publicKey, (await fixture(`pinned-keys/keys/TEST_ONLY_${name}_public.pem`)).toString());
    assert.deepEqual(envelope, signed(payload, key));
    assert.equal(verify(null, Buffer.from(envelope.payload), envelope.publicKey, Buffer.from(envelope.signature, 'base64')), true);
  }
  assert.notEqual(second.keyId, first.keyId);
  assert.notEqual(outside.keyId, second.keyId);
  const sums = new Map((await fixture('SHA256SUMS')).toString().trim().split('\n').map(line => [line.slice(66), line.slice(0, 64)]));
  async function checkDirectory(prefix) {
    for (const entry of await readdir(new URL(`./fixtures/${prefix}`, import.meta.url), { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await checkDirectory(name);
      else assert.equal(sums.get(name), createHash('sha256').update(await fixture(name)).digest('hex'), name);
    }
  }
  await checkDirectory('pinned-keys');
  for (const entry of (await json('pinned-keys/cases.json')).manifests) {
    const envelope = await json(`pinned-keys/${entry.file}`);
    if (entry.verification === 'accept') assert.doesNotThrow(() => verifySignedManifest(envelope, config), entry.file);
    else assert.throws(() => verifySignedManifest(envelope, config), /envelope/, entry.file);
  }
});

test('legacy single-key configurations retain their exact parsed shape and trust boundary', () => {
  assert.deepEqual(legacyConfig, legacyInput);
  const { keyId, ...withoutId } = legacyInput;
  assert.deepEqual(parsePublicConfig(withoutId), legacyInput);
  assert.equal(Object.hasOwn(legacyConfig, 'pinnedPublicKeys'), false);
  assert.equal(Object.hasOwn(legacyConfig, 'keyIds'), false);
  assert.equal(verifySignedManifest(first, legacyConfig).payload.sequence, 1);
  assert.throws(() => verifySignedManifest(second, legacyConfig), /envelope/);
  assert.throws(() => verifySignedManifest(outside, legacyConfig), /envelope/);
});

test('both-key and set-only configurations accept every pinned key and derive ordered IDs', () => {
  assert.deepEqual(config, setInput);
  const only = parsePublicConfig(setOnly());
  assert.equal(Object.hasOwn(only, 'pinnedPublicKey'), false);
  assert.equal(Object.hasOwn(only, 'keyId'), false);
  assert.deepEqual(only.pinnedPublicKeys, setInput.pinnedPublicKeys);
  assert.deepEqual(only.keyIds, setInput.pinnedPublicKeys.map(keyId));
  const { keyIds, ...withoutIds } = setOnly();
  assert.deepEqual(parsePublicConfig(withoutIds), only);
  const singleWithIds = parsePublicConfig({ ...legacyInput, keyIds: [legacyInput.keyId] });
  assert.deepEqual(singleWithIds, { ...legacyInput, keyIds: [legacyInput.keyId] });
  const reversed = parsePublicConfig({ ...withoutIds, pinnedPublicKeys: [...withoutIds.pinnedPublicKeys].reverse() });
  assert.deepEqual(reversed.keyIds, [...only.keyIds].reverse());
  for (const trusted of [config, only, reversed]) {
    assert.equal(verifySignedManifest(first, trusted).payload.sequence, 1);
    assert.equal(verifySignedManifest(second, trusted).payload.sequence, 2);
    assert.throws(() => verifySignedManifest(outside, trusted), /envelope/);
  }
});

test('configuration requires pins, exact single-key membership, and valid Ed25519 keys', () => {
  const { pinnedPublicKey, keyId, ...withoutSingle } = legacyInput;
  assert.throws(() => parsePublicConfig(withoutSingle));
  for (const pinnedPublicKeys of [null, {}, '', [], [undefined], [null], [0], [''], ['invalid'], ['x'.repeat(257)], Array(1)]) {
    assert.throws(() => parsePublicConfig({ ...legacyInput, pinnedPublicKeys }), undefined, JSON.stringify(pinnedPublicKeys));
  }
  for (const pinnedPublicKey of [null, 0, '', outside.publicKey, first.publicKey.trimEnd()]) {
    assert.throws(() => parsePublicConfig({ ...setInput, pinnedPublicKey }), undefined, String(pinnedPublicKey));
  }
  const wrongAlgorithm = second.publicKey.replace('MCowBQYDK2Vw', 'MCowBQYDK2Vx');
  assert.throws(() => parsePublicConfig({ ...setOnly(), pinnedPublicKeys: [wrongAlgorithm] }), /Ed25519/);
});

test('key IDs cannot disagree with their PEMs, order, or single-key association', () => {
  for (const keyIds of [null, {}, '', [], [first.keyId], [...setInput.keyIds].reverse(), [first.keyId, '0'.repeat(16)], [first.keyId, 0], [...setInput.keyIds, outside.keyId], Array(2)]) {
    assert.throws(() => parsePublicConfig({ ...setInput, keyIds }), undefined, JSON.stringify(keyIds));
  }
  assert.throws(() => parsePublicConfig({ ...setInput, keyId: second.keyId }));
  assert.throws(() => parsePublicConfig({ ...setOnly(), keyId: first.keyId }));
  assert.throws(() => parsePublicConfig({ ...legacyInput, keyIds: [second.keyId] }));
});

test('parsing copies key and ID arrays so caller mutation cannot extend client trust', async () => {
  const input = structuredClone(setInput);
  const parsed = parsePublicConfig(input);
  const client = new AssetClient(input, { storage: createMemoryStorage(), fetch: async () => new Response(JSON.stringify(outside)) });
  input.pinnedPublicKeys.push(outside.publicKey);
  input.keyIds.push(outside.keyId);
  input.pinnedPublicKeys[1] = outside.publicKey;
  input.keyIds[1] = outside.keyId;
  assert.deepEqual(parsed.pinnedPublicKeys, setInput.pinnedPublicKeys);
  assert.deepEqual(parsed.keyIds, setInput.keyIds);
  assert.deepEqual(client.config.pinnedPublicKeys, setInput.pinnedPublicKeys);
  assert.match((await client.refresh()).error, /envelope/);
});

test('every envelope must use its pinned PEM, that PEM-derived ID, and a valid signature', () => {
  const signature = Buffer.from(second.signature, 'base64'); signature[0] ^= 1;
  for (const envelope of [
    { ...second, keyId: first.keyId },
    { ...second, keyId: outside.keyId },
    { ...second, publicKey: first.publicKey, keyId: first.keyId },
    { ...second, publicKey: second.publicKey.trimEnd() },
    { ...second, payload: second.payload.replace('Travel', 'Forged') },
    { ...second, signature: signature.toString('base64') },
    { ...outside, keyId: second.keyId },
    { ...outside, publicKey: second.publicKey, keyId: second.keyId },
  ]) assert.throws(() => verifySignedManifest(envelope, config), /envelope|signature/);
  // An externally supplied ID array is never a substitute for deriving the ID.
  assert.throws(() => verifySignedManifest({ ...second, keyId: first.keyId }, { ...config, keyIds: [first.keyId, first.keyId] }), /envelope/);
});

test('asset pages share the same per-key trust and signature checks as manifests', async () => {
  const base = JSON.parse(first.payload);
  const { key, screen, ...asset } = base.slots[0];
  const page = { kind: 'asset-page', schemaVersion: 1, orgId: base.orgId, appId: base.appId, environment: base.environment,
    sequence: 1, createdAt: base.createdAt, assets: [asset], cursor: null, nextCursor: null };
  for (const signingKey of [originalPrivateKey, secondPrivateKey]) assert.equal(verifySignedAssetPage(signed(page, signingKey), config).payload.assets.length, 1);
  assert.throws(() => verifySignedAssetPage(signed(page, outsidePrivateKey), config), /envelope/);
  assert.throws(() => verifySignedAssetPage({ ...signed(page), keyId: first.keyId }, config), /envelope/);
  assert.throws(() => verifySignedAssetPage({ ...signed(page), payload: JSON.stringify({ ...page, sequence: 2 }) }, config), /signature/);

  const catalogUrl = `/api/delivery/${base.orgId}/${base.appId}/releases/1/assets`;
  const manifest = signed({ ...base, catalogSchemaVersion: 1, catalog: { url: catalogUrl, count: 1 } }, originalPrivateKey);
  let envelope = signed(page);
  const client = new AssetClient(setOnly(), { storage: createMemoryStorage(), fetch: async url => new Response(JSON.stringify(url === config.manifestUrl ? manifest : envelope)) });
  assert.deepEqual(await client.refresh(), { updated: true, sequence: 1 });
  assert.equal((await client.loadAssetPage()).items[0].assetId, asset.assetId);
  envelope = signed(page, outsidePrivateKey);
  await assert.rejects(client.loadAssetPage(), /envelope/);
});

test('refresh and restart retain history signed by different pins without resetting replay protection', async () => {
  const bytes = new Uint8Array(await fixture('assets/coast.webp'));
  const slot = JSON.parse(first.payload).slots[0];
  const ref = { key: slot.key, width: slot.width, height: slot.height };
  const storage = createMemoryStorage();
  let envelope = first;
  const fetch = async url => {
    if (url === config.manifestUrl) return new Response(JSON.stringify(envelope));
    if (new URL(url).pathname === slot.url) return new Response(bytes);
    throw new Error('new image unavailable');
  };
  const client = new AssetClient(setOnly(), { storage, fetch });
  assert.deepEqual(await client.refresh(), { updated: true, sequence: 1 });
  assert.equal((await client.resolve(ref)).source, 'remote');
  envelope = second;
  assert.deepEqual(await client.refresh(), { updated: true, sequence: 2 });
  const restarted = new AssetClient(setOnly(), { storage, fetch });
  assert.deepEqual(await restarted.initialize(), { initialized: true, sequence: 2, lastError: null });
  const fallback = await restarted.resolve(ref);
  assert.equal(fallback.source, 'cache'); assert.equal(fallback.sequence, 1); assert.deepEqual(fallback.bytes, bytes);
  const stored = await storage.loadState();
  assert.deepEqual(JSON.parse(stored).history.map(item => item.keyId), [second.keyId, first.keyId]);

  envelope = first;
  assert.match((await restarted.refresh()).error, /older release/);
  envelope = signed({ ...JSON.parse(first.payload), sequence: 2 }, originalPrivateKey);
  assert.match((await restarted.refresh()).error, /Conflicting/);
  envelope = signed({ ...JSON.parse(second.payload), sequence: 3 }, outsidePrivateKey);
  assert.match((await restarted.refresh()).error, /envelope/);
  assert.equal(await storage.loadState(), stored);
  envelope = signed(second.payload, originalPrivateKey);
  assert.deepEqual(await restarted.refresh(), { updated: false, sequence: 2 });
  assert.equal(await storage.loadState(), stored, 're-signing the same payload does not rewrite retained history');
  envelope = await json('manifests/valid-rollback-seq3.json');
  assert.deepEqual(await restarted.refresh(), { updated: true, sequence: 3 });
  const afterRollback = new AssetClient(setOnly(), { storage, fetch });
  assert.equal((await afterRollback.initialize()).sequence, 3);
  assert.equal((await afterRollback.resolve(ref)).source, 'cache');
});
