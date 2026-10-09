import { hashBytes, SDK_LIMITS, type AssetlibConfig, type ResolvedAsset } from '@assetlib/sdk-core';
export const namespace = (config: AssetlibConfig): string => hashBytes(new TextEncoder().encode([config.manifestUrl, config.orgId, config.appId, config.environment, config.pinnedPublicKey].join('\n'))).slice(0, 32);
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
