import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AssetClient, createMemoryStorage, hashBytes, parsePublicConfig, resolveAccessibilityDescription, validateAccessibility, verifySignedManifest, verifySignedAssetPage } from '../dist/index.js';

const orgId = '11111111-1111-4111-8111-111111111111', appId = '22222222-2222-4222-8222-222222222222';
const key = generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
const prefix = `/api/delivery/${orgId}/${appId}`;
const config = parsePublicConfig({ schemaVersion: 1, orgId, appId, environment: 'production', manifestUrl: `https://images.example${prefix}/manifest`, pinnedPublicKey: publicKey });
const envelope = data => { const payload = JSON.stringify(data); return { algorithm: 'Ed25519', keyId, publicKey, payload, signature: sign(null, Buffer.from(payload), key.privateKey).toString('base64') }; };
const metadata = description => ({ defaultLocale: 'en', descriptions: { en: description, th: `ไทย ${description}` } });
const bundled = metadata('Bundled coast');
const ref = { key: 'travel.coast', width: 600, height: 400, bundledAccessibility: bundled };
const images = new Map();
function descriptor(n, accessibility) {
  const assetId = `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
  const bytes = new TextEncoder().encode(`verified image ${n}`), url = `${prefix}/assets/${assetId}`;
  images.set(url, bytes);
  return { assetId, sha256: hashBytes(bytes), url, mime: 'image/webp', bytes: bytes.length, ...(accessibility === undefined ? {} : { accessibility }) };
}
function payload(sequence, artwork = descriptor(sequence, metadata(`Release ${sequence}`))) {
  return { schemaVersion: 1, orgId, appId, environment: 'production', sequence, createdAt: '2026-10-08T12:00:00.000Z', slots: [{ key: ref.key, width: ref.width, height: ref.height, screen: 'Travel', ...artwork }] };
}
function harness(initial = payload(1)) {
  let current = initial, offline = false;
  const corrupt = new Set(), storage = createMemoryStorage();
  const fetch = async input => {
    if (offline) throw new Error('offline');
    const url = new URL(input);
    if (url.pathname.endsWith('/manifest')) return new Response(JSON.stringify(envelope(current)));
    if (url.pathname.includes('/releases/')) return new Response(JSON.stringify(envelope({ kind: 'asset-page', schemaVersion: 1, orgId, appId, environment: 'production', sequence: current.sequence, createdAt: current.createdAt, cursor: null, nextCursor: null, assets: current.slots.map(({ key, screen, ...image }) => image) })));
    return new Response(corrupt.has(url.pathname) ? new Uint8Array([0]) : images.get(url.pathname));
  };
  return { client: new AssetClient(config, { storage, fetch }), storage, fetch, set: p => { current = p; }, offline: () => { offline = true; }, corrupt: url => { corrupt.add(url); } };
}

test('localized descriptions use case-insensitive exact, parent subtags, then the explicit default', () => {
  const value = { defaultLocale: 'TH', descriptions: { en: 'Coast', 'EN-gb': 'British coast', th: 'ชายฝั่ง' } };
  assert.equal(resolveAccessibilityDescription(value, 'en-GB'), 'British coast');
  assert.equal(resolveAccessibilityDescription(value, 'en-GB-x-private'), 'British coast');
  assert.equal(resolveAccessibilityDescription(value, 'en-US'), 'Coast');
  assert.equal(resolveAccessibilityDescription(value, 'de'), 'ชายฝั่ง');
  assert.equal(resolveAccessibilityDescription(value), 'ชายฝั่ง');
  assert.equal(resolveAccessibilityDescription(undefined, 'en'), undefined);
});

test('metadata validation bounds locales and UTF-16 descriptions and rejects ambiguous defaults', () => {
  for (const invalid of [null, [], {}, { defaultLocale: 'en', descriptions: {} }, { defaultLocale: 'en', descriptions: { th: 'ไทย' } }, { defaultLocale: 'en', descriptions: { en: 'ok', EN: 'duplicate' } }, { defaultLocale: 'en_US', descriptions: { en_US: 'bad locale' } }, { defaultLocale: 'en', descriptions: { en: ' \n\t ' } }, { defaultLocale: 'en', descriptions: { en: '😀'.repeat(501) } }, { defaultLocale: 'en', descriptions: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`en-${i}`, 'text'])) }]) assert.throws(() => validateAccessibility(invalid));
  validateAccessibility({ defaultLocale: 'EN', descriptions: { en: '😀'.repeat(500) } });
  assert.throws(() => validateAccessibility({ defaultLocale: 'en\n', descriptions: { 'en\n': 'Trailing newline' } }));
  const longest = 'en-' + Array(6).fill('abcdefgh').join('-') + '-abcdef';
  assert.equal(longest.length, 63);
  validateAccessibility({ defaultLocale: longest, descriptions: { [longest]: 'text' } });
  assert.throws(() => validateAccessibility({ defaultLocale: longest + 'g', descriptions: { [longest + 'g']: 'text' } }));
  const locales = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`en-${i}`, 'text']));
  validateAccessibility({ defaultLocale: 'en-0', descriptions: locales });
});

test('signed placement, state, and catalog descriptors reject invalid accessibility metadata', () => {
  const good = payload(1);
  assert.equal(verifySignedManifest(envelope(good), config).payload.slots[0].accessibility.descriptions.en, 'Release 1');
  const tampered = envelope(good);
  assert.throws(() => verifySignedManifest({ ...tampered, payload: tampered.payload.replace('Release 1', 'Forged label') }, config), /signature/);
  for (const invalid of [null, { defaultLocale: 'en', descriptions: { en: '' } }]) {
    assert.throws(() => verifySignedManifest(envelope(payload(1, descriptor(1, invalid))), config));
    const statePayload = payload(1);
    statePayload.stateSchemaVersion = 1;
    statePayload.slots[0].states = { first: descriptor(1, metadata('Release 1')), second: descriptor(2, invalid) };
    statePayload.slots[0].defaultState = 'first';
    assert.throws(() => verifySignedManifest(envelope(statePayload), config));
    assert.throws(() => verifySignedAssetPage(envelope({ kind: 'asset-page', schemaVersion: 1, orgId, appId, environment: 'production', sequence: 1, createdAt: good.createdAt, cursor: null, nextCursor: null, assets: [{ ...descriptor(1, invalid), width: 600, height: 400 }] }), config));
  }
});

test('metadata stays with selected release, verified cache, retained fallback, and bundled artwork', async () => {
  const h = harness();
  assert.deepEqual((await h.client.resolve(ref)).accessibility, bundled);
  await h.client.refresh();
  assert.equal((await h.client.resolve(ref)).accessibility.descriptions.en, 'Release 1');
  // Identical cached pixels can have a newly signed description in the current release.
  h.set(payload(2, descriptor(1, metadata('Current coast')))); await h.client.refresh();
  const relabeled = await h.client.resolve(ref);
  assert.equal(relabeled.source, 'cache'); assert.equal(relabeled.sequence, 2);
  assert.equal(relabeled.accessibility.descriptions.en, 'Current coast');
  const newer = payload(3); h.set(newer); h.corrupt(newer.slots[0].url); await h.client.refresh();
  const retained = await h.client.resolve(ref);
  assert.equal(retained.source, 'cache'); assert.equal(retained.sequence, 2);
  assert.equal(retained.accessibility.descriptions.en, 'Current coast');
  h.offline();
  const restarted = new AssetClient(config, { storage: h.storage, fetch: h.fetch });
  assert.equal((await restarted.resolve(ref)).accessibility.descriptions.en, 'Current coast');
  const mismatch = await restarted.resolve({ ...ref, width: 601 });
  assert.equal(mismatch.source, 'bundle'); assert.deepEqual(mismatch.accessibility, bundled);
});

test('legacy remote images never borrow bundled descriptions', async () => {
  const h = harness(payload(1, descriptor(1)));
  await h.client.refresh();
  const result = await h.client.resolve(ref);
  assert.equal(result.source, 'remote'); assert.equal(result.accessibility, undefined);
  assert.equal((await h.client.resolve(ref)).accessibility, undefined);
});

test('each state and each pinned dynamic reference keeps its own metadata', async () => {
  const states = { empty: descriptor(1, metadata('Empty pot')), grown: descriptor(2) };
  const p = payload(1, states.empty);
  p.stateSchemaVersion = 1; p.slots[0].states = states; p.slots[0].defaultState = 'empty';
  const h = harness(p); await h.client.refresh();
  const family = await h.client.resolveStateSet({ ...ref, states: ['empty', 'grown'] });
  assert.equal(family.states.empty.accessibility.descriptions.en, 'Empty pot');
  assert.equal(family.states.grown.accessibility, undefined);
  const catalog = payload(2, descriptor(3, metadata('Forest')));
  catalog.catalogSchemaVersion = 1; catalog.catalog = { url: `${prefix}/releases/2/assets`, count: 1 };
  h.set(catalog); await h.client.refresh();
  const page = await h.client.loadAssetPage(), pinned = page.items[0];
  const first = await h.client.resolveAsset(pinned);
  assert.equal(first.accessibility.descriptions.en, 'Forest');
  assert.throws(() => { first.accessibility.descriptions.en = 'Unverified mutation'; }, TypeError);
  h.set(payload(3, descriptor(4, metadata('Desert')))); await h.client.refresh();
  const cached = await h.client.resolveAsset(pinned);
  assert.equal(cached.source, 'cache'); assert.equal(cached.sequence, 2);
  assert.equal(cached.accessibility.descriptions.en, 'Forest');
});

test('offline catalog generation preserves bundled descriptions and validates state ownership', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'assetlib-accessibility-'));
  try {
    const file = path.join(directory, 'catalog.json');
    const placement = { ...ref, symbol: ['Travel', 'coast'], states: ['empty', 'grown'], bundledStateAccessibility: { empty: metadata('Empty bundled pot') } };
    await writeFile(file, JSON.stringify({ schemaVersion: 1, placements: [placement] }));
    const run = () => spawnSync(process.execPath, ['bin/codegen.mjs', file], { encoding: 'utf8' });
    const success = run(); assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /Bundled coast/); assert.match(success.stdout, /Empty bundled pot/);
    placement.bundledStateAccessibility = { unknown: metadata('Bad state') };
    await writeFile(file, JSON.stringify({ schemaVersion: 1, placements: [placement] }));
    assert.notEqual(run().status, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
