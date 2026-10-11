import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync, sign } from 'node:crypto';
import { AssetClient, SDK_LIMITS, createMemoryStorage, hashBytes, parsePublicConfig, verifySignedAssetPage, verifySignedManifest } from '../dist/index.js';
import { checkMp4Header } from '../dist/video.js';

const orgId = '11111111-1111-4111-8111-111111111111', appId = '22222222-2222-4222-8222-222222222222';
const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyId = hashBytes(new TextEncoder().encode(publicKey)).slice(0, 16);
const config = parsePublicConfig({ schemaVersion: 1, orgId, appId, environment: 'production', manifestUrl: `https://assets.example/api/delivery/${orgId}/${appId}/manifest`, pinnedPublicKey: publicKey });
// The pinned shared corpus clip: 320x240 H.264, 2 seconds at 30 fps.
const loop = new Uint8Array(await readFile(new URL('./fixtures/shared/assets/loop.mp4', import.meta.url)));
const ref = { key: 'cards.gold', width: 400, height: 300 };
const assetId = '33333333-3333-4333-8333-333333333333';
const poster = new TextEncoder().encode('poster');
const posterUrl = `/api/delivery/${orgId}/${appId}/assets/${assetId}`;
const descriptor = (clip = loop, changes = {}) => ({ format: 'mp4', profile: 'h264-loop-v1', mime: 'video/mp4', sha256: hashBytes(clip), url: `${posterUrl}/videos/${hashBytes(clip)}`, bytes: clip.length, width: 320, height: 240, durationMs: 2000, frameRate: 30, ...changes });
const slot = (video = descriptor(), changes = {}) => ({ ...ref, screen: 'Cards', assetId, sha256: hashBytes(poster), url: posterUrl, mime: 'image/webp', bytes: poster.length, ...(video ? { video } : {}), ...changes });
function envelope(slots = [slot()], sequence = 1, changes = {}) {
  const payload = JSON.stringify({ schemaVersion: 1, videoSchemaVersion: 1, orgId, appId, environment: 'production', sequence, createdAt: '2026-10-10T12:00:00.000Z', slots, ...changes });
  return { algorithm: 'Ed25519', keyId, publicKey, payload, signature: sign(null, Buffer.from(payload), pair.privateKey).toString('base64') };
}
function service(clips = [loop]) {
  const state = { release: envelope(), objects: new Map([[posterUrl, poster], ...clips.map(clip => [descriptor(clip).url, clip])]), requests: [], offline: false, delayMs: 0 };
  return { state, fetch: async (url, init) => {
    state.requests.push({ path: new URL(url).pathname, init });
    if (state.offline) throw new Error('offline');
    if (url === config.manifestUrl) return new Response(JSON.stringify(state.release));
    const body = state.objects.get(new URL(url).pathname);
    if (!body) return new Response('missing', { status: 404 });
    if (!state.delayMs) return new Response(body);
    // A body that arrives late; aborting the request cancels it.
    return new Response(new ReadableStream({ start(controller) {
      const timer = setTimeout(() => { controller.enqueue(body); controller.close(); }, state.delayMs);
      init.signal?.addEventListener('abort', () => { clearTimeout(timer); controller.error(new Error('aborted')); });
    } }));
  } };
}
const clipPaths = state => state.requests.map(request => request.path).filter(path => path.includes('/videos/'));
// Replace bytes inside a copy of the clip, for header mutations.
const patch = (offset, text) => { const copy = loop.slice(); copy.set(new TextEncoder().encode(text), offset); return copy; };
const box = (type, body = new Uint8Array()) => { const out = new Uint8Array(8 + body.length); new DataView(out.buffer).setUint32(0, out.length); out.set(new TextEncoder().encode(type), 4); out.set(body, 8); return out; };
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; } return out; };
// Top-level boxes of the corpus clip: ftyp 0–32, moov 32–1009 (avc1 at 421, udta at 948), free 1009–1017, mdat 1017–end.
const ftyp = loop.subarray(0, 32), moov = loop.subarray(32, 1009), mdat = loop.subarray(1017);

