import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { AssetClient, createMemoryStorage, hashBytes, parsePublicConfig, selectCatalogReferences, validateLottie, verifySignedManifest, LOTTIE_LIMITS } from '../dist/index.js';

const orgId = '11111111-1111-4111-8111-111111111111', appId = '22222222-2222-4222-8222-222222222222';
const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyId = hashBytes(new TextEncoder().encode(publicKey)).slice(0, 16);
const config = parsePublicConfig({ schemaVersion: 1, orgId, appId, environment: 'production', manifestUrl: `https://assets.example/api/delivery/${orgId}/${appId}/manifest`, pinnedPublicKey: publicKey });
const json = value => new TextEncoder().encode(JSON.stringify(value));
const clone = value => structuredClone(value);
const constant = k => ({ a: 0, k });
const transform = () => ({ o: constant(100), r: constant(0), p: constant([0, 0]), a: constant([0, 0]), s: constant([100, 100]) });
function vectorAnimation(color = [0.1, 0.4, 0.9, 1]) {
  return { v: '5.13.0', fr: 30, ip: 0, op: 60, w: 100, h: 60, nm: 'Card', ddd: 0, assets: [], layers: [{ ty: 4, ind: 1, ip: 0, op: 60, st: 0, sr: 1, ks: transform(), shapes: [
    { ty: 'rc', p: constant([50, 30]), s: constant([100, 60]), r: constant(4) },
    { ty: 'fl', c: constant(color), o: constant(100), r: 1 },
  ] }] };
}
function asset(index, animation = vectorAnimation()) {
  const ref = { key: `cards.card${index}`, width: 100, height: 60 };
  const assetId = `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`;
  const poster = new TextEncoder().encode(`poster-${index}`);
  const bytes = json(animation), sha256 = hashBytes(bytes), url = `/api/delivery/${orgId}/${appId}/assets/${assetId}`;
  return { ref, poster, bytes, slot: { ...ref, screen: 'Cards', assetId, sha256: hashBytes(poster), url, mime: 'image/webp', bytes: poster.length,
    animation: { format: 'lottie', profile: 'vector-v1', mime: 'application/json', sha256, url: `${url}/animations/${sha256}`, bytes: bytes.length, width: animation.w, height: animation.h, frameRate: animation.fr, inPoint: animation.ip, outPoint: animation.op } } };
}
const card1 = asset(1), card2 = asset(2, vectorAnimation([1, 0, 0, 1])), card3 = asset(3, vectorAnimation([0, 1, 0, 1]));
function envelope(slots = [card1.slot], sequence = 1, changes = {}) {
  const payload = JSON.stringify({ schemaVersion: 1, animationSchemaVersion: 1, orgId, appId, environment: 'production', sequence, createdAt: '2026-10-07T12:00:00.000Z', slots, ...changes });
  return { algorithm: 'Ed25519', keyId, publicKey, payload, signature: sign(null, Buffer.from(payload), pair.privateKey).toString('base64') };
}
function service(cards = [card1]) {
  const state = { release: envelope(cards.map(c => c.slot)), objects: new Map(cards.flatMap(c => [[c.slot.url, c.poster], [c.slot.animation.url, c.bytes]])), requests: [], offline: false };
  return { state, fetch: async (url, init) => {
    state.requests.push({ path: new URL(url).pathname, init });
    if (state.offline) throw new Error('offline');
    if (url === config.manifestUrl) return new Response(JSON.stringify(state.release));
    const bytes = state.objects.get(new URL(url).pathname);
    return bytes ? new Response(bytes) : new Response('missing', { status: 404 });
  } };
}

test('vector-v1 accepts bounded static and keyframed shapes without rewriting original bytes', () => {
  const animation = vectorAnimation();
  animation.layers[0].ks.r = { a: 1, k: [{ t: 0, s: [0], e: [10], i: { x: [0.5], y: [1] }, o: { x: [0.5], y: [0] } }, { t: 60, s: [10] }] };
  const bytes = json(animation), before = bytes.slice(), parsed = validateLottie(bytes);
  assert.deepEqual(parsed, { data: animation, width: 100, height: 60, frameRate: 30, inPoint: 0, outPoint: 60 });
  assert.deepEqual(bytes, before);
});

