import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { AssetClient, createMemoryStorage, hashBytes, parsePublicConfig, verifySignedAssetPage, verifySignedManifest } from '../dist/index.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const appId = '22222222-2222-4222-8222-222222222222';
const assetId = '33333333-3333-4333-8333-333333333333';
const deliveryPath = `/api/delivery/${orgId}/${appId}`;
const origin = 'https://assets.example';
const key = generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
const createdAt = '2026-10-08T12:00:00.000Z';
const bytes = new TextEncoder().encode('staging asset bytes');
const asset = { assetId, width: 600, height: 400, sha256: hashBytes(bytes), url: `${deliveryPath}/assets/${assetId}`, mime: 'image/webp', bytes: bytes.length };

function configuration(environment, manifestPath = `${deliveryPath}/environments/${environment}/manifest`) {
  return parsePublicConfig({ schemaVersion: 1, orgId, appId, environment, manifestUrl: `${origin}${manifestPath}`, pinnedPublicKey: publicKey });
}

function envelope(value) {
  const payload = JSON.stringify(value);
  return { algorithm: 'Ed25519', keyId, publicKey, payload, signature: sign(null, Buffer.from(payload), key.privateKey).toString('base64') };
}

function manifest(environment, catalogPath = `${deliveryPath}/environments/${environment}/releases/1/assets`) {
  return envelope({ schemaVersion: 1, orgId, appId, environment, sequence: 1, createdAt, slots: [], catalogSchemaVersion: 1, catalog: { url: catalogPath, count: 1 } });
}

function assetPage(environment) {
  return envelope({ kind: 'asset-page', schemaVersion: 1, orgId, appId, environment, sequence: 1, createdAt, assets: [asset], cursor: null, nextCursor: null });
}

test('public configuration accepts both environment routes and the legacy production route', () => {
  for (const environment of ['staging', 'production']) assert.equal(configuration(environment).environment, environment);
  const legacy = configuration('production', `${deliveryPath}/manifest`);
  assert.equal(legacy.environment, 'production');
  assert.equal(legacy.manifestUrl, `${origin}${deliveryPath}/manifest`);
  assert.throws(() => configuration('preview'), /Invalid Assetlib public configuration/);
});

test('public configuration rejects cross-environment and malformed manifest routes', () => {
  for (const [environment, route] of [
    ['staging', `${deliveryPath}/manifest`],
    ['staging', `${deliveryPath}/environments/production/manifest`],
    ['production', `${deliveryPath}/environments/staging/manifest`],
    ['staging', `${deliveryPath}/environments/staging/manifest?extra=1`],
    ['staging', `${deliveryPath}/environments/staging/manifest#fragment`],
    ['staging', `${deliveryPath}/environments/staging/manifest/`],
    ['staging', `/api/delivery/${appId}/${orgId}/environments/staging/manifest`],
  ]) assert.throws(() => configuration(environment, route), /Manifest URL does not match this app/);
});

test('signed manifests and asset pages require the configured environment in both directions', () => {
  for (const environment of ['staging', 'production']) {
    const config = configuration(environment);
    const other = environment === 'staging' ? 'production' : 'staging';
    assert.equal(verifySignedManifest(manifest(environment), config).payload.environment, environment);
    assert.equal(verifySignedAssetPage(assetPage(environment), config).payload.environment, environment);
    assert.throws(() => verifySignedManifest(manifest(other), config), /cross-app manifest payload/);
    assert.throws(() => verifySignedAssetPage(assetPage(other), config), /cross-app asset page/);
  }
});

test('catalog URLs preserve production compatibility and reject other environments or releases', () => {
  const staging = configuration('staging');
  const production = configuration('production');
  const legacyPath = `${deliveryPath}/releases/1/assets`;
  assert.equal(verifySignedManifest(manifest('production', legacyPath), production).payload.catalog.url, legacyPath);
  for (const catalogPath of [
    legacyPath,
    `${deliveryPath}/environments/production/releases/1/assets`,
    `${deliveryPath}/environments/staging/releases/2/assets`,
    `${deliveryPath}/environments/staging/releases/1/assets?cursor=anything`,
    `https://other.example${deliveryPath}/environments/staging/releases/1/assets`,
  ]) assert.throws(() => verifySignedManifest(manifest('staging', catalogPath), staging), /Catalog URL is outside/);
  assert.throws(() => verifySignedManifest(manifest('production', `${deliveryPath}/environments/staging/releases/1/assets`), production), /Catalog URL is outside/);
});

test('staging refresh and pagination use staging metadata routes with the unchanged asset byte route', async () => {
  const config = configuration('staging');
  const calls = [];
  const client = new AssetClient(config, {
    storage: createMemoryStorage(),
    fetch: async (input, init) => {
      const url = new URL(input);
      calls.push({ path: url.pathname, search: url.search, redirect: init.redirect });
      if (url.href === config.manifestUrl) return new Response(JSON.stringify(manifest('staging')));
      if (url.pathname === `${deliveryPath}/environments/staging/releases/1/assets`) return new Response(JSON.stringify(assetPage('staging')));
      if (url.pathname === asset.url) return new Response(bytes);
      return new Response(null, { status: 404 });
    },
  });
  assert.deepEqual(await client.refresh(), { updated: true, sequence: 1 });
  const page = await client.loadAssetPage({ limit: 1 });
  assert.equal(page.sequence, 1);
  assert.equal(page.items.length, 1);
  const resolved = await client.resolveAsset(page.items[0]);
  assert.equal(resolved.source, 'remote');
  assert.deepEqual(resolved.bytes, bytes);
  assert.deepEqual(calls, [
    { path: `${deliveryPath}/environments/staging/manifest`, search: '', redirect: 'error' },
    { path: `${deliveryPath}/environments/staging/releases/1/assets`, search: '?limit=1', redirect: 'error' },
    { path: asset.url, search: '', redirect: 'error' },
  ]);
});