test('SDK_LIMITS exports the 4 MiB clip limit', () => {
  assert.equal(SDK_LIMITS.videoBytes, 4194304);
});

test('the MP4 header check accepts the corpus clip and rejects each structural failure', () => {
  assert.doesNotThrow(() => checkMp4Header(loop, 320, 240));
  for (const [name, bytes, width = 320, height = 240] of [
    ['not ftyp first', patch(4, 'free')],
    ['mdat before moov', concat(ftyp, mdat, moov)],
    ['no mdat', concat(ftyp, moov)],
    ['two moov boxes', concat(ftyp, moov, moov, mdat)],
    ['fragment after the media', concat(loop, box('moof'))],
    ['mvex in moov', patch(948 + 4, 'mvex')],
    ['not avc1', patch(421 + 4, 'hvc1')],
    ['width differs', loop, 322],
    ['height differs', loop, 320, 238],
    ['truncated', loop.subarray(0, loop.length - 1)],
    ['box larger than the file', (() => { const copy = loop.slice(); new DataView(copy.buffer).setUint32(1017, 0x7fffffff); return copy; })()],
    ['too many boxes', concat(ftyp, ...Array.from({ length: 1100 }, () => box('free')))],
    ['WebP bytes', new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')],
    ['empty', new Uint8Array()],
  ]) assert.throws(() => checkMp4Header(bytes, width, height), /Clip header check failed/, name);
  // A last box may declare size 0 ("to the end of the file").
  const open = loop.slice(); new DataView(open.buffer).setUint32(1017, 0);
  assert.doesNotThrow(() => checkMp4Header(open, 320, 240));
});

test('video descriptors are accepted only on base placements, behind the marker', () => {
  assert.equal(verifySignedManifest(envelope(), config).payload.slots[0].video.width, 320);
  assert.throws(() => verifySignedManifest(envelope(undefined, 1, { videoSchemaVersion: undefined }), config), /video descriptor/);
  // The marker alone, without any clip, is valid.
  assert.doesNotThrow(() => verifySignedManifest(envelope([slot(null)]), config));
  for (const value of [2, 0, null, '1']) assert.throws(() => verifySignedManifest(envelope([slot(null)], 1, { videoSchemaVersion: value }), config), /video schema/);
  for (const change of [
    { width: 321, height: 241 }, { width: 14, height: 10 }, { width: 1282, height: 962 }, { width: 1280, height: 960 }, { height: 238 },
    { durationMs: 999 }, { durationMs: 10001 }, { frameRate: 0.5 }, { frameRate: 30.5 }, { frameRate: Infinity }, { frameRate: '30' },
    { bytes: 0 }, { bytes: SDK_LIMITS.videoBytes + 1 }, { bytes: 1.5 }, { sha256: 'A'.repeat(64) },
    { url: `https://user@assets.example${descriptor().url}` }, { url: `${descriptor().url}#x` }, { url: descriptor().url.replace(assetId, '44444444-4444-4444-8444-444444444444') },
  ]) assert.throws(() => verifySignedManifest(envelope([slot(descriptor(loop, change))]), config), undefined, JSON.stringify(change));
  // A 30 fps limit allows non-integer NTSC rates; a 1280x720 clip fits a 16:9 placement.
  assert.doesNotThrow(() => verifySignedManifest(envelope([slot(descriptor(loop, { frameRate: 29.97 }))]), config));
  assert.doesNotThrow(() => verifySignedManifest(envelope([slot(descriptor(loop, { width: 1280, height: 720 }), { width: 1600, height: 900 })]), config));
  const states = { idle: { assetId, sha256: hashBytes(poster), url: posterUrl, mime: 'image/webp', bytes: poster.length }, active: { assetId, sha256: hashBytes(poster), url: posterUrl, mime: 'image/webp', bytes: poster.length } };
  assert.doesNotThrow(() => verifySignedManifest(envelope([slot(descriptor(), { states, defaultState: 'idle' })], 1, { stateSchemaVersion: 1 }), config));
  assert.throws(() => verifySignedManifest(envelope([slot(descriptor(), { states: { ...states, active: { ...states.active, video: descriptor() } }, defaultState: 'idle' })], 1, { stateSchemaVersion: 1 }), config), /base placement/);
  const page = { kind: 'asset-page', schemaVersion: 1, orgId, appId, environment: 'production', sequence: 1, createdAt: '2026-10-10T12:00:00.000Z', cursor: null, nextCursor: null,
    assets: [{ assetId, sha256: hashBytes(poster), url: posterUrl, mime: 'image/webp', bytes: poster.length, width: 400, height: 300, video: descriptor() }] };
  const payload = JSON.stringify(page);
  assert.throws(() => verifySignedAssetPage({ algorithm: 'Ed25519', keyId, publicKey, payload, signature: sign(null, Buffer.from(payload), pair.privateKey).toString('base64') }, config), /base placement/);
});

test('videoTimeoutMs defaults to 30 seconds and accepts 20 to 30000 milliseconds', () => {
  for (const videoTimeoutMs of [undefined, 20, 30000]) assert.doesNotThrow(() => new AssetClient(config, { storage: createMemoryStorage(), videoTimeoutMs }));
  for (const videoTimeoutMs of [19, 30001, 1.5, '100']) assert.throws(() => new AssetClient(config, { storage: createMemoryStorage(), videoTimeoutMs }), /videoTimeoutMs/);
});

test('ordinary resolution never downloads a clip; resolveVideo downloads, verifies and then reads the cache', async () => {
  const delivery = service(), client = new AssetClient(config, { storage: createMemoryStorage(), fetch: delivery.fetch });
  await client.refresh();
  assert.equal((await client.resolve(ref)).source, 'remote');
  assert.deepEqual(clipPaths(delivery.state), []);
  const downloaded = await client.resolveVideo(ref);
  assert.deepEqual({ ...downloaded, bytes: undefined, message: undefined }, { source: 'remote', sequence: 1, sha256: hashBytes(loop), assetId, mime: 'video/mp4', width: 320, height: 240, durationMs: 2000, frameRate: 30, bytes: undefined, message: undefined });
  assert.deepEqual(downloaded.bytes, loop);
  const request = delivery.state.requests.at(-1);
  assert.equal(request.init.headers.Accept, 'video/mp4');
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.redirect, 'error');
  assert.equal((await client.resolveVideo(ref)).source, 'cache');
  assert.deepEqual(clipPaths(delivery.state), [descriptor().url]);
  delivery.state.offline = true;
  assert.equal((await client.resolveVideo(ref)).source, 'cache');
  assert.equal((await new AssetClient(config, { storage: createMemoryStorage(), fetch: delivery.fetch }).resolveVideo(ref)).source, 'poster', 'first use offline gives the poster');
  await assert.rejects(client.resolveVideo({ ...ref, key: '../x' }), /Invalid generated asset reference/);
});

