import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AssetClient, createMemoryStorage, hashBytes, parsePublicConfig } from '../dist/index.js';

const fixture = name => readFile(new URL(`./fixtures/${name}`, import.meta.url));
const config = parsePublicConfig(JSON.parse(await fixture('config.json')));
const seed = (await fixture('keys/TEST_ONLY_seed.hex')).toString().trim();
const privateKey = createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${seed}`, 'hex'), format: 'der', type: 'pkcs8' });
const ref = { key: 'travel.coast', width: 1200, height: 900, variants: { arm: ['b', 'c'], appearance: ['dark', 'light'] } };
const stateRef = { ...ref, states: ['empty', 'growing'] };
const data = new Map();
function signed(value) {
  const payload = JSON.stringify(value);
  return { algorithm: 'Ed25519', keyId: config.keyId, publicKey: config.pinnedPublicKey, payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') };
}
function descriptor(id) {
  const assetId = `33333333-3333-4333-8333-${String(id).padStart(12, '0')}`;
  const bytes = new TextEncoder().encode(`arm-artwork-${id}`);
  const url = `/api/delivery/${config.orgId}/${config.appId}/assets/${assetId}`;
  data.set(url, bytes);
  return { assetId, sha256: hashBytes(bytes), url, bytes: bytes.length, mime: 'image/webp' };
}
function release(sequence, stateful = false) {
  const family = id => {
    const image = descriptor(id);
    return { ...image, ...(stateful ? { states: { empty: image, growing: descriptor(id + 1) } } : {}) };
  };
  const slot = { ...ref, variants: structuredClone(ref.variants), screen: 'Travel', ...family(sequence * 100), ...(stateful ? { defaultState: 'empty' } : {}), cells: [
    { arm: 'b', appearance: 'dark', ...family(sequence * 100 + 10) },
    { arm: 'b', ...family(sequence * 100 + 20) },
    { appearance: 'dark', ...family(sequence * 100 + 30) },
    { arm: 'c', appearance: 'dark', ...family(sequence * 100 + 40) },
    { arm: 'c', ...family(sequence * 100 + 50) },
    { arm: 'b', appearance: 'light', ...family(sequence * 100 + 60) },
  ] };
  return { schemaVersion: 1, variantSchemaVersion: 1, ...(stateful ? { stateSchemaVersion: 1 } : {}), orgId: config.orgId, appId: config.appId, environment: config.environment, sequence, createdAt: '2026-10-08T12:00:00.000Z', slots: [slot] };
}
function harness(initial, options = {}) {
  let payload = initial, offline = false;
  const failed = new Set(), requests = [];
  const storage = createMemoryStorage();
  const fetch = async input => {
    if (input === config.manifestUrl) return new Response(JSON.stringify(signed(payload)));
    const url = new URL(input).pathname; requests.push(url);
    if (offline || failed.has(url)) throw new Error('offline');
    return new Response(data.get(url), { status: data.has(url) ? 200 : 404 });
  };
  const client = new AssetClient(config, { storage, fetch, ...options });
  return { client, storage, fetch, requests, setRelease: value => { payload = value; }, offline: () => { offline = true; }, fail: url => failed.add(url) };
}
async function refreshed(payload, options) {
  const h = harness(payload, options);
  assert.equal((await h.client.refresh()).error, undefined);
  return h;
}

for (const stateful of [false, true]) {
  const method = stateful ? 'resolveStateSet' : 'resolve';
  const reference = stateful ? stateRef : ref;
  for (let step = 0; step < 4; step++) test(`${method}: four-step arm/appearance resolution, step ${step + 1}`, async () => {
    const payload = release(1, stateful), slot = payload.slots[0];
    slot.cells.splice(0, step);
    const expected = step < 3 ? slot.cells[0] : slot;
    const h = await refreshed(payload);
    const result = await h.client[method](reference, { arm: 'b', appearance: 'dark' });
    assert.equal(result.source, 'remote');
    assert.equal(result.arm, step < 2 ? 'b' : null);
    assert.equal(result.armSource, 'explicit');
    if (stateful) {
      for (const name of reference.states) {
        assert.equal(result.states[name].assetId, expected.states[name].assetId);
        assert.equal(result.states[name].arm, result.arm);
        assert.equal(result.states[name].armSource, 'explicit');
      }
    } else assert.equal(result.assetId, expected.assetId);
    assert.deepEqual(h.requests, stateful ? Object.values(expected.states).map(value => value.url) : [expected.url]);
  });
  test(`${method}: omitted appearance and arm never borrow other coordinates`, async () => {
    const payload = release(1, stateful), slot = payload.slots[0], h = await refreshed(payload);
    for (const [options, expected, arm, armSource] of [
      [{ arm: 'b' }, slot.cells[1], 'b', 'explicit'],
      [{ appearance: 'dark' }, slot.cells[2], null, 'control'],
      [{ arm: 'control', appearance: 'light' }, slot, null, 'explicit'],
      [{ arm: 'unknown', appearance: 'dark' }, slot.cells[2], null, 'explicit'],
      [{}, slot, null, 'control'],
    ]) {
      const result = await h.client[method](reference, options);
      assert.equal(result.arm, arm); assert.equal(result.armSource, armSource);
      if (stateful) for (const name of reference.states) assert.equal(result.states[name].assetId, expected.states[name].assetId);
      else assert.equal(result.assetId, expected.assetId);
    }
  });
  test(`${method}: decision runs once with current signed declarations and supports promises`, async () => {
    const requests = [], payload = release(1, stateful);
    let choice = 'b';
    const h = await refreshed(payload, { decide: async request => { requests.push(request); return choice; } });
    const first = await h.client[method]({ ...reference, variants: { arm: ['ref-is-not-authority'] } }, { appearance: 'dark' });
    assert.equal(first.arm, 'b'); assert.equal(first.armSource, 'decision');
    assert.deepEqual(requests, [{ key: ref.key, arms: ['b', 'c'], appearance: 'dark' }]);
    assert.ok(Object.isFrozen(requests[0].arms));
    choice = 'c';
    const second = await h.client[method](reference);
    assert.equal(second.arm, 'c'); assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], { key: ref.key, arms: ['b', 'c'] });
    for (const arm of ['b', 'control', 'not-declared']) {
      const explicit = await h.client[method](reference, { arm });
      assert.equal(explicit.armSource, 'explicit');
    }
    assert.equal(requests.length, 2);
  });
  for (const [name, decide, reason] of [
    ['undefined', () => undefined, /returned no arm/],
    ['undeclared', () => 'd', /undeclared arm/],
    ['control', () => 'control', /undeclared arm/],
    ['non-string', () => null, /undeclared arm/],
    ['throws', () => { throw new Error('private experiment state'); }, /callback threw/],
    ['rejects', async () => { throw new Error('private experiment state'); }, /callback threw/],
  ]) test(`${method}: ${name} decision reports why control is used, including bundle fallback`, async () => {
    const payload = release(1, stateful), h = await refreshed(payload, { decide });
    const result = await h.client[method](reference, { appearance: 'dark' });
    assert.equal(result.arm, null); assert.equal(result.armSource, 'invalid-decision');
    assert.match(result.message, reason); assert.doesNotMatch(result.message, /private experiment state/);
    const expected = payload.slots[0].cells[2];
    if (stateful) for (const name of reference.states) {
      assert.equal(result.states[name].assetId, expected.states[name].assetId);
      assert.equal(result.states[name].armSource, 'invalid-decision');
    }
    else assert.equal(result.assetId, expected.assetId);
    h.offline();
    const bundle = await h.client[method](reference, { appearance: 'light' });
    assert.equal(bundle.source, 'bundle'); assert.equal(bundle.arm, null);
    assert.equal(bundle.armSource, 'invalid-decision'); assert.match(bundle.message, reason);
  });
  test(`${method}: no decision for a slot without arms, missing slots, or no signed history`, async () => {
    let calls = 0;
    const payload = release(1, stateful);
    delete payload.slots[0].variants.arm;
    payload.slots[0].cells = payload.slots[0].cells.filter(cell => !cell.arm);
    const h = harness(payload, { decide: () => { calls++; return 'b'; } });
    const bundle = await h.client[method](reference);
    assert.equal(bundle.armSource, 'control');
    await h.client.refresh();
    const result = await h.client[method](reference, { appearance: 'dark' });
    assert.equal(result.arm, null); assert.equal(result.armSource, 'control');
    await h.client[method]({ ...reference, key: 'missing' });
    assert.equal(calls, 0);
  });
  test(`${method}: history uses the same decision and never borrows another arm or appearance cache`, async () => {
    const old = release(1, stateful), next = release(2, stateful);
    let calls = 0;
    const h = await refreshed(old, { decide: () => { calls++; return 'b'; } });
    const first = await h.client[method](reference, { appearance: 'dark' });
    h.setRelease(next); await h.client.refresh(); h.offline();
    const previous = await h.client[method](reference, { appearance: 'dark' });
    assert.equal(calls, 2); assert.equal(previous.sequence, 1);
    assert.equal(previous.arm, 'b'); assert.equal(previous.armSource, 'decision');
    if (stateful) for (const name of reference.states) assert.equal(previous.states[name].sha256, first.states[name].sha256);
    else assert.equal(previous.sha256, first.sha256);
    for (const options of [{ arm: 'c', appearance: 'dark' }, { arm: 'b', appearance: 'light' }, { arm: 'control', appearance: 'dark' }]) {
      assert.equal((await h.client[method](reference, options)).source, 'bundle');
    }
    assert.equal(calls, 2);
  });
  test(`${method}: historical fallback uses arm-any, control-appearance, then legacy coordinates`, async () => {
    for (let step = 1; step < 4; step++) {
      const old = release(1, stateful); old.slots[0].cells.splice(0, step);
      const h = await refreshed(old);
      await h.client[method](reference, { arm: 'b', appearance: 'dark' });
      h.setRelease(release(2, stateful)); await h.client.refresh(); h.offline();
      const previous = await h.client[method](reference, { arm: 'b', appearance: 'dark' });
      assert.equal(previous.sequence, 1); assert.equal(previous.arm, step === 1 ? 'b' : null);
      assert.equal(previous.armSource, 'explicit');
    }
  });
}

for (const cachePolicy of ['disk', 'memory', 'none']) test(`${cachePolicy}: requested arm scopes identical fallback bytes and survives restart`, async () => {
  const payload = release(1); payload.slots[0].cells = [];
  const h = await refreshed(payload, { cachePolicy });
  const results = [];
  for (const arm of [undefined, 'control', 'b', 'c']) {
    for (const appearance of [undefined, 'dark', 'light']) results.push(await h.client.resolve(ref, { arm, appearance }));
  }
  assert.equal(new Set(results.map(result => result.sha256)).size, 1);
  assert.equal(new Set(results.map(result => result.cacheKey)).size, 9);
  assert.ok(results.every(result => result.arm === null));
  h.offline();
  assert.equal((await h.client.resolve(ref, { arm: 'b' })).source, cachePolicy === 'none' ? 'bundle' : 'cache');
  const restart = new AssetClient(config, { storage: h.storage, fetch: h.fetch, cachePolicy });
  assert.equal((await restart.resolve(ref, { arm: 'b', appearance: 'dark' })).source, cachePolicy === 'disk' ? 'cache' : 'bundle');
});

test('a partial arm state family never mixes control or other arm states', async () => {
  const payload = release(1, true), h = await refreshed(payload);
  await h.client.resolveStateSet(stateRef, { arm: 'control', appearance: 'dark' });
  await h.client.resolveStateSet(stateRef, { arm: 'c', appearance: 'dark' });
  h.fail(payload.slots[0].cells[0].states.growing.url);
  const result = await h.client.resolveStateSet(stateRef, { arm: 'b', appearance: 'dark' });
  assert.equal(result.source, 'bundle'); assert.equal(result.arm, null); assert.equal(result.armSource, 'explicit');
  assert.deepEqual(result.states, {});
});

test('selected arm metadata does not inherit the control descriptor', async () => {
  const payload = JSON.parse(JSON.parse(await fixture('manifests/valid-renditions-seq4.json')).payload);
  payload.variantSchemaVersion = 1;
  payload.slots[0].accessibility = { defaultLocale: 'en', descriptions: { en: 'Control only' } };
  const arm = descriptor(888);
  payload.slots[0].variants = { arm: ['b'] };
  payload.slots[0].cells = [{ arm: 'b', ...arm }];
  const h = await refreshed(payload, { decide: () => 'b' });
  const result = await h.client.resolve(ref, { pixelWidth: 120, pixelHeight: 90 });
  assert.equal(result.assetId, arm.assetId); assert.equal(result.accessibility, undefined);
  assert.deepEqual(h.requests, [arm.url]);
});

test('animation stays on control and never invokes the decision callback', async () => {
  const payload = JSON.parse(JSON.parse(await fixture('manifests/valid-animation-poster-seq5.json')).payload);
  const animation = payload.slots[0].animation;
  data.set(animation.url, new Uint8Array(await fixture('assets/animation.json')));
  payload.variantSchemaVersion = 1;
  payload.slots[0].variants = { arm: ['b'] };
  payload.slots[0].cells = [{ arm: 'b', ...descriptor(889) }];
  let calls = 0;
  const h = await refreshed(payload, { decide: () => { calls++; return 'b'; } });
  const result = await h.client.resolveAnimation(ref, { arm: 'b', appearance: 'dark' });
  assert.equal(result.source, 'remote'); assert.equal(result.assetId, payload.slots[0].assetId);
  assert.equal(calls, 0); assert.deepEqual(h.requests, [animation.url]);
});

test('cancellation after an asynchronous decision prevents artwork delivery', async () => {
  let finish;
  const started = new Promise(resolve => { finish = resolve; });
  let choose;
  const h = await refreshed(release(1), { decide: () => { finish(); return new Promise(resolve => { choose = resolve; }); } });
  const controller = new AbortController();
  const pending = h.client.resolve(ref, { signal: controller.signal });
  await started; controller.abort(); choose('b');
  await assert.rejects(pending, /cancelled/); assert.deepEqual(h.requests, []);
});

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function within(promise, ms = 400) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('operation stayed blocked')), ms); })]); }
  finally { clearTimeout(timer); }
}

for (const stateful of [false, true]) {
  const method = stateful ? 'resolveStateSet' : 'resolve';
  const reference = stateful ? stateRef : ref;
  test(`${method}: a never-resolving decision allows refresh, initialize and explicit requests, then times out`, async () => {
    const started = deferred(); let calls = 0;
    const h = await refreshed(release(1, stateful), { decisionTimeoutMs: 100, decide: () => { calls++; started.resolve(); return new Promise(() => {}); } });
    const pending = h.client[method](reference);
    await within(started.promise);
    h.setRelease(release(2, stateful));
    const [refresh, status, control, explicit] = await within(Promise.all([
      h.client.refresh(), h.client.initialize(), h.client[method](reference, { arm: 'control' }), h.client[method](reference, { arm: 'b' }),
    ]));
    assert.equal(refresh.sequence, 2); assert.equal(status.sequence, 2);
    assert.equal(control.armSource, 'explicit'); assert.equal(control.arm, null);
    assert.equal(explicit.armSource, 'explicit'); assert.equal(explicit.arm, 'b'); assert.equal(calls, 1);
    const result = await within(pending);
    assert.equal(result.sequence, 2); assert.equal(result.arm, null); assert.equal(result.armSource, 'invalid-decision');
    assert.match(result.message, /timed out/);
  });
  for (const concurrentClient of [false, true]) test(`${method}: decision resolves using ${concurrentClient ? 'another client\'s durable' : 'refreshed'} release`, async () => {
    const started = deferred(), choice = deferred();
    const h = await refreshed(release(1, stateful), { decide: () => { started.resolve(); return choice.promise; } });
    const pending = h.client[method](reference);
    await within(started.promise);
    const newer = release(2, stateful); h.setRelease(newer);
    const writer = concurrentClient ? new AssetClient(config, { storage: h.storage, fetch: h.fetch }) : h.client;
    assert.equal((await within(writer.refresh())).sequence, 2);
    choice.resolve('b');
    const result = await within(pending);
    assert.equal(result.sequence, 2); assert.equal(result.armSource, 'decision'); assert.equal(result.arm, 'b');
    const selected = newer.slots[0].cells[1];
    if (stateful) for (const name of reference.states) assert.equal(result.states[name].assetId, selected.states[name].assetId);
    else assert.equal(result.assetId, selected.assetId);
    assert.equal(h.client.getStatus().sequence, 2);
  });
  test(`${method}: decision is validated against the current release's declared arms`, async () => {
    const started = deferred(), choice = deferred();
    const h = await refreshed(release(1, stateful), { decide: () => { started.resolve(); return choice.promise; } });
    const pending = h.client[method](reference); await within(started.promise);
    const newer = release(2, stateful);
    newer.slots[0].variants.arm = ['c']; newer.slots[0].cells = newer.slots[0].cells.filter(cell => cell.arm !== 'b');
    h.setRelease(newer); await h.client.refresh(); choice.resolve('b');
    const result = await within(pending);
    assert.equal(result.sequence, 2); assert.equal(result.arm, null); assert.equal(result.armSource, 'invalid-decision');
    assert.match(result.message, /undeclared arm/);
  });
  for (const corruption of ['malformed', 'missing', 'rollback', 'conflict', 'throws']) test(`${method}: decision outliving ${corruption} durable state detection uses only the bundle`, async () => {
    const started = deferred(), choice = deferred(), base = createMemoryStorage();
    let replacement;
    const storage = { ...base, loadState: async () => {
      if (replacement === 'throws') throw new Error('storage unavailable');
      return replacement === undefined ? base.loadState() : replacement;
    } };
    const h = await refreshed(release(2, stateful), { storage, decide: () => { started.resolve(); return choice.promise; } });
    await h.client[method](reference, { arm: 'b' });
    h.requests.length = 0;
    const pending = h.client[method](reference); await within(started.promise);
    replacement = corruption === 'malformed' ? '{broken' : corruption === 'missing' ? null : corruption === 'throws' ? 'throws'
      : JSON.stringify({ version: 1, highestSequence: corruption === 'rollback' ? 1 : 2, history: [signed({ ...release(corruption === 'rollback' ? 1 : 2, stateful), createdAt: '2026-10-09T12:00:00.000Z' })] });
    const refresh = await within(h.client.refresh());
    choice.resolve('b');
    const result = await within(pending);
    assert.equal(result.source, 'bundle'); assert.equal(result.sequence, null); assert.equal(result.fallbackReason, 'verification');
    assert.match(refresh.error, /could not be verified/); assert.equal(h.requests.length, 0);
    assert.equal((await h.client[method](reference, { arm: 'control' })).source, 'bundle');
  });
}

test('decision timeout defaults to 1500 milliseconds', async t => {
  const started = deferred();
  const h = await refreshed(release(1), { decide: () => { started.resolve(); return new Promise(() => {}); } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolved = false;
  const pending = h.client.resolve(ref).then(result => { resolved = true; return result; });
  await started.promise;
  t.mock.timers.tick(1499); await Promise.resolve(); assert.equal(resolved, false);
  t.mock.timers.tick(1);
  t.mock.timers.reset();
  const result = await within(pending);
  assert.equal(result.armSource, 'invalid-decision'); assert.match(result.message, /timed out/);
});

test('decisionTimeoutMs accepts only integer milliseconds between 100 and 10000', () => {
  for (const decisionTimeoutMs of [99, 10001, 100.5, NaN, Infinity, '1500', true, null]) {
    assert.throws(() => new AssetClient(config, { storage: createMemoryStorage(), decisionTimeoutMs }), /decisionTimeoutMs/);
  }
  for (const decisionTimeoutMs of [100, 1500, 10000]) assert.doesNotThrow(() => new AssetClient(config, { storage: createMemoryStorage(), decisionTimeoutMs }));
});
