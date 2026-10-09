import { hashBytes, SDK_LIMITS, storageNamespace, type AssetlibConfig, type ResolvedAsset } from '@assetlib/sdk-core';
export const namespace = storageNamespace;

/** Both shipped formulas, including a former single pin and either production route. */
export function* legacyNamespaces(config: AssetlibConfig): Generator<string> {
  const keys = [...new Set(config.pinnedPublicKeys ?? (config.pinnedPublicKey ? [config.pinnedPublicKey] : []))].sort();
  const pins = new Set<string | undefined>([config.pinnedPublicKey, ...keys, keys.length === 1 ? keys[0] : JSON.stringify(keys)]);
  const base = `${new URL(config.manifestUrl).origin}/api/delivery/${config.orgId}/${config.appId}`;
  const urls = new Set([config.manifestUrl, `${base}/environments/${config.environment}/manifest`]);
  if (config.environment === 'production') urls.add(`${base}/manifest`);
  let probes = 0;
  const scopes = function* (pin: string | undefined) {
    for (const url of urls) {
      if (++probes > 4096) throw new Error('Legacy namespace migration exceeds its probe limit.');
      yield hashBytes(new TextEncoder().encode([url, config.orgId, config.appId, config.environment, pin].join('\n'))).slice(0, 32);
    }
  };
  for (const pin of pins) yield* scopes(pin);
  // An upgrade can coincide with adding pins. The old sorted-set formula may
  // therefore describe any subset of the current set, including unused pins.
  // Generate lazily within a fixed work budget. Exhaustion fails closed rather
  // than silently treating an unsearched previous namespace as a fresh install.
  const subsets = function* (start: number, subset: string[]): Generator<string> {
    for (let i = start; i < keys.length; i++) {
      const next = [...subset, keys[i]];
      if (next.length > 1 && next.length < keys.length) yield* scopes(JSON.stringify(next));
      yield* subsets(i + 1, next);
    }
  };
  yield* subsets(0, []);
}
/** The core supplies an origin/org/app key independent of environment and signing key. */
export const installStorageKey = (key: string): string => hashBytes(new TextEncoder().encode(key));
export type ImageUri = { uri: string; release(): void };
export function validateCacheKey(key: string): void { if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid cache key.'); }

/** Encodes only already verified raster bytes; no file or additional network request is created. */
export function rasterDataUri(result: ResolvedAsset): ImageUri {
  if (!result.bytes?.length || result.bytes.length > SDK_LIMITS.assetBytes || !['image/png', 'image/webp'].includes(result.mime ?? '')) throw new Error('Missing or unsupported verified raster bytes.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const parts: string[] = [];
  let part = '';
  for (let offset = 0; offset < result.bytes.length; offset += 3) {
    const a = result.bytes[offset], b = result.bytes[offset + 1], c = result.bytes[offset + 2];
    part += alphabet[a >> 2] + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)] + (b === undefined ? '=' : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]) + (c === undefined ? '=' : alphabet[c & 63]);
    if (part.length >= 16384) { parts.push(part); part = ''; }
  }
  if (part) parts.push(part);
  return { uri: `data:${result.mime};base64,${parts.join('')}`, release() {} };
}