test('only the current release downloads; older releases are cache-only, and removing the clip gives the poster', async () => {
  const next = patch(loop.length - 1, String.fromCharCode(loop.at(-1) ^ 1));
  const delivery = service([loop, next]), storage = createMemoryStorage(), client = new AssetClient(config, { storage, fetch: delivery.fetch });
  await client.refresh(); assert.equal((await client.resolveVideo(ref)).source, 'remote');
  // Release 2 signs a different clip (one mdat byte differs) that the server no longer has.
  delivery.state.objects.delete(descriptor(next).url);
  delivery.state.release = envelope([slot(descriptor(next))], 2); await client.refresh(); delivery.state.requests = [];
  const fallback = await client.resolveVideo(ref);
  assert.equal(fallback.source, 'cache'); assert.equal(fallback.sequence, 1); assert.equal(fallback.sha256, hashBytes(loop));
  assert.deepEqual(clipPaths(delivery.state), [descriptor(next).url], 'the current release downloads; release 1 is read from the cache');
  // Retained history without cached bytes never authorizes an old download.
  const fresh = new AssetClient(config, { storage: (() => { const empty = createMemoryStorage(); empty.saveState = storage.saveState; empty.loadState = storage.loadState; return empty; })(), fetch: delivery.fetch });
  delivery.state.requests = [];
  assert.equal((await fresh.resolveVideo(ref)).source, 'poster');
  assert.deepEqual(clipPaths(delivery.state), [descriptor(next).url]);
  delivery.state.release = envelope([slot(null)], 3); await client.refresh(); delivery.state.requests = [];
  assert.equal((await client.resolveVideo(ref)).source, 'poster');
  assert.equal(delivery.state.requests.length, 0, 'a removed clip is not revived from history');
});

