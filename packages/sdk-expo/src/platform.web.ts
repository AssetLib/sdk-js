import { SDK_LIMITS, verifyStoredState, type AssetlibConfig, type AssetStorage, type ResolvedAsset } from '@assetlib/sdk-core';
import { namespace, legacyNamespaces, installStorageKey, validateCacheKey, type ImageUri } from './shared';
export const vectorRenderingSupported = true;
export const platformFetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args);

function database(config: AssetlibConfig, install = false, scope = namespace(config)): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('IndexedDB is required for persistent release verification.'));
    const request = indexedDB.open(install ? 'assetlib-installs-v1' : `assetlib-v1-${scope}`, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('meta'); if (!install) request.result.createObjectStore('images', { keyPath: 'hash' }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Could not open the Assetlib cache.'));
    request.onblocked = () => reject(new Error('Close other Assetlib tabs to update this cache.'));
  });
}
export function createPlatformStorage(config: AssetlibConfig): AssetStorage {
  let migrationChecked = false;
  async function transaction<T>(storeName: 'meta' | 'images' | ['meta', 'images'], mode: IDBTransactionMode, work: (store: IDBObjectStore, done: (result: T) => void, abort: (error: Error) => void, tx: IDBTransaction) => void, install = false, scope = namespace(config)): Promise<T> {
    const db = await database(config, install, scope);
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      let result: T;
      let failure: Error | null = null;
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = tx.onerror = () => { db.close(); reject(failure ?? new Error('Assetlib cache transaction failed.')); };
      try { work(tx.objectStore(Array.isArray(storeName) ? storeName[0] : storeName), value => { result = value; }, error => { failure = error; tx.abort(); }, tx); }
      catch (error) { failure = error instanceof Error ? error : new Error('Invalid cache operation.'); tx.abort(); }
    });
  }
  const readCurrent = () => transaction<string | null>('meta', 'readonly', (store, done, abort) => {
    const request = store.get('state');
    request.onsuccess = () => {
      if (request.result != null) return done(request.result);
      const marker = store.get('migration-complete');
      marker.onsuccess = () => marker.result ? abort(new Error('Previously persisted replay state is missing.')) : done(null);
    };
  });
  const loadState = async (): Promise<string | null> => {
    const current = await readCurrent();
    if (current !== null) { migrationChecked = true; return current; }
    if (migrationChecked) return null;
    // Only probe namespaces calculated for this origin/app/environment. Signed
    // manifests with relative URLs alone cannot establish an old cache's origin.
    const existing = typeof globalThis.indexedDB.databases === 'function' ? new Set((await indexedDB.databases()).map(db => db.name)) : null;
    let selected: { scope: string; raw: string; sequence: number; payload: string } | undefined;
    for (const scope of legacyNamespaces(config)) {
      if (existing && !existing.has(`assetlib-v1-${scope}`)) continue;
      const raw = await transaction<string | null>('meta', 'readonly', (store, done) => { const request = store.get('state'); request.onsuccess = () => done(request.result ?? null); }, false, scope);
      if (raw === null) continue;
      let state: ReturnType<typeof verifyStoredState>;
      try { state = verifyStoredState(raw, config); } catch { continue; }
      if (selected?.sequence === state.highestSequence && selected.payload !== state.history[0].payload) throw new Error('Conflicting legacy replay state.');
      if (!selected || state.highestSequence > selected.sequence) selected = { scope, raw, sequence: state.highestSequence, payload: state.history[0].payload };
    }
    if (!selected) { migrationChecked = true; return readCurrent(); }
    const source = selected;
    const entries = await transaction<{ hash: string; bytes: ArrayBuffer; savedAt: number }[]>('images', 'readonly', (store, done) => {
      const request = store.getAll(); request.onsuccess = () => done(request.result);
    }, false, source.scope);
    const migrated = await transaction<string>(['meta', 'images'], 'readwrite', (store, done, abort, tx) => {
      // Recheck inside the destination write transaction: another tab may have
      // migrated or accepted a newer release while legacy state was being read.
      const request = store.get('state');
      request.onsuccess = () => {
        if (request.result != null) return done(request.result);
        const marker = store.get('migration-complete');
        marker.onsuccess = () => {
          if (marker.result) return abort(new Error('Previously persisted replay state is missing.'));
          const images = tx.objectStore('images');
          // No release is active yet. Replace interrupted migration cache data
          // and commit bounded bytes, replay state, and marker in one transaction.
          images.clear();
          let count = 0, bytes = 0;
          for (const entry of entries) {
            if (!entry || !/^[a-f0-9]{64}$/.test(entry.hash) || !(entry.bytes instanceof ArrayBuffer) || entry.bytes.byteLength > SDK_LIMITS.assetBytes || entry.bytes.byteLength < 1) continue;
            if (count >= SDK_LIMITS.cacheEntries || bytes + entry.bytes.byteLength > SDK_LIMITS.cacheBytes) continue;
            images.put({ hash: entry.hash, bytes: entry.bytes, savedAt: Number.isFinite(entry.savedAt) ? entry.savedAt : 0 });
            count++; bytes += entry.bytes.byteLength;
          }
          store.put(source.raw, 'state'); store.put(true, 'migration-complete'); done(source.raw);
        };
      };
    });
    migrationChecked = true;
    if (migrated === source.raw) {
      try {
        await transaction<void>('meta', 'readwrite', (store, done) => {
          const request = store.get('state'); request.onsuccess = () => { if (request.result === source.raw) store.delete('state'); done(undefined); };
        }, false, source.scope);
      } catch { /* Destination is durable; a leftover source is never read again. */ }
    }
    return migrated;
  };
  return {
    getOrCreateInstallId: (key, create) => transaction('meta', 'readwrite', (store, done, abort) => {
      const storedKey = installStorageKey(key);
      const request = store.get(storedKey);
      request.onsuccess = () => {
        try {
          if (typeof request.result === 'string' && /^[a-f0-9]{32}$/.test(request.result)) return done(request.result);
          const value = create();
          if (!/^[a-f0-9]{32}$/.test(value)) return abort(new Error('Invalid random install ID.'));
          store.put(value, storedKey); done(value);
        } catch { abort(new Error('Could not persist the random install ID.')); }
      };
    }, true),
    loadState,
    saveState: async value => {
      await loadState();
      return transaction('meta', 'readwrite', (store, done, abort) => {
        if (new TextEncoder().encode(value).length > SDK_LIMITS.stateBytes) return abort(new Error('State exceeds its bound.'));
        const request = store.get('state');
        request.onsuccess = () => {
          try {
            if (request.result) {
              const previous = JSON.parse(request.result), next = JSON.parse(value);
              if (previous.highestSequence > next.highestSequence || (previous.highestSequence === next.highestSequence && previous.history[0]?.payload !== next.history[0]?.payload)) return abort(new Error('A newer or conflicting sequence is already stored.'));
            }
            const persist = () => { store.put(value, 'state'); store.put(true, 'migration-complete'); done(undefined); };
            if (request.result != null) return persist();
            const marker = store.get('migration-complete');
            marker.onsuccess = () => marker.result ? abort(new Error('Previously persisted replay state is missing.')) : persist();
          } catch { abort(new Error('Existing replay state is corrupt.')); }
        };
      });
    },
    getAsset: hash => transaction('images', 'readonly', (store, done) => {
      validateCacheKey(hash);
      const request = store.get(hash);
      request.onsuccess = () => { const bytes = request.result?.bytes; done(bytes instanceof ArrayBuffer && bytes.byteLength <= SDK_LIMITS.assetBytes ? new Uint8Array(bytes) : null); };
    }),
    putAsset: (hash, bytes) => transaction('images', 'readwrite', (store, done, abort) => {
      validateCacheKey(hash);
      if (bytes.length > SDK_LIMITS.assetBytes) return abort(new Error('Image exceeds the cache entry bound.'));
      const request = store.getAll();
      request.onsuccess = () => {
        const entries = request.result.filter(entry => entry.hash !== hash).sort((a, b) => a.savedAt - b.savedAt);
        let total = entries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
        while (entries.length >= SDK_LIMITS.cacheEntries || total + bytes.length > SDK_LIMITS.cacheBytes) { const oldest = entries.shift(); if (!oldest) break; total -= oldest.bytes.byteLength; store.delete(oldest.hash); }
        store.put({ hash, bytes: bytes.slice().buffer, savedAt: Date.now() }); done(undefined);
      };
    }),
  };
}
export async function imageUri(_config: AssetlibConfig, result: ResolvedAsset): Promise<ImageUri> {
  if (!result.bytes) throw new Error('Missing verified image bytes.');
  const uri = URL.createObjectURL(new Blob([result.bytes.slice().buffer as ArrayBuffer], { type: result.mime ?? 'image/webp' }));
  try {
    await new Promise<void>((resolve, reject) => {
      const image = new globalThis.Image();
      const timer = setTimeout(() => { image.onload = image.onerror = null; image.src = ''; reject(new Error('Image decoding exceeded its deadline.')); }, 8000);
      image.onload = () => {
        clearTimeout(timer);
        const valid = image.naturalWidth > 0 && image.naturalHeight > 0 && image.naturalWidth <= 8192 && image.naturalHeight <= 8192 && image.naturalWidth * image.naturalHeight <= 16777216 &&
          (result.pixelWidth === undefined || (image.naturalWidth === result.pixelWidth && image.naturalHeight === result.pixelHeight));
        valid ? resolve() : reject(new Error('Decoded image dimensions do not match the signed rendition.'));
      };
      image.onerror = () => { clearTimeout(timer); reject(new Error('The verified image could not be decoded.')); };
      image.src = uri;
    });
    return { uri, release: () => URL.revokeObjectURL(uri) };
  } catch (error) { URL.revokeObjectURL(uri); throw error; }
}