test('animated properties reject renderer-incompatible scalar values, empty timelines and malformed interpolation', () => {
  const easing = { i: { x: [0.7], y: [1] }, o: { x: [0.3], y: [0] } };
  const valid = () => ({ a: 1, k: [{ t: 0, s: [0], e: [10], ...clone(easing) }, { t: 60, s: [10] }] });
  const invalid = [
    { a: 1, k: [{ t: 0, s: 0, e: 10, ...clone(easing) }, { t: 60, s: 10 }] },
    { a: 1, k: [{ t: 0 }] }, { a: 1, k: [{ t: 0, s: [0] }] },
    { a: 1, k: [{ t: 0, s: [0], ...clone(easing) }, { t: 60 }] },
    { a: 1, k: [{ t: 0, s: [0], e: [10] }, { t: 60, s: [10] }] },
    { a: 1, k: [{ t: 0, s: [0], e: [10], h: 1 }, { t: 60 }] },
  ];
  for (const mutate of [
    p => { p.k[0].e = 10; }, p => { p.k[0].s = 0; }, p => { p.k[1].t = 0; },
    p => { delete p.k[0].i; }, p => { p.k[0].i.x = 0.7; },
    p => { p.k[0].o.x = [1.2]; }, p => { p.k[0].o.y = [0, 1]; },
    p => { p.k[0].to = [0]; p.k[0].ti = [0]; },
  ]) { const p = valid(); mutate(p); invalid.push(p); }
  for (const property of invalid) {
    const a = vectorAnimation(); a.layers[0].ks.r = property;
    assert.throws(() => validateLottie(json(a)), /Lottie vector-v1/, JSON.stringify(property));
  }
  // A normal final time-only marker is supported when the preceding segment has e.
  const terminal = vectorAnimation(); terminal.layers[0].ks.r = valid(); delete terminal.layers[0].ks.r.k[1].s;
  assert.doesNotThrow(() => validateLottie(json(terminal)));
  const hold = vectorAnimation(); hold.layers[0].ks.r = { a: 1, k: [{ t: 0, s: [0], h: 1 }, { t: 60, s: [10] }] };
  assert.doesNotThrow(() => validateLottie(json(hold)));
});

test('animated vectors and paths retain renderer-compatible dimensions, vertices and tangents', () => {
  const easing = { i: { x: 0.7, y: 1 }, o: { x: 0.3, y: 0 } };
  const validPosition = () => ({ a: 1, k: [{ t: 0, s: [0, 0], e: [10, 10], to: [1, 1], ti: [-1, -1], ...clone(easing) }, { t: 60, s: [10, 10] }] });
  for (const mutate of [
    p => { p.k[1].s = [10, 10, 0]; }, p => { delete p.k[0].ti; }, p => { p.k[0].to = [1, 1, 1]; },
    p => { p.k[0].o = { x: [0.3, 0.4], y: [0, 0] }; p.k[0].i = { x: [0.7, 0.6], y: [1, 1] }; },
  ]) {
    const a = vectorAnimation(), p = validPosition(); mutate(p); a.layers[0].ks.p = p;
    assert.throws(() => validateLottie(json(a)), /Lottie vector-v1/);
  }
  const valid = vectorAnimation(); valid.layers[0].ks.p = validPosition(); assert.doesNotThrow(() => validateLottie(json(valid)));
  const path = { c: true, v: [[0, 0], [10, 10]], i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]] };
  const a = vectorAnimation(); a.layers[0].shapes = [{ ty: 'sh', ks: { a: 1, k: [{ t: 0, s: [path], e: [clone(path)], ...clone(easing) }, { t: 60, s: [clone(path)] }] } }];
  assert.doesNotThrow(() => validateLottie(json(a)));
  a.layers[0].shapes[0].ks.k[1].s[0].v.push([20, 20]); a.layers[0].shapes[0].ks.k[1].s[0].i.push([0, 0]); a.layers[0].shapes[0].ks.k[1].s[0].o.push([0, 0]);
  assert.throws(() => validateLottie(json(a)), /vertex count/);
});

