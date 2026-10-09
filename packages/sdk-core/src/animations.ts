import { LOTTIE_LIMITS, validateLottie, validateLottieMetadata, type ValidatedLottie } from './lottie.js';
import type { AnimationDescriptor, AssetlibConfig } from './types.js';

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hashPattern = /^[a-f0-9]{64}$/;
export function validateAnimationExtension(payload: Record<string, unknown>, slot: Record<string, unknown>, config: AssetlibConfig): void {
  if (own(payload, 'animationSchemaVersion') && payload.animationSchemaVersion !== 1) throw new Error('Unsupported animation schema.');
  if (!own(slot, 'animation')) return;
  const a = slot.animation;
  if (payload.animationSchemaVersion !== 1 || !record(a) || a.format !== 'lottie' || a.profile !== 'vector-v1' || a.mime !== 'application/json' || typeof a.sha256 !== 'string' || !hashPattern.test(a.sha256) || typeof a.url !== 'string' || !Number.isSafeInteger(a.bytes) || Number(a.bytes) < 1 || Number(a.bytes) > LOTTIE_LIMITS.bytes) throw new Error('Invalid signed animation descriptor.');
  validateLottieMetadata(a as AnimationDescriptor);
  if (Number(a.width) * Number(slot.height) !== Number(a.height) * Number(slot.width)) throw new Error('Animation aspect ratio does not exactly match the placement.');
  const url = new URL(a.url, config.manifestUrl);
  if (url.origin !== new URL(config.manifestUrl).origin || url.username || url.password || url.search || url.hash || url.pathname !== `/api/delivery/${config.orgId}/${config.appId}/assets/${slot.assetId}/animations/${a.sha256}`) throw new Error('Animation URL is outside the configured app.');
}

/** Call only after byte count and SHA-256 have matched the signed descriptor. */
export function verifiedAnimationData(bytes: Uint8Array, descriptor: AnimationDescriptor): ValidatedLottie {
  const parsed = validateLottie(bytes);
  for (const key of ['width', 'height', 'frameRate', 'inPoint', 'outPoint'] as const) {
    if (parsed[key] !== descriptor[key]) throw new Error('Animation JSON metadata does not match the signed descriptor.');
  }
  return parsed;
}
