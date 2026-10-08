import { Directory, File, Paths } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { SDK_LIMITS, type AssetlibConfig, type AssetStorage, type ResolvedAsset } from '@assetlib/sdk-core';
import { namespace, validateCacheKey, type ImageUri } from './shared';

export const platformFetch = expoFetch as unknown as typeof globalThis.fetch;
const locks = new Map<string, Promise<unknown>>();
function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}
function directories(config: AssetlibConfig) {
  const root = new Directory(Paths.document, 'assetlib-v1', namespace(config));
  const images = new Directory(root, 'images');
  root.create({ intermediates: true, idempotent: true });
  images.create({ intermediates: true, idempotent: true });
  return { root, images };
}
export function createPlatformStorage(config: AssetlibConfig): AssetStorage {
  const scope = namespace(config);
  const loadState = async () => {
    const { root } = directories(config);
    const candidates: string[] = [];
    // Retain a recoverable journal during replacement. An interrupted write fails
    // closed; it must never make the replay counter silently disappear.
    for (const name of ['state.json', 'state.next']) {
      const file = new File(root, name);
      if (!file.exists) continue;
      if (file.size > SDK_LIMITS.stateBytes) throw new Error('Stored state exceeds its bound.');
      candidates.push(await file.text());
    }
    return candidates.sort((a, b) => JSON.parse(b).highestSequence - JSON.parse(a).highestSequence)[0] ?? null;
  };
  return {
    loadState: () => exclusive(scope, loadState),
    saveState: serialized => exclusive(scope, async () => {
      if (new TextEncoder().encode(serialized).length > SDK_LIMITS.stateBytes) throw new Error('State exceeds its bound.');
      const old = await loadState();
      if (old) {
        const previous = JSON.parse(old), next = JSON.parse(serialized);
        if (previous.highestSequence > next.highestSequence || (previous.highestSequence === next.highestSequence && previous.history[0]?.payload !== next.history[0]?.payload)) throw new Error('A newer or conflicting sequence is already stored.');
      }
      const { root } = directories(config);
      const next = new File(root, 'state.next');
      next.create({ overwrite: true });
      next.write(serialized);
      await next.move(new File(root, 'state.json'), { overwrite: true });
    }),
    getAsset: async hash => {
      validateCacheKey(hash);
      const file = new File(directories(config).images, `${hash}.webp`);
      if (!file.exists || file.size > SDK_LIMITS.assetBytes) return null;
      return file.bytes();
    },
    putAsset: (hash, bytes) => exclusive(scope, async () => {
      validateCacheKey(hash);
      if (bytes.length > SDK_LIMITS.assetBytes) throw new Error('Image exceeds the cache entry bound.');
      const { images } = directories(config);
      for (const entry of images.list()) if (entry instanceof File && entry.name.endsWith('.next')) entry.delete();
      const entries = images.list().filter((entry): entry is File => entry instanceof File && entry.name.endsWith('.webp') && entry.name !== `${hash}.webp`).sort((a, b) => (a.modificationTime ?? 0) - (b.modificationTime ?? 0));
      let total = entries.reduce((sum, file) => sum + file.size, 0);
      while (entries.length >= SDK_LIMITS.cacheEntries || total + bytes.length > SDK_LIMITS.cacheBytes) {
        const oldest = entries.shift();
        if (!oldest) break;
        total -= oldest.size;
        oldest.delete();
      }
      const next = new File(images, `${hash}.next`);
      next.create({ overwrite: true }); next.write(bytes);
      await next.move(new File(images, `${hash}.webp`), { overwrite: true });
    }),
  };
}
export async function imageUri(config: AssetlibConfig, result: ResolvedAsset): Promise<ImageUri> {
  if (!result.sha256) throw new Error('Missing verified image hash.');
  validateCacheKey(result.sha256);
  const file = new File(directories(config).images, `${result.sha256}.webp`);
  if (!file.exists) throw new Error('The verified image was evicted from the local cache.');
  return { uri: file.uri, release() {} };
}