test('vector-v1 rejects external resources, expressions, unsupported features and malformed transforms', () => {
  const mutations = [
    a => { a.assets = [{ id: 'image', p: 'https://evil.example/x.png' }]; },
    a => { a.layers[0].ty = 5; }, a => { a.fonts = {}; }, a => { a.layers[0].ef = []; },
    a => { a.layers[0].masksProperties = []; }, a => { a.layers[0].parent = 2; },
    a => { a.layers[0].ks.r.x = 'alert(1)'; }, a => { a.layers[0].ks = {}; },
    a => { a.layers[0].ks.p = constant(12); }, a => { a.layers[0].ks.r = constant([1, 2]); },
    a => { a.layers[0].shapes[1].c = constant([0, 1]); }, a => { a.layers[0].shapes[1].ty = 'gf'; },
    a => { a.layers[0].shapes[0].p.k[0] = Infinity; }, a => { a.nm = { x: 'code' }; },
    a => { a.layers[0].shapes[0].constructor = {}; },
  ];
  for (const mutate of mutations) { const a = vectorAnimation(); mutate(a); assert.throws(() => validateLottie(json(a)), /Lottie vector-v1/); }
  assert.throws(() => validateLottie(new Uint8Array([0xff])), /UTF-8/);
  assert.throws(() => validateLottie(json({})), /version/);
});

test('vector-v1 enforces byte, timeline, dimensions, nesting and shape complexity limits', () => {
  assert.throws(() => validateLottie(new Uint8Array(LOTTIE_LIMITS.bytes + 1)), /512 KiB/);
  for (const change of [{ w: 2049 }, { h: 0 }, { fr: 61 }, { fr: 0 }, { op: 901 }, { ip: -1 }, { op: 0 }]) assert.throws(() => validateLottie(json({ ...vectorAnimation(), ...change })), /dimensions|timeline/);
  const nested = vectorAnimation();
  for (let i = 0; i < 35; i++) nested.layers[0].shapes = [{ ty: 'gr', it: nested.layers[0].shapes }];
  assert.throws(() => validateLottie(json(nested)), /depth/);
  const many = vectorAnimation(); many.layers[0].shapes = Array.from({ length: 2049 }, () => ({ ty: 'fl', c: constant([1, 0, 0]), o: constant(100) }));
  assert.throws(() => validateLottie(json(many)), /shape count|complexity/);
});

test('signed animation extension rejects unknown schema, bad metadata/profile and URL escape', () => {
  assert.equal(verifySignedManifest(envelope(), config).payload.animationSchemaVersion, 1);
  assert.throws(() => verifySignedManifest(envelope(undefined, 1, { animationSchemaVersion: undefined }), config), /descriptor/);
  const noAnimation = clone(card1.slot); delete noAnimation.animation;
  assert.throws(() => verifySignedManifest(envelope([noAnimation], 1, { animationSchemaVersion: 2 }), config), /schema/);
  assert.doesNotThrow(() => verifySignedManifest(envelope([noAnimation], 1, { animationSchemaVersion: undefined }), config));
  for (const change of [
    { format: 'dotlottie' }, { profile: 'full' }, { mime: 'image/webp' }, { sha256: 'A'.repeat(64) }, { bytes: 0 }, { bytes: 524289 },
    { width: 101 }, { width: 2049 }, { frameRate: 61 }, { inPoint: -1 }, { outPoint: 901 },
    { url: 'https://evil.example/file' }, { url: `${card1.slot.animation.url}?token=x` }, { url: `${card1.slot.animation.url}#x` },
    { url: `https://user:pass@assets.example${card1.slot.animation.url}` }, { url: card2.slot.animation.url },
  ]) assert.throws(() => verifySignedManifest(envelope([{ ...card1.slot, animation: { ...card1.slot.animation, ...change } }]), config));
});

