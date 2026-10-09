// The shared signed contract corpus in fixtures/shared is a byte-identical copy
// of the corpus that AssetLib/sdk-swift and AssetLib/sdk-android vendor. This
// file runs every case in it against @assetlib/sdk-core so public CI checks
// JavaScript parity. No network: every Response body comes from the fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { AssetClient, SDK_LIMITS, createMemoryStorage, parsePublicConfig, verifySignedManifest } from '../dist/index.js';

const root = new URL('./fixtures/shared/', import.meta.url);
const bytes = file => readFile(new URL(file, root));
const json = async file => JSON.parse(await bytes(file));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const cases = await json('cases.json');
const config = parsePublicConfig(await json(cases.config));
const configs = Object.fromEntries(await Promise.all(Object.entries(cases.configs).map(async ([name, file]) => [name, parsePublicConfig(await json(file))])));
assert.deepEqual(configs.production, config);
assert.ok(Array.isArray(cases.resolution) && cases.resolution.length > 0, 'The corpus must include resolution checks.');
const assets = await json(cases.assets);
const catalog = await json(cases.catalog);
const ref = catalog.placements[0];
const seq1 = await json('manifests/valid-seq1.json');
const seq2 = await json('manifests/valid-seq2.json');
const seq3 = await json('manifests/valid-rollback-seq3.json');
const coast = await bytes(assets.coast.file), ridge = await bytes(assets.ridge.file);
const after2 = (await bytes('state/after-seq2.json')).toString();

function harness({ initialState, initialAssets = [], manifest = seq1, offline = false, assetBody, failSave = false, clientConfig = config, decide } = {}) {
  const storage = createMemoryStorage();
  let activeManifest = manifest, disconnected = offline, replacementBody = assetBody;
  const requests = [];
  const ready = (async () => {
    if (initialState) await storage.saveState(initialState);
    for (const [hash, body] of initialAssets) await storage.putAsset(hash, body);
  })();
  const fetcher = async (url, options) => {
    await ready;
    requests.push({ url, options });
    if (disconnected) throw new Error('Fixture network is offline.');
    if (url === clientConfig.manifestUrl) return new Response(JSON.stringify(activeManifest));
    const body = replacementBody ?? (url.endsWith(assets.coast.assetId) ? coast : url.endsWith(assets.ridge.assetId) ? ridge : null);
    return body ? new Response(body) : new Response(null, { status: 404 });
  };
  const durable = { ...storage, async loadState() { await ready; return storage.loadState(); }, async saveState(value) { if (failSave) throw new Error('Fixture durable write failed.'); return storage.saveState(value); } };
  return { client: new AssetClient(clientConfig, { storage: durable, fetch: fetcher, decide }), storage, fetcher, requests,
    setManifest(value) { activeManifest = value; }, setOffline(value) { disconnected = value; } };
}

