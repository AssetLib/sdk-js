import { Directory, File, Paths } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { SDK_LIMITS, verifyStoredState, type AssetlibConfig, type AssetStorage, type ResolvedAsset } from '@assetlib/sdk-core';
import { namespace, legacyNamespaces, installStorageKey, rasterDataUri, validateCacheKey, type ImageUri } from './shared';

export const vectorRenderingSupported = false;
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
  let migrationChecked = false;
  const readState = async (root: Directory) => {
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
  const writeState = async (root: Directory, serialized: string) => {
    const next = new File(root, 'state.next');
    next.create({ overwrite: true }); next.write(serialized);
    // The journal already contains the full replay state before the marker is
    // written. A crash at either step cannot make this look like a fresh install.
    const marker = new File(root, 'migration.complete');
    marker.create({ overwrite: true }); marker.write('1');
    await next.move(new File(root, 'state.json'), { overwrite: true });
  };
  const loadState = async () => {
    const { root, images } = directories(config);
    const current = await readState(root);
    if (current !== null) { migrationChecked = true; return current; }
    if (new File(root, 'migration.complete').exists) throw new Error('Previously persisted replay state is missing.');
    if (migrationChecked) return null;
    let selected: { root: Directory; raw: string; sequence: number; payload: string } | undefined;
    for (const legacy of legacyNamespaces(config)) {
      const oldRoot = new Directory(Paths.document, 'assetlib-v1', legacy);
      let raw: string | null, state: ReturnType<typeof verifyStoredState>;
      try {
        raw = await readState(oldRoot);
        if (raw === null) continue;
        state = verifyStoredState(raw, config);
      } catch { continue; } // Invalid old state is ignored, never removed.
      if (selected?.sequence === state.highestSequence && selected.payload !== state.history[0].payload) throw new Error('Conflicting legacy replay state.');
      if (!selected || state.highestSequence > selected.sequence) selected = { root: oldRoot, raw, sequence: state.highestSequence, payload: state.history[0].payload };
    }
    if (!selected) { migrationChecked = true; return null; }
    // Copy bounded artwork before publishing metadata. The core rehashes every
    // copied cache entry before use, including arm and appearance cache keys.
    const oldImages = new Directory(selected.root, 'images');
    let count = 0, bytes = 0;
    if (oldImages.exists) for (const entry of oldImages.list()) {
      if (!(entry instanceof File) || !/^[a-f0-9]{64}\.(webp|png)$/.test(entry.name) || entry.size > SDK_LIMITS.assetBytes || entry.size < 1) continue;
      if (count >= SDK_LIMITS.cacheEntries || bytes + entry.size > SDK_LIMITS.cacheBytes) continue;
      await entry.copy(new File(images, entry.name), { overwrite: true });
      count++; bytes += entry.size;
    }
    await writeState(root, selected.raw);
    migrationChecked = true;
    // Destination is durable before deleting any verified source. Interrupted
    // cleanup is harmless: the destination prevents all future legacy reads.
    try {
      if (await readState(selected.root) === selected.raw) for (const name of ['state.json', 'state.next']) {
        const file = new File(selected.root, name);
        if (file.exists) file.delete();
      }
    } catch { /* Retain the old copy if cleanup fails. */ }
    return selected.raw;
  };
  return {
    getOrCreateInstallId: (key, create) => exclusive(`install:${installStorageKey(key)}`, async () => {
      const root = new Directory(Paths.document, 'assetlib-installs-v1');
      root.create({ intermediates: true, idempotent: true });
      const name = installStorageKey(key);
      for (const suffix of ['.id', '.next']) {
        const file = new File(root, `${name}${suffix}`);
        if (!file.exists || file.size > 64) continue;
        const value = await file.text();
        if (/^[a-f0-9]{32}$/.test(value)) return value;
      }
      let value: string;
      try { value = create(); }
      catch {
        // Expo's native runtime supplies secure UUIDs even without Web Crypto.
        const nativeUuid = (globalThis as typeof globalThis & { expo?: { uuidv4?: () => string } }).expo?.uuidv4?.();
        if (typeof nativeUuid !== 'string') throw new Error('Secure install ID generation is unavailable.');
        value = nativeUuid.replaceAll('-', '').toLowerCase();
      }
      if (!/^[a-f0-9]{32}$/.test(value)) throw new Error('Invalid random install ID.');
      const next = new File(root, `${name}.next`);
      next.create({ overwrite: true }); next.write(value);
      await next.move(new File(root, `${name}.id`), { overwrite: true });
      return value;
    }),
    loadState: () => exclusive(scope, loadState),
    saveState: serialized => exclusive(scope, async () => {
      if (new TextEncoder().encode(serialized).length > SDK_LIMITS.stateBytes) throw new Error('State exceeds its bound.');
      const old = await loadState();
      if (old) {
        const previous = JSON.parse(old), next = JSON.parse(serialized);
        if (previous.highestSequence > next.highestSequence || (previous.highestSequence === next.highestSequence && previous.history[0]?.payload !== next.history[0]?.payload)) throw new Error('A newer or conflicting sequence is already stored.');
      }
      await writeState(directories(config).root, serialized);
    }),
    getAsset: async hash => {
      validateCacheKey(hash);
      const { images } = directories(config);
      for (const extension of ['webp', 'png']) {
        const file = new File(images, `${hash}.${extension}`);
        if (file.exists && file.size <= SDK_LIMITS.assetBytes) return file.bytes();
      }
      return null;
    },
    putAsset: (hash, bytes, mime = 'image/webp') => exclusive(scope, async () => {
      if (!['image/webp', 'image/png'].includes(mime)) throw new Error('This native adapter supports raster images only.');
      const extension = mime === 'image/png' ? 'png' : 'webp';
      validateCacheKey(hash);
      if (bytes.length > SDK_LIMITS.assetBytes) throw new Error('Image exceeds the cache entry bound.');
      const { images } = directories(config);
      for (const entry of images.list()) if (entry instanceof File && entry.name.endsWith('.next')) entry.delete();
      const entries = images.list().filter((entry): entry is File => entry instanceof File && /\.(webp|png)$/.test(entry.name) && entry.name !== `${hash}.${extension}`).sort((a, b) => (a.modificationTime ?? 0) - (b.modificationTime ?? 0));
      let total = entries.reduce((sum, file) => sum + file.size, 0);
      while (entries.length >= SDK_LIMITS.cacheEntries || total + bytes.length > SDK_LIMITS.cacheBytes) {
        const oldest = entries.shift();
        if (!oldest) break;
        total -= oldest.size;
        oldest.delete();
      }
      const next = new File(images, `${hash}.next`);
      next.create({ overwrite: true }); next.write(bytes);
      await next.move(new File(images, `${hash}.${extension}`), { overwrite: true });
    }),
  };
}
export async function imageUri(config: AssetlibConfig, result: ResolvedAsset): Promise<ImageUri> {
  if (!result.sha256) throw new Error('Missing verified image hash.');
  validateCacheKey(result.sha256);
  if (!['image/webp', 'image/png'].includes(result.mime ?? '')) throw new Error('Unsupported native image format.');
  if (result.cachePolicy === 'memory' || result.cachePolicy === 'none') return rasterDataUri(result);
  const cacheKey = result.cacheKey ?? result.sha256;
  validateCacheKey(cacheKey);
  const extension = result.mime === 'image/png' ? 'png' : 'webp';
  const file = new File(directories(config).images, `${cacheKey}.${extension}`);
  if (!file.exists) throw new Error('The verified image was evicted from the local cache.');
  return { uri: file.uri, release() {} };
}
