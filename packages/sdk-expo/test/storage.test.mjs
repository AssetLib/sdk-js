import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { AssetClient, hashBytes, parsePublicConfig } from '../../sdk-core/dist/index.js';

// Exercise the real platform implementations and SDK verifier. Only the native
// filesystem and IndexedDB platform boundaries are replaced; no adapter logic is mocked.
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(path.join(root, 'test/.storage-'));
after(async () => { delete globalThis.__assetlibStorage; delete globalThis.indexedDB; await rm(temporary, { recursive: true, force: true }); });
const transpile = async name => {
  const core = pathToFileURL(path.join(root, '../sdk-core/dist/index.js')).href;
  const source = (await readFile(path.join(root, 'src', name), 'utf8'))
    .replaceAll("'@assetlib/sdk-core'", `'${core}'`).replaceAll("'./shared'", "'./shared.mjs'")
    .replaceAll("'expo-file-system'", "'./filesystem.mjs'").replaceAll("'expo/fetch'", "'./fetch.mjs'");
  await writeFile(path.join(temporary, name.replace(/\.ts$/, '.mjs')), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
};
await writeFile(path.join(temporary, 'fetch.mjs'), 'export const fetch = globalThis.fetch;');
await writeFile(path.join(temporary, 'filesystem.mjs'), `
const key = parts => parts.map(part => part.uri ?? part).join('/').replace(/\\/+/g, '/');
const data = () => globalThis.__assetlibStorage;
export class File {
  constructor(...parts) { this.uri = key(parts); this.name = this.uri.split('/').at(-1); }
  get exists() { data().reads.push(this.uri); return data().files.has(this.uri); }
  get size() { const value = data().files.get(this.uri); return typeof value === 'string' ? new TextEncoder().encode(value).length : value?.length ?? 0; }
  get modificationTime() { return 0; }
  async text() { data().reads.push(this.uri); const value = data().files.get(this.uri); return typeof value === 'string' ? value : new TextDecoder().decode(value); }
  async bytes() { data().reads.push(this.uri); const value = data().files.get(this.uri); return typeof value === 'string' ? new TextEncoder().encode(value) : value.slice(); }
  create() { data().files.set(this.uri, ''); }
  write(value) { data().files.set(this.uri, typeof value === 'string' ? value : value.slice()); }
  copy(target) { const value = data().files.get(this.uri); data().files.set(target.uri, typeof value === 'string' ? value : value.slice()); }
  move(target) { this.copy(target); data().files.delete(this.uri); this.uri = target.uri; }
  delete() { data().files.delete(this.uri); }
}
export class Directory {
  constructor(...parts) { this.uri = key(parts); this.name = this.uri.split('/').at(-1); }
  get exists() { return data().directories.has(this.uri) || [...data().files.keys()].some(name => name.startsWith(this.uri + '/')); }
  create() { data().directories.add(this.uri); }
  list() {
    const names = new Map();
    for (const path of [...data().files.keys(), ...data().directories]) {
      if (!path.startsWith(this.uri + '/')) continue;
      const child = path.slice(this.uri.length + 1), name = child.split('/')[0];
      names.set(name, child.includes('/') || data().directories.has(path) ? new Directory(this.uri, name) : new File(this.uri, name));
    }
    return [...names.values()];
  }
  delete() { for (const name of data().files.keys()) if (name.startsWith(this.uri + '/')) data().files.delete(name); data().directories.delete(this.uri); }
}
export const Paths = { document: '/documents' };
`);
await Promise.all(['shared.ts', 'platform.native.ts', 'platform.web.ts'].map(transpile));
const shared = await import(pathToFileURL(path.join(temporary, 'shared.mjs')).href);
const adapters = Object.fromEntries(await Promise.all(['native', 'web'].map(async platform => [platform, await import(pathToFileURL(path.join(temporary, `platform.${platform}.mjs`)).href)])));

// Small event-driven IDB double: requests keep a transaction alive and all
// transactions for a database serialize, including distinct adapter instances.
function fakeIndexedDB() {
  const databases = new Map(), opens = [];
  const database = name => {
    let db = databases.get(name);
    if (!db) { db = { stores: new Map(), tail: Promise.resolve() }; databases.set(name, db); }
    return db;
  };
  return { databases, opens, database, api: {
    databases: async () => [...databases.keys()].map(name => ({ name, version: 1 })),
    open(name) {
      opens.push(name); const request = {};
      setImmediate(() => {
        const fresh = !databases.has(name), db = database(name);
        const connection = {
          objectStoreNames: { contains: store => db.stores.has(store) },
          createObjectStore(store, options = {}) { db.stores.set(store, { values: new Map(), keyPath: options.keyPath }); },
          close() {},
          transaction(names, mode) {
            const stores = Array.isArray(names) ? names : [names];
            let active = false, failed = false, pending = 0, generation = 0, finish;
            const ready = db.tail;
            db.tail = new Promise(resolve => { finish = resolve; });
            const working = new Map();
            const jobs = [];
            const complete = () => {
              const check = ++generation;
              setImmediate(() => {
                if (!active || failed || pending || check !== generation) return;
                if (mode === 'readwrite') for (const [store, value] of working) db.stores.set(store, value);
                active = false; tx.oncomplete?.(); finish();
              });
            };
            const enqueue = action => {
              const req = {}; pending++; generation++;
              const run = () => setImmediate(() => {
                if (failed) return;
                try { req.result = action(); req.onsuccess?.({ target: req }); }
                catch (error) { req.error = error; req.onerror?.({ target: req }); tx.abort(); }
                pending--; complete();
              });
              if (active) run(); else jobs.push(run);
              return req;
            };
            const tx = {
              abort() { if (failed) return; failed = true; setImmediate(() => { tx.onabort?.(); finish(); }); },
              objectStore(store) {
                assert.ok(stores.includes(store), `store ${store} belongs to transaction`);
                const contents = () => working.get(store);
                return {
                  get: key => enqueue(() => structuredClone(contents().values.get(key))),
                  getAll: () => enqueue(() => structuredClone([...contents().values.values()])),
                  put: (value, key) => enqueue(() => { const entry = contents(); entry.values.set(key ?? value[entry.keyPath], structuredClone(value)); }),
                  delete: key => enqueue(() => { contents().values.delete(key); }),
                  clear: () => enqueue(() => { contents().values.clear(); }),
                };
              },
            };
            ready.then(() => {
              if (failed) return;
              for (const store of stores) { const original = db.stores.get(store); assert.ok(original, `store ${store} exists`); working.set(store, { keyPath: original.keyPath, values: new Map(original.values) }); }
              active = true; for (const job of jobs) job(); complete();
            });
            return tx;
          },
        };
        request.result = connection;
        if (fresh) request.onupgradeneeded?.({ target: request });
        request.onsuccess?.({ target: request });
      });
      return request;
    },
  } };
}

const orgId = '11111111-1111-4111-8111-111111111111';
const appId = '22222222-2222-4222-8222-222222222222';
const assetId = '33333333-3333-4333-8333-333333333333';
const keys = Array.from({ length: 3 }, () => {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { ...pair, publicKey, keyId: createHash('sha256').update(publicKey).digest('hex').slice(0, 16) };
});
const bytes = new TextEncoder().encode('verified stored raster bytes');
const ref = { key: 'travel.coast', width: 1200, height: 900 };
const configFor = (pins = [keys[0].publicKey], scoped = false, environment = 'production') => parsePublicConfig({ schemaVersion: 1, orgId, appId, environment,
  manifestUrl: `https://assets.example/api/delivery/${orgId}/${appId}${scoped || environment === 'staging' ? `/environments/${environment}` : ''}/manifest`, pinnedPublicKeys: pins });
const envelope = (sequence, key = keys[0], environment = 'production') => {
  const payload = JSON.stringify({ schemaVersion: 1, orgId, appId, environment, sequence, createdAt: '2026-10-09T12:00:00.000Z', slots: [{ ...ref, screen: 'Travel', assetId, sha256: hashBytes(bytes), url: `/api/delivery/${orgId}/${appId}/assets/${assetId}`, mime: 'image/webp', bytes: bytes.length }] });
  return { algorithm: 'Ed25519', publicKey: key.publicKey, keyId: key.keyId, payload, signature: sign(null, Buffer.from(payload), key.privateKey).toString('base64') };
};
const stateFor = (sequence, history = [envelope(sequence)]) => JSON.stringify({ version: 1, highestSequence: sequence, history });
const hashTuple = values => hashBytes(new TextEncoder().encode(values.join('\n'))).slice(0, 32);
const currentNamespace = config => hashBytes(new TextEncoder().encode(JSON.stringify([new URL(config.manifestUrl).origin, config.orgId, config.appId, config.environment]))).slice(0, 32);
const oldSingleNamespace = (config, pin = config.pinnedPublicKey) => hashTuple([config.manifestUrl, config.orgId, config.appId, config.environment, pin]);
const oldSetNamespace = config => { const pins = [...new Set(config.pinnedPublicKeys ?? [config.pinnedPublicKey])].sort(); return oldSingleNamespace(config, pins.length === 1 ? pins[0] : JSON.stringify(pins)); };
function harness(platform) {
  const files = new Map(), reads = [], directories = new Set(), idb = fakeIndexedDB();
  globalThis.__assetlibStorage = { files, reads, directories };
  globalThis.indexedDB = idb.api;
  const store = scope => {
    const db = idb.database(`assetlib-v1-${scope}`);
    if (!db.stores.has('meta')) db.stores.set('meta', { values: new Map() });
    if (!db.stores.has('images')) db.stores.set('images', { keyPath: 'hash', values: new Map() });
    return db.stores;
  };
  return {
    storage: config => adapters[platform].createPlatformStorage(config),
    seed(scope, state, cache = true) {
      if (platform === 'native') { files.set(`/documents/assetlib-v1/${scope}/state.json`, state); if (cache) files.set(`/documents/assetlib-v1/${scope}/images/${hashBytes(bytes)}.webp`, bytes.slice()); }
      else { store(scope).get('meta').values.set('state', state); if (cache) store(scope).get('images').values.set(hashBytes(bytes), { hash: hashBytes(bytes), bytes: bytes.slice().buffer, savedAt: 1 }); }
    },
    state(scope) { return platform === 'native' ? files.get(`/documents/assetlib-v1/${scope}/state.json`) : store(scope).get('meta').values.get('state'); },
    deleteState(scope) { if (platform === 'native') files.delete(`/documents/assetlib-v1/${scope}/state.json`); else store(scope).get('meta').values.delete('state'); },
    legacyReads(scopes) { return platform === 'native' ? reads.filter(value => scopes.some(scope => value.includes(`/assetlib-v1/${scope}/`))).length : idb.opens.filter(value => scopes.some(scope => value === `assetlib-v1-${scope}`)).length; },
  };
}
const service = (sequence = 3) => {
  const state = { sequence, offline: false, environment: 'production' };
  return { state, fetch: async url => { if (state.offline) throw new Error('offline'); return new Response(url.endsWith('/manifest') ? JSON.stringify(envelope(state.sequence, keys[0], state.environment)) : bytes); } };
};

test('durable namespace uses exactly origin, organization, app, and environment', () => {
  const config = configFor();
  assert.equal(shared.namespace(config), currentNamespace(config));
  assert.equal(shared.namespace(configFor([keys[0].publicKey, keys[1].publicKey], true)), shared.namespace(config));
  assert.equal(shared.namespace(configFor([keys[1].publicKey], true)), shared.namespace(config));
  for (const changed of [{ ...config, orgId: appId }, { ...config, appId: orgId }, { ...config, environment: 'staging' }, { ...config, manifestUrl: config.manifestUrl.replace('assets.example', 'other.example') }]) assert.notEqual(shared.namespace(changed), shared.namespace(config));
});

test('legacy namespace probing has a finite work budget for expanded trust sets', () => {
  const config = { ...configFor(), pinnedPublicKeys: Array.from({ length: 13 }, (_, index) => `test-pin-${index}`) };
  let probes = 0;
  assert.throws(() => { for (const _scope of shared.legacyNamespaces(config)) probes++; }, /Legacy namespace migration exceeds its probe limit\./);
  assert.equal(probes, 4096, 'the migration budget bounds actual candidate probes');
});

const largePinnedSet = [...keys.map(key => key.publicKey), ...Array.from({ length: 10 }, () => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString())];

for (const platform of ['native', 'web']) {
  test(`${platform}: exhausting the legacy probe budget fails closed before delivery`, async () => {
    const h = harness(platform), config = configFor(largePinnedSet, true), storage = h.storage(config);
    let fetches = 0;
    await assert.rejects(storage.loadState(), /Legacy namespace migration exceeds its probe limit\./);
    const client = new AssetClient(config, { storage, fetch: async () => { fetches++; return new Response(JSON.stringify(envelope(1))); } });
    assert.match((await client.initialize()).lastError, /could not be verified/);
    assert.match((await client.refresh()).error, /could not be verified/);
    assert.equal((await client.resolve(ref)).source, 'bundle');
    assert.equal(fetches, 0, 'an incomplete migration cannot be mistaken for a fresh install');
  });

  for (const [name, nextConfig] of [
    ['expanding pinned keys', () => configFor([keys[0].publicKey, keys[1].publicKey])],
    ['switching to the environment production URL', () => configFor([keys[0].publicKey], true)],
  ]) test(`${platform}: accepted sequence and cached artwork survive ${name}`, async () => {
    const h = harness(platform), remote = service();
    const first = new AssetClient(configFor(), { storage: h.storage(configFor()), fetch: remote.fetch });
    assert.equal((await first.refresh()).sequence, 3);
    assert.equal((await first.resolve(ref)).source, 'remote');
    const config = nextConfig(), restarted = new AssetClient(config, { storage: h.storage(config), fetch: remote.fetch });
    assert.equal((await restarted.initialize()).sequence, 3);
    remote.state.sequence = 1;
    assert.match((await restarted.refresh()).error, /older release/);
    remote.state.offline = true;
    const cached = await restarted.resolve(ref);
    assert.equal(cached.source, 'cache'); assert.equal(cached.sequence, 3); assert.deepEqual(cached.bytes, bytes);
  });

  test(`${platform}: staging and production durable state remain isolated`, async () => {
    const h = harness(platform), remote = service(), production = configFor(), staging = configFor([keys[0].publicKey], true, 'staging');
    const prodClient = new AssetClient(production, { storage: h.storage(production), fetch: remote.fetch });
    assert.equal((await prodClient.refresh()).sequence, 3); await prodClient.resolve(ref);
    const stageClient = new AssetClient(staging, { storage: h.storage(staging), fetch: remote.fetch });
    assert.equal((await stageClient.initialize()).sequence, 0);
    remote.state.sequence = 1; remote.state.environment = 'staging';
    assert.equal((await stageClient.refresh()).sequence, 1);
    assert.equal((await new AssetClient(production, { storage: h.storage(production), fetch: remote.fetch }).initialize()).sequence, 3);
  });

  for (const formula of ['single-key', 'sorted-key-set', 'set-only-single-key']) test(`${platform}: verified ${formula} legacy state migrates once with its cache`, async () => {
    const h = harness(platform), oldConfig = configFor([keys[0].publicKey, keys[1].publicKey]);
    const oldScope = formula === 'sorted-key-set' ? oldSetNamespace(oldConfig) : oldSingleNamespace(oldConfig, formula === 'single-key' ? keys[0].publicKey : undefined);
    const config = configFor([keys[1].publicKey, keys[0].publicKey], true), scope = currentNamespace(config);
    h.seed(oldScope, stateFor(3));
    const storage = h.storage(config);
    const loaded = await storage.loadState();
    assert.equal(JSON.parse(loaded).highestSequence, 3, 'adapter loadState performs verified migration');
    const remote = service(1), client = new AssetClient(config, { storage, fetch: remote.fetch });
    assert.equal((await client.initialize()).sequence, 3);
    assert.equal(JSON.parse(h.state(scope)).highestSequence, 3);
    assert.match((await client.refresh()).error, /older release/);
    remote.state.offline = true;
    assert.equal((await client.resolve(ref)).source, 'cache', 'legacy cached bytes accompany verified replay state');
    h.seed(oldScope, stateFor(4));
    const reads = h.legacyReads([oldScope]);
    assert.equal((await new AssetClient(config, { storage: h.storage(config), fetch: remote.fetch }).initialize()).sequence, 3);
    assert.equal(h.legacyReads([oldScope]), reads, 'subsequent instances never reopen migrated legacy namespaces');
    h.deleteState(scope);
    await assert.rejects(h.storage(config).loadState(), /state|migration|missing/i, 'a completed migration marker prevents old state resurrection');
    assert.equal(h.legacyReads([oldScope]), reads);
  });

  test(`${platform}: an old sorted-key-set namespace survives a trust-set expansion during upgrade`, async () => {
    const h = harness(platform), oldConfig = configFor([keys[0].publicKey, keys[1].publicKey]);
    const config = configFor(keys.map(key => key.publicKey), true), oldScope = oldSetNamespace(oldConfig);
    h.seed(oldScope, stateFor(3));
    const remote = service(1), client = new AssetClient(config, { storage: h.storage(config), fetch: remote.fetch });
    assert.equal((await client.initialize()).sequence, 3);
    assert.match((await client.refresh()).error, /older release/);
    remote.state.offline = true;
    assert.equal((await client.resolve(ref)).source, 'cache');
  });

  test(`${platform}: valid signed legacy state from another manifest origin is never migrated`, async () => {
    const h = harness(platform), config = configFor([keys[0].publicKey, keys[1].publicKey], true);
    const foreign = { ...configFor([keys[0].publicKey, keys[1].publicKey]), manifestUrl: configFor().manifestUrl.replace('assets.example', 'foreign.example') };
    const scope = oldSetNamespace(foreign), raw = stateFor(3);
    h.seed(scope, raw);
    const client = new AssetClient(config, { storage: h.storage(config), fetch: async () => { throw new Error('offline'); } });
    assert.equal((await client.initialize()).sequence, 0);
    assert.equal((await client.resolve(ref)).source, 'bundle');
    assert.equal(h.state(scope), raw, 'other origins remain untouched even though their signatures verify');
  });

  test(`${platform}: legacy migration chooses the highest verified sequence across both formulas`, async () => {
    const h = harness(platform), config = configFor([keys[0].publicKey, keys[1].publicKey], true), legacy = configFor([keys[0].publicKey, keys[1].publicKey]);
    h.seed(oldSingleNamespace(legacy, keys[0].publicKey), stateFor(3));
    h.seed(oldSetNamespace(legacy), stateFor(4));
    const client = new AssetClient(config, { storage: h.storage(config), fetch: service().fetch });
    assert.equal((await client.initialize()).sequence, 4);
  });

  for (const [name, invalid] of [
    ['corrupt JSON', () => '{broken'],
    ['forged signature', () => stateFor(3, [{ ...envelope(3), signature: envelope(3, keys[2]).signature }])],
    ['untrusted retained history', () => stateFor(3, [envelope(3), envelope(2, keys[2])])],
    ['mismatched replay counter', () => stateFor(4, [envelope(3)])],
  ]) test(`${platform}: migration ignores ${name} without deleting it or trusting cached bytes`, async () => {
    const h = harness(platform), config = configFor([keys[0].publicKey, keys[1].publicKey], true), oldScope = oldSingleNamespace(configFor(), keys[0].publicKey), raw = invalid();
    h.seed(oldScope, raw);
    const client = new AssetClient(config, { storage: h.storage(config), fetch: async () => { throw new Error('offline'); } });
    assert.equal((await client.initialize()).sequence, 0);
    assert.equal((await client.resolve(ref)).source, 'bundle');
    assert.equal(h.state(oldScope), raw, 'unverified legacy state remains untouched');
    assert.equal(h.state(currentNamespace(config)), undefined, 'unverified state is never published in the durable namespace');
  });

  test(`${platform}: corrupt current state is never overwritten by valid legacy state`, async () => {
    const h = harness(platform), config = configFor([keys[0].publicKey], true), scope = currentNamespace(config), oldScope = oldSingleNamespace(configFor(), keys[0].publicKey);
    h.seed(scope, '{broken'); h.seed(oldScope, stateFor(3));
    const client = new AssetClient(config, { storage: h.storage(config), fetch: service().fetch });
    assert.match((await client.initialize()).lastError, /could not be verified/);
    assert.equal((await client.resolve(ref)).source, 'bundle');
    assert.equal(h.state(scope), '{broken'); assert.equal(h.state(oldScope), stateFor(3));
  });

  test(`${platform}: a missing migrated state cannot be reset by a direct stale save`, async () => {
    const h = harness(platform), config = configFor([keys[0].publicKey], true), oldScope = oldSingleNamespace(configFor(), keys[0].publicKey);
    h.seed(oldScope, stateFor(3));
    assert.equal(JSON.parse(await h.storage(config).loadState()).highestSequence, 3);
    h.deleteState(currentNamespace(config));
    await assert.rejects(h.storage(config).saveState(stateFor(1)), /state|migration|missing/i);
    assert.equal(h.state(currentNamespace(config)), undefined);
  });

  test(`${platform}: concurrent migration rejects a save older than the verified legacy release`, async () => {
    const h = harness(platform), config = configFor([keys[0].publicKey], true), oldScope = oldSingleNamespace(configFor(), keys[0].publicKey);
    h.seed(oldScope, stateFor(3));
    const migrating = h.storage(config), saving = h.storage(config);
    const results = await Promise.allSettled([migrating.loadState(), saving.saveState(stateFor(1))]);
    assert.equal(results[1].status, 'rejected', 'a writer cannot reset the replay floor while migration is pending');
    assert.equal(JSON.parse(await h.storage(config).loadState()).highestSequence, 3);
  });

  test(`${platform}: concurrent migration and a newer save cannot regress durable state`, async () => {
    const h = harness(platform), config = configFor([keys[0].publicKey], true), oldScope = oldSingleNamespace(configFor(), keys[0].publicKey);
    h.seed(oldScope, stateFor(3));
    const migrating = h.storage(config), saving = h.storage(config);
    await Promise.all([migrating.loadState(), saving.saveState(stateFor(4))]);
    assert.equal(JSON.parse(await h.storage(config).loadState()).highestSequence, 4);
  });
}