// Clips that differ only inside mdat: distinct hashes, valid headers.
const variant = offset => { const copy = loop.slice(); copy[copy.length - offset] ^= 1; return copy; };

test('an unusable current clip offline falls back to the newest verified cached clip from an older release', async () => {
  const [first, second, third] = [loop, variant(1), variant(2)];
  const delivery = service([first, second, third]), storage = createMemoryStorage(), client = new AssetClient(config, { storage, fetch: delivery.fetch });
  await client.refresh(); assert.equal((await client.resolveVideo(ref)).source, 'remote');
  delivery.state.release = envelope([slot(descriptor(second))], 2); await client.refresh();
  assert.equal((await client.resolveVideo(ref)).sequence, 2);
  delivery.state.release = envelope([slot(descriptor(third))], 3); await client.refresh();
  delivery.state.offline = true; delivery.state.requests = [];
  const result = await client.resolveVideo(ref);
  assert.equal(result.source, 'cache'); assert.equal(result.sequence, 2, 'newest retained release first'); assert.equal(result.sha256, hashBytes(second));
  assert.deepEqual(result.bytes, second);
  assert.deepEqual(clipPaths(delivery.state), [descriptor(third).url], 'only the current clip is requested');
});

test('a current release without a clip gives the poster even when an older release\'s clip is cached', async () => {
  const delivery = service(), storage = createMemoryStorage(), client = new AssetClient(config, { storage, fetch: delivery.fetch });
  await client.refresh(); assert.equal((await client.resolveVideo(ref)).source, 'remote');
  delivery.state.release = envelope([slot(null)], 2); await client.refresh(); delivery.state.requests = [];
  assert.deepEqual(await storage.getAsset(hashBytes(loop)), loop, 'the release 1 clip is still cached');
  const result = await client.resolveVideo(ref);
  assert.equal(result.source, 'poster'); assert.equal(result.sequence, null);
  assert.equal(delivery.state.requests.length, 0);
});

test('tampered cached clips are rehashed and replaced, and offline corruption gives the poster', async () => {
  const delivery = service(), storage = createMemoryStorage(), client = new AssetClient(config, { storage, fetch: delivery.fetch });
  await client.refresh(); await client.resolveVideo(ref);
  await storage.putAsset(hashBytes(loop), new Uint8Array(loop.length));
  assert.equal((await client.resolveVideo(ref)).source, 'remote');
  await storage.putAsset(hashBytes(loop), new Uint8Array(loop.length)); delivery.state.offline = true;
  assert.equal((await client.resolveVideo(ref)).source, 'poster');
});

test('a hash-valid clip that fails the header check is neither returned nor cached', async () => {
  const wrongSize = descriptor(loop, { width: 400, height: 300 });
  const delivery = service(), storage = createMemoryStorage(), client = new AssetClient(config, { storage, fetch: delivery.fetch });
  delivery.state.release = envelope([slot(wrongSize)]);
  await client.refresh();
  const result = await client.resolveVideo(ref);
  assert.equal(result.source, 'poster'); assert.match(result.message, /avc1 dimensions/);
  assert.equal(await storage.getAsset(hashBytes(loop)), null);
});

test('clips use their own deadline, separate from the image timeout', async () => {
  const delivery = service();
  const client = new AssetClient(config, { storage: createMemoryStorage(), fetch: delivery.fetch, timeoutMs: 20, videoTimeoutMs: 400 });
  await client.refresh();
  delivery.state.delayMs = 60;
  assert.equal((await client.resolve(ref)).source, 'bundle', 'the image deadline is 20 ms');
  assert.equal((await client.resolveVideo(ref)).source, 'remote', 'the clip deadline is 400 ms');
  const slow = new AssetClient(config, { storage: createMemoryStorage(), fetch: delivery.fetch, videoTimeoutMs: 20 });
  delivery.state.delayMs = 0; await slow.refresh(); delivery.state.delayMs = 200;
  const started = Date.now(), timedOut = await slow.resolveVideo(ref);
  assert.equal(timedOut.source, 'poster'); assert.match(timedOut.message, /timed out/);
  assert.ok(Date.now() - started < 150, 'the clip download stops at its deadline');
});