test('every shared corpus file is listed in its SHA256SUMS and matches', async () => {
  const sums = new Map((await bytes('SHA256SUMS')).toString().trim().split('\n').map(line => [line.slice(66), line.slice(0, 64)]));
  const seen = new Set();
  async function walk(prefix) {
    for (const entry of await readdir(new URL(prefix, root), { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(`${name}/`);
      else if (name !== 'SHA256SUMS' && name !== 'README.txt') {
        seen.add(name);
        assert.equal(sha256(await bytes(name)), sums.get(name), name);
      }
    }
  }
  await walk('');
  assert.deepEqual([...sums.keys()].filter(name => !seen.has(name)), [], 'SHA256SUMS lists missing files');
});
test('files shared with the JavaScript-only corpus are identical', async () => {
  const parse = text => new Map(text.toString().trim().split('\n').map(line => [line.slice(66), line.slice(0, 64)]));
  const shared = parse(await bytes('SHA256SUMS'));
  const local = parse(await readFile(new URL('./fixtures/SHA256SUMS', import.meta.url)));
  let common = 0;
  for (const [file, hash] of shared) {
    // cases.json indexes different sets of manifests in the two copies.
    if (!local.has(file) || file === 'cases.json') continue;
    common++;
    assert.equal(local.get(file), hash, file);
  }
  assert.ok(common > 0);
});
test('every manifest fixture is indexed by a case', async () => {
  const indexed = new Set([...cases.manifests.map(item => item.file), ...cases.stateful.map(item => item.next)]);
  const files = [];
  async function walk(prefix) {
    for (const entry of await readdir(new URL(prefix, root), { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(`${prefix}${entry.name}/`);
      else files.push(`${prefix}${entry.name}`);
    }
  }
  await walk('manifests/');
  assert.deepEqual(files.filter(file => !indexed.has(file)), []);
});
test('published JS limits equal the documented native preview contract', () => {
  assert.deepEqual(SDK_LIMITS, { manifestBytes: 262144, assetBytes: 8388608, slots: 100, retainedReleases: 8, stateBytes: 3145728, cacheBytes: 52428800, cacheEntries: 100 });
});
for (const item of cases.manifests) {
  test(`shared manifest ${item.verification}: ${item.file}`, async () => {
    const value = await json(item.file);
    const caseConfig = configs[item.config ?? 'production'];
    assert.ok(caseConfig, `Unknown fixture config: ${item.config}`);
    assert.ok(['accept', 'reject'].includes(item.verification));
    if (item.verification === 'reject') assert.throws(() => verifySignedManifest(value, caseConfig));
    else {
      const { payload } = verifySignedManifest(value, caseConfig);
      assert.ok(Number.isSafeInteger(payload.sequence));
      assert.equal(payload.environment, caseConfig.environment);
      assert.equal(verify(null, Buffer.from(value.payload, 'utf8'), createPublicKey(caseConfig.pinnedPublicKey), Buffer.from(value.signature, 'base64')), true);
    }
  });
}
test('payload vectors are exact UTF-8, with matching independent Node crypto signatures', async () => {
  const vectors = await json('vectors.json');
  assert.equal(vectors.keyId, config.keyId);
  for (const v of vectors.vectors) {
    const input = await bytes(v.payloadFile);
    assert.equal(input.length, v.utf8Bytes);
    assert.equal(sha256(input), v.payloadSha256);
    assert.equal(Buffer.from(v.signatureBase64, 'base64').toString('hex'), v.signatureHex);
    assert.equal(verify(null, input, createPublicKey(config.pinnedPublicKey), Buffer.from(v.signatureBase64, 'base64')), true);
  }
});
test('shared config rejects unpinned, credentialed, non-HTTPS and cross-app URLs', () => {
  for (const patch of [
    { keyId: '0000000000000000' }, { pinnedPublicKey: config.pinnedPublicKey.trimEnd() },
    { manifestUrl: config.manifestUrl.replace('https:', 'http:') },
    { manifestUrl: config.manifestUrl + '?query=yes' }, { manifestUrl: config.manifestUrl + '#hash' },
    { manifestUrl: config.manifestUrl.replace('https://', 'https://user@') },
    { manifestUrl: config.manifestUrl.replace(config.appId, '33333333-3333-4333-8333-333333333333') },
  ]) assert.throws(() => parsePublicConfig({ ...config, ...patch }));
  const loopback = { ...config, manifestUrl: config.manifestUrl.replace('https://fixtures.assetlib.example', 'http://127.0.0.1:8080') };
  assert.throws(() => parsePublicConfig(loopback));
  assert.equal(parsePublicConfig(loopback, { allowInsecureLoopback: true }).manifestUrl, loopback.manifestUrl);
});
test('shared production and staging configs require exact environment-specific manifest paths', () => {
  const route = `/api/delivery/${config.orgId}/${config.appId}`;
  const origin = new URL(config.manifestUrl).origin;
  assert.equal(configs.production.environment, 'production');
  assert.equal(configs.production.manifestUrl, `${origin}${route}/manifest`);
  assert.equal(configs.staging.environment, 'staging');
  assert.equal(configs.staging.manifestUrl, `${origin}${route}/environments/staging/manifest`);
  assert.deepEqual(configs.staging, { ...config, environment: 'staging', manifestUrl: `${origin}${route}/environments/staging/manifest` });
  assert.equal(parsePublicConfig({ ...config, manifestUrl: `${origin}${route}/environments/production/manifest` }).environment, 'production');
  for (const invalid of [
    { ...config, environment: 'staging' },
    { ...configs.staging, environment: 'production' },
    { ...configs.staging, environment: 'preview' },
    { ...configs.staging, manifestUrl: `${origin}${route}/environments/production/manifest` },
    { ...configs.staging, manifestUrl: `${configs.staging.manifestUrl}/` },
  ]) assert.throws(() => parsePublicConfig(invalid));
});
test('the identical signed staging envelope is accepted only with the staging config', async () => {
  const staging = await json('manifests/valid-staging-seq1.json');
  assert.deepEqual(staging, await json('manifests/invalid-staging-with-production-config.json'));
  assert.equal(verifySignedManifest(staging, configs.staging).payload.environment, 'staging');
  assert.throws(() => verifySignedManifest(staging, configs.production));
  assert.throws(() => verifySignedManifest(seq1, configs.staging));
  const h = harness({ manifest: staging, clientConfig: configs.staging });
  assert.deepEqual(await h.client.refresh(), { updated: true, sequence: 1 });
  const resolved = await h.client.resolve(ref);
  assert.equal(resolved.source, 'remote');
  assert.equal(resolved.sha256, assets.coast.sha256);
  assert.deepEqual(Buffer.from(resolved.bytes), coast);
  assert.equal(h.requests[0].url, configs.staging.manifestUrl);
});
for (const [index, item] of cases.resolution.entries()) {
  test(`shared resolution ${index + 1}: ${item.manifest} ${JSON.stringify(item.request)}`, async () => {
    const manifestCase = cases.manifests.find(value => value.file === item.manifest);
    assert.equal(manifestCase?.verification, 'accept', 'Resolution requires an indexed valid manifest.');
    const caseConfig = configs[manifestCase.config ?? 'production'];
    assert.ok(caseConfig);
    const manifest = await json(item.manifest);
    const { payload } = verifySignedManifest(manifest, caseConfig);
    const slot = payload.slots.find(value => value.key === ref.key && value.width === ref.width && value.height === ref.height);
    assert.ok(slot, 'Resolution must use the fixture catalog placement.');
    const calls = [];
    const hasDecision = Object.hasOwn(item.request, 'decision');
    const decide = hasDecision ? async request => { calls.push(request); return item.request.decision; } : undefined;
    const options = {};
    if (Object.hasOwn(item.request, 'arm')) options.arm = item.request.arm;
    if (Object.hasOwn(item.request, 'appearance')) options.appearance = item.request.appearance;
    const h = harness({ manifest, clientConfig: caseConfig, decide });
    assert.deepEqual(await h.client.refresh(), { updated: true, sequence: payload.sequence });
    const result = await h.client.resolve(ref, options);
    assert.equal(result.source, 'remote');
    assert.equal(result.sequence, payload.sequence);
    assert.equal(result.assetId, item.expect.assetId);
    assert.equal(result.arm, item.expect.arm);
    assert.equal(result.armSource, item.expect.armSource);
    const asset = Object.values(assets).find(value => value.assetId === item.expect.assetId);
    assert.ok(asset, 'Expected artwork must be a known fixture asset.');
    assert.equal(result.sha256, asset.sha256);
    assert.equal(result.mime, asset.mime);
    assert.equal(result.bytes.byteLength, asset.bytes);
    assert.deepEqual(Buffer.from(result.bytes), await bytes(asset.file));
    assert.equal(sha256(result.bytes), result.sha256);
    // The result exposes the selected asset and arm, but not appearance. Identify
    // the unique signed coordinate from the result; do not reimplement resolution.
    const selected = [slot, ...(slot.cells ?? [])].filter(value => value.assetId === result.assetId && value.sha256 === result.sha256 && (value.arm ?? null) === result.arm);
    assert.equal(selected.length, 1, 'Fixture artwork and effective arm must identify exactly one coordinate.');
    assert.equal(selected[0].appearance ?? null, item.expect.appearance);
    const shouldDecide = hasDecision && options.arm === undefined && Boolean(slot.variants?.arm?.length);
    assert.deepEqual(calls, shouldDecide ? [{ key: ref.key, arms: slot.variants.arm, ...(options.appearance !== undefined ? { appearance: options.appearance } : {}) }] : []);
    assert.equal(h.requests.length, 2, 'Each resolution fetches one manifest and the selected artwork.');
    assert.equal(h.requests[1].url, new URL(selected[0].url, caseConfig.manifestUrl).href);
  });
}
for (const item of cases.stateful) {
  test(`shared stateful ${item.expected}: ${item.next}`, async () => {
    const h = harness({ initialState: (await bytes(item.initialState)).toString(), manifest: await json(item.next) });
    assert.equal((await h.client.initialize()).sequence, 2);
    const previous = await h.storage.loadState();
    const result = await h.client.refresh();
    if (item.expected.startsWith('reject')) { assert.ok(result.error); assert.equal(result.sequence, 2); assert.equal(await h.storage.loadState(), previous); }
    else if (item.expected.startsWith('idempotent')) { assert.deepEqual(result, { updated: false, sequence: 2 }); assert.equal(await h.storage.loadState(), previous); }
    else assert.deepEqual(result, { updated: true, sequence: 3 });
  });
}
test('shared release 1 → 2 → rollback 3, restart, and verified offline cache retain highest sequence', async () => {
  const h = harness();
  assert.equal((await h.client.initialize()).sequence, 0);
  assert.equal(h.requests.length, 0, 'initialize is cache-only');
  assert.equal((await h.client.resolve(ref)).source, 'bundle');
  assert.deepEqual(await h.client.refresh(), { updated: true, sequence: 1 });
  let resolved = await h.client.resolve(ref);
  assert.equal(resolved.source, 'remote'); assert.equal(resolved.sha256, assets.coast.sha256);
  h.setManifest(seq2); await h.client.refresh(); resolved = await h.client.resolve(ref);
  assert.equal(resolved.source, 'remote'); assert.equal(resolved.sha256, assets.ridge.sha256);
  h.setManifest(seq3); await h.client.refresh(); resolved = await h.client.resolve(ref);
  assert.equal(resolved.source, 'cache'); assert.equal(resolved.sequence, 3); assert.equal(resolved.sha256, assets.coast.sha256);
  h.setOffline(true);
  const restarted = new AssetClient(config, { storage: h.storage, fetch: h.fetcher });
  assert.equal((await restarted.initialize()).sequence, 3);
  assert.ok((await restarted.refresh()).error);
  assert.equal((await restarted.resolve(ref)).source, 'cache');
  assert.equal(restarted.getStatus().sequence, 3);
  for (const req of h.requests) { assert.equal(req.options.credentials, 'omit'); assert.equal(req.options.redirect, 'error'); assert.equal(req.options.method, 'GET'); }
});
for (const item of cases.byteFailures) {
  test(`shared bad image falls back to older verified cache: ${item.body}`, async () => {
    // The fixture state is the accepted release after this case's manifest.
    assert.equal(item.manifest, 'manifests/valid-seq2.json');
    const h = harness({ initialState: after2, initialAssets: [[assets.coast.sha256, coast]], assetBody: await bytes(item.body) });
    const resolved = await h.client.resolve(ref);
    assert.equal(resolved.source, 'cache'); assert.equal(resolved.sequence, 1); assert.equal(resolved.sha256, assets.coast.sha256);
    assert.equal(h.client.getStatus().sequence, 2, 'fallback never lowers the accepted release high-water mark');
    assert.equal(h.requests.length, 1, 'only current release may download');
  });
}
test('shared offline without cache uses bundled fallback; hash-invalid cached bytes are never rendered', async () => {
  const h = harness({ initialState: after2, offline: true, initialAssets: [[assets.ridge.sha256, await bytes('assets/ridge-tampered.webp')]] });
  assert.equal((await h.client.resolve(ref)).source, 'bundle');
  assert.equal(h.client.getStatus().sequence, 2);
});
test('shared unknown or incompatible placement uses bundle without image requests', async () => {
  const h = harness({ initialState: after2 });
  assert.equal((await h.client.resolve({ ...ref, key: 'travel.missing' })).source, 'bundle');
  assert.equal((await h.client.resolve({ ...ref, width: 600, height: 450 })).source, 'bundle');
  assert.equal(h.requests.length, 0);
});
test('shared pixel dimensions are not logical placement dimensions', async () => {
  const h = harness({ manifest: await json('manifests/valid-logical-dimensions.json') });
  await h.client.refresh();
  assert.equal((await h.client.resolve({ ...ref, width: 600, height: 450 })).source, 'remote');
});
for (const file of ['state/corrupt-highest.json', 'state/corrupt-order.json']) {
  test(`shared unverifiable persisted state fails closed: ${file}`, async () => {
    const h = harness({ initialState: (await bytes(file)).toString() });
    assert.ok((await h.client.initialize()).lastError);
    assert.ok((await h.client.refresh()).error);
    assert.equal((await h.client.resolve(ref)).source, 'bundle');
    assert.equal(h.requests.length, 0, 'corrupt anti-replay state must not silently trust fresh network data');
  });
}
test('shared failed durable write cannot expose an uncommitted sequence', async () => {
  const h = harness({ failSave: true });
  assert.ok((await h.client.refresh()).error);
  assert.equal(h.client.getStatus().sequence, 0);
  assert.equal(await h.storage.loadState(), null);
  assert.equal((await h.client.resolve(ref)).source, 'bundle');
});
test('shared bounded manifest download rejects excess bytes, false length, invalid UTF-8, and redirect', async () => {
  const bodies = [
    () => new Response(new Uint8Array(SDK_LIMITS.manifestBytes + 1)),
    () => new Response('{}', { headers: { 'content-length': String(SDK_LIMITS.manifestBytes + 1) } }),
    () => new Response('{}', { headers: { 'content-length': 'not-a-size' } }),
    () => new Response(new Uint8Array([0xc3, 0x28])),
    () => { const value = new Response(JSON.stringify(seq1)); Object.defineProperty(value, 'redirected', { value: true }); return value; },
  ];
  for (const response of bodies) {
    const client = new AssetClient(config, { storage: createMemoryStorage(), fetch: async () => response() });
    assert.ok((await client.refresh()).error); assert.equal(client.getStatus().sequence, 0);
  }
});

const renditions = await json('renditions.json');
const renditionsManifest = await json(renditions.manifest);
function renditionHarness(formats) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init });
    if (url === config.manifestUrl) return new Response(JSON.stringify(renditionsManifest));
    const file = renditions.files.find(item => url.endsWith(item.sha256));
    return file ? new Response(await bytes(file.file)) : new Response(null, { status: 404 });
  };
  return { client: new AssetClient(config, { storage: createMemoryStorage(), fetch, formats }), requests };
}
test('shared rendition files match their listed hashes', async () => {
  for (const file of renditions.files) assert.equal(sha256(await bytes(file.file)), file.sha256, file.file);
  assert.ok(renditions.files.some(file => file.sha256 === renditions.vector.sha256));
});
for (const selection of renditions.selections) {
  test(`shared rendition selection ${selection.width}x${selection.height}: ${selection.mime}`, async () => {
    const h = renditionHarness();
    const { sequence } = verifySignedManifest(renditionsManifest, config).payload;
    assert.deepEqual(await h.client.refresh(), { updated: true, sequence });
    const result = await h.client.resolve(ref, { pixelWidth: selection.width, pixelHeight: selection.height });
    assert.equal(result.source, 'remote');
    assert.equal(result.sha256, selection.sha256);
    assert.equal(result.mime, selection.mime);
    assert.equal(sha256(result.bytes), selection.sha256);
    assert.equal(h.requests.length, 2);
    assert.ok(h.requests[1].url.endsWith(selection.sha256));
    assert.equal(h.requests.some(request => request.url.endsWith(renditions.vector.sha256)), false, 'raster clients never request the vector rendition');
  });
}
test('shared vector rendition is selected only when the client opts into SVG', async () => {
  const h = renditionHarness(['image/webp', 'image/png', 'image/svg+xml']);
  await h.client.refresh();
  const result = await h.client.resolve(ref);
  assert.equal(result.sha256, renditions.vector.sha256);
  assert.equal(result.mime, renditions.vector.mime);
  assert.equal(result.bytes.byteLength, renditions.vector.bytes);
  assert.equal(h.requests[1].url, new URL(renditions.vector.url, config.manifestUrl).href);
});