test('catalog selection fetches only assigned bodies, caches repeat access, and unknown keys never become URLs', async () => {
  const delivery = service([card1, card2, card3]);
  const client = new AssetClient(config, { storage: createMemoryStorage(), fetch: delivery.fetch });
  const catalog = [card1.ref, card2.ref, card3.ref];
  const selected = selectCatalogReferences(catalog, [card2.ref.key, 'https://evil.example/a', '__proto__', 'unknown', card2.ref.key]);
  assert.deepEqual(selected, { references: [card2.ref], unknownKeys: ['https://evil.example/a', '__proto__', 'unknown'] });
  await client.refresh(); assert.equal(delivery.state.requests.length, 1);
  assert.equal((await client.resolveAnimation(selected.references[0])).source, 'remote');
  assert.equal((await client.resolveAnimation(selected.references[0])).source, 'cache');
  assert.deepEqual(delivery.state.requests.slice(1).map(r => r.path), [card2.slot.animation.url]);
  assert.equal(delivery.state.requests[1].init.headers.Accept, 'application/json');
  assert.equal(delivery.state.requests[1].init.credentials, 'omit');
  assert.equal(delivery.state.requests[1].init.redirect, 'error');
  const changed = selectCatalogReferences(catalog, [card1.ref.key]);
  await client.resolveAnimation(changed.references[0]);
  assert.deepEqual(delivery.state.requests.slice(1).map(r => r.path), [card2.slot.animation.url, card1.slot.animation.url]);
  assert.throws(() => selectCatalogReferences([card1.ref, card1.ref], []), /duplicate/);
});

test('ordinary image resolution uses its mandatory poster without downloading animation', async () => {
  const delivery = service(); const client = new AssetClient(config, { storage: createMemoryStorage(), fetch: delivery.fetch });
  await client.refresh(); const image = await client.resolve(card1.ref);
  assert.equal(image.source, 'remote'); assert.equal(image.mime, 'image/webp'); assert.deepEqual(image.bytes, card1.poster);
  assert.deepEqual(delivery.state.requests.slice(1).map(r => r.path), [card1.slot.url]);
});

test('verified animation survives offline restart; first-use offline returns a poster outcome', async () => {
  const delivery = service(); const storage = createMemoryStorage();
  const client = new AssetClient(config, { storage, fetch: delivery.fetch });
  await client.refresh(); const downloaded = await client.resolveAnimation(card1.ref);
  assert.equal(downloaded.source, 'remote'); assert.deepEqual(downloaded.data, vectorAnimation());
  delivery.state.offline = true; delivery.state.requests = [];
  const restarted = new AssetClient(config, { storage, fetch: delivery.fetch });
  assert.equal((await restarted.resolveAnimation(card1.ref)).source, 'cache');
  assert.equal(delivery.state.requests.length, 0);
  assert.equal((await new AssetClient(config, { storage: createMemoryStorage(), fetch: delivery.fetch }).resolveAnimation(card1.ref)).source, 'poster');
});

test('tampered animation and signed unsupported profile bytes are never passed to player or cached', async () => {
  for (const kind of ['hash', 'profile', 'keyframes', 'metadata', 'truncated']) {
    const delivery = service(); const storage = createMemoryStorage();
    if (kind === 'hash') delivery.state.objects.set(card1.slot.animation.url, new Uint8Array(card1.bytes.length));
    if (kind === 'truncated') delivery.state.objects.set(card1.slot.animation.url, card1.bytes.slice(0, -1));
    if (kind === 'profile') {
      const a = vectorAnimation(); a.layers[0].ks.r.x = 'alert(1)';
      const bad = asset(1, a); delivery.state.release = envelope([bad.slot]); delivery.state.objects.set(bad.slot.animation.url, bad.bytes);
    }
    if (kind === 'keyframes') {
      const a = vectorAnimation(); a.layers[0].ks.r = { a: 1, k: [{ t: 0 }] };
      const bad = asset(1, a); delivery.state.release = envelope([bad.slot]); delivery.state.objects.set(bad.slot.animation.url, bad.bytes);
    }
    if (kind === 'metadata') delivery.state.release = envelope([{ ...card1.slot, animation: { ...card1.slot.animation, frameRate: 29 } }]);
    const client = new AssetClient(config, { storage, fetch: delivery.fetch }); await client.refresh();
    const result = await client.resolveAnimation(card1.ref);
    assert.equal(result.source, 'poster', kind); assert.equal(result.data, undefined);
    const hash = JSON.parse(delivery.state.release.payload).slots[0].animation.sha256;
    assert.equal(await storage.getAsset(hash), null);
  }
});

