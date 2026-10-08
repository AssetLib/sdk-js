import { SDK_LIMITS, type AssetlibConfig, type AssetStorage, type ResolvedAsset } from '@assetlib/sdk-core';
import { namespace, validateCacheKey, type ImageUri } from './shared';
export const platformFetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args);

function database(config: AssetlibConfig): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('IndexedDB is required for persistent release verification.'));
    const request = indexedDB.open(`assetlib-v1-${namespace(config)}`, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('meta'); request.result.createObjectStore('images', { keyPath: 'hash' }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Could not open the Assetlib cache.'));
    request.onblocked = () => reject(new Error('Close other Assetlib tabs to update this cache.'));
  });
}
export function createPlatformStorage(config: AssetlibConfig): AssetStorage {
  async function transaction<T>(storeName: 'meta' | 'images', mode: IDBTransactionMode, work: (store: IDBObjectStore, done: (result: T) => void, abort: (error: Error) => void) => void): Promise<T> {
    const db = await database(config);
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      let result: T;
      let failure: Error | null = null;
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = tx.onerror = () => { db.close(); reject(failure ?? new Error('Assetlib cache transaction failed.')); };
      try { work(tx.objectStore(storeName), value => { result = value; }, error => { failure = error; tx.abort(); }); }
      catch (error) { failure = error instanceof Error ? error : new Error('Invalid cache operation.'); tx.abort(); }
    });
  }
  return {
    loadState: () => transaction('meta', 'readonly', (store, done) => { const request = store.get('state'); request.onsuccess = () => done(request.result ?? null); }),
    saveState: value => transaction('meta', 'readwrite', (store, done, abort) => {
      if (new TextEncoder().encode(value).length > SDK_LIMITS.stateBytes) return abort(new Error('State exceeds its bound.'));
      const request = store.get('state');
      request.onsuccess = () => {
        try {
          if (request.result) {
            const previous = JSON.parse(request.result), next = JSON.parse(value);
            if (previous.highestSequence > next.highestSequence || (previous.highestSequence === next.highestSequence && previous.history[0]?.payload !== next.history[0]?.payload)) return abort(new Error('A newer or conflicting sequence is already stored.'));
          }
          store.put(value, 'state'); done(undefined);
        } catch { abort(new Error('Existing replay state is corrupt.')); }
      };
    }),
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
  const uri = URL.createObjectURL(new Blob([result.bytes.slice().buffer as ArrayBuffer], { type: 'image/webp' }));
  return { uri, release: () => URL.revokeObjectURL(uri) };
}
