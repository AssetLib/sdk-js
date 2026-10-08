import { hashBytes, type AssetlibConfig } from '@assetlib/sdk-core';
export const namespace = (config: AssetlibConfig): string => hashBytes(new TextEncoder().encode([config.manifestUrl, config.orgId, config.appId, config.environment, config.pinnedPublicKey].join('\n'))).slice(0, 32);
export type ImageUri = { uri: string; release(): void };
export function validateCacheKey(key: string): void { if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid cache key.'); }