test('current corrupted cache is reverified and replaced; offline corruption returns poster', async () => {
  const delivery = service(); const storage = createMemoryStorage(); const client = new AssetClient(config, { storage, fetch: delivery.fetch });
  await client.refresh(); await client.resolveAnimation(card1.ref);
  await storage.putAsset(card1.slot.animation.sha256, new Uint8Array(card1.bytes.length));
  assert.equal((await client.resolveAnimation(card1.ref)).source, 'remote');
  await storage.putAsset(card1.slot.animation.sha256, new Uint8Array(card1.bytes.length)); delivery.state.offline = true;
  assert.equal((await client.resolveAnimation(card1.ref)).source, 'poster');
});

test('failed current animation falls back only to verified historical cache, then legitimate rollback reuses it', async () => {
  const delivery = service(); const storage = createMemoryStorage(); const client = new AssetClient(config, { storage, fetch: delivery.fetch });
  await client.refresh(); await client.resolveAnimation(card1.ref);
  const next = asset(1, vectorAnimation([0, 0, 0, 1])); delivery.state.release = envelope([next.slot], 2);
  await client.refresh(); delivery.state.requests = [];
  const fallback = await client.resolveAnimation(card1.ref);
  assert.equal(fallback.source, 'cache'); assert.equal(fallback.sequence, 1);
  assert.deepEqual(delivery.state.requests.map(r => r.path), [next.slot.animation.url]);
  delivery.state.release = envelope([card1.slot], 3); await client.refresh(); delivery.state.requests = [];
  assert.equal((await client.resolveAnimation(card1.ref)).sequence, 3); assert.equal(delivery.state.requests.length, 0);
  // Persisted manifests without a previously downloaded body do not authorize an old download.
  const empty = { ...createMemoryStorage(), loadState: () => storage.loadState() };
  delivery.state.release = envelope([next.slot], 4);
  const fresh = new AssetClient(config, { storage: empty, fetch: delivery.fetch }); await fresh.refresh(); delivery.state.requests = [];
  assert.equal((await fresh.resolveAnimation(card1.ref)).source, 'poster');
  assert.deepEqual(delivery.state.requests.map(r => r.path), [next.slot.animation.url]);
});

test('removing animation or its placement returns poster without resurrecting historical animation', async () => {
  const delivery = service(); const client = new AssetClient(config, { storage: createMemoryStorage(), fetch: delivery.fetch });
  await client.refresh(); await client.resolveAnimation(card1.ref);
  const staticSlot = clone(card1.slot); delete staticSlot.animation;
  delivery.state.release = envelope([staticSlot], 2); await client.refresh(); delivery.state.requests = [];
  assert.equal((await client.resolveAnimation(card1.ref)).source, 'poster'); assert.equal(delivery.state.requests.length, 0);
  delivery.state.release = envelope([card2.slot], 3); await client.refresh(); delivery.state.requests = [];
  assert.equal((await client.resolveAnimation(card1.ref)).source, 'poster'); assert.equal(delivery.state.requests.length, 0);
});

test('animation download bounds, redirects and storage failures return poster outcomes', async () => {
  for (const kind of ['oversize', 'redirect', 'storage']) {
    const delivery = service(); const storage = createMemoryStorage();
    const client = new AssetClient(config, { storage: kind === 'storage' ? { ...storage, putAsset: async () => { throw new Error('quota'); } } : storage,
      fetch: async (url, init) => {
        if (url.endsWith('/manifest') || kind === 'storage') return delivery.fetch(url, init);
        if (kind === 'oversize') return new Response(new Uint8Array(card1.bytes.length + 1));
        const response = new Response(card1.bytes); Object.defineProperty(response, 'redirected', { value: true }); return response;
      } });
    await client.refresh(); assert.equal((await client.resolveAnimation(card1.ref)).source, 'poster', kind);
  }
});