test('resolveVideo aborts through the signal', async () => {
  const delivery = service(), client = new AssetClient(config, { storage: createMemoryStorage(), fetch: delivery.fetch });
  await client.refresh();
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(client.resolveVideo(ref, { signal: aborted.signal }), /cancelled/);
  delivery.state.delayMs = 1000;
  const controller = new AbortController();
  const pending = client.resolveVideo(ref, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, /cancelled/);
});

test('download bounds, redirects and storage failures give the poster', async () => {
  for (const kind of ['oversize', 'redirect', 'storage', 'missing']) {
    const delivery = service(), storage = createMemoryStorage();
    const client = new AssetClient(config, { storage: kind === 'storage' ? { ...storage, putAsset: async () => { throw new Error('quota'); } } : storage,
      fetch: async (url, init) => {
        if (url.endsWith('/manifest') || kind === 'storage') return delivery.fetch(url, init);
        if (kind === 'missing') return new Response(null, { status: 404 });
        if (kind === 'oversize') return new Response(concat(loop, new Uint8Array(1)));
        const response = new Response(loop); Object.defineProperty(response, 'redirected', { value: true }); return response;
      } });
    await client.refresh(); assert.equal((await client.resolveVideo(ref)).source, 'poster', kind);
  }
});

test('a file-backed adapter receives clips as a file URI and needs the disk policy', async () => {
  const disk = new Map(), writes = [];
  const storage = { ...createMemoryStorage(),
    async getAsset(hash) { return disk.get(hash)?.bytes.slice() ?? null; },
    async putAsset(hash, bytes, mime) { writes.push(mime); disk.set(hash, { bytes: bytes.slice(), mime }); },
    async getAssetFileUri(hash, mime) { return disk.get(hash)?.mime === mime ? `file:///cache/${hash}.mp4` : null; } };
  const delivery = service();
  const client = new AssetClient(config, { storage, fetch: delivery.fetch });
  await client.refresh();
  const downloaded = await client.resolveVideo(ref);
  assert.equal(downloaded.source, 'remote'); assert.equal(downloaded.uri, `file:///cache/${hashBytes(loop)}.mp4`); assert.equal(downloaded.bytes, undefined);
  assert.deepEqual(writes, ['video/mp4']);
  const cached = await client.resolveVideo(ref);
  assert.equal(cached.source, 'cache'); assert.equal(cached.uri, downloaded.uri);
  delivery.state.requests = [];
  for (const cachePolicy of ['memory', 'none']) {
    const result = await client.resolveVideo(ref, { cachePolicy });
    assert.equal(result.source, 'poster', cachePolicy); assert.match(result.message, /disk cache policy/);
  }
  assert.equal(delivery.state.requests.length, 0, 'no clip is downloaded that the player could not open');
  storage.getAssetFileUri = async () => null;
  assert.equal((await client.resolveVideo(ref)).source, 'poster', 'a missing local file gives the poster');
});

test('memory and none policies return verified bytes from an adapter without file URIs', async () => {
  for (const cachePolicy of ['memory', 'none']) {
    const delivery = service(), storage = createMemoryStorage(), client = new AssetClient(config, { storage, fetch: delivery.fetch, cachePolicy });
    await client.refresh();
    const result = await client.resolveVideo(ref);
    assert.equal(result.source, 'remote'); assert.deepEqual(result.bytes, loop); assert.equal(result.uri, undefined);
    assert.equal(await storage.getAsset(hashBytes(loop)), null, `${cachePolicy} writes nothing to the durable adapter`);
    assert.equal(delivery.state.requests.at(-1).init.cache, 'no-store');
    assert.equal((await client.resolveVideo(ref)).source, cachePolicy === 'memory' ? 'cache' : 'remote');
  }
});
