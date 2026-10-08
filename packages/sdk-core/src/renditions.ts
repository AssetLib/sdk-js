import type { AssetlibConfig, AssetMime, AssetRef, AssetRendition, ManifestSlot, ResolveOptions } from './types.js';

const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const mimes: readonly string[] = ['image/webp', 'image/png', 'image/svg+xml'];
const hashPattern = /^[a-f0-9]{64}$/;

export function validateRenditions(payload: Record<string, unknown>, slot: Record<string, unknown>, config: AssetlibConfig): void {
  if (own(payload, 'renditionSchemaVersion') && payload.renditionSchemaVersion !== 1) throw new Error('Unsupported rendition schema.');
  if (!own(slot, 'renditions')) return;
  if (payload.renditionSchemaVersion !== 1 || !Array.isArray(slot.renditions) || slot.renditions.length < 1 || slot.renditions.length > 7) throw new Error('Invalid rendition extension.');
  const hashes = new Set<string>();
  for (const item of slot.renditions) {
    if (!record(item) || typeof item.sha256 !== 'string' || !hashPattern.test(item.sha256) || hashes.has(item.sha256) || typeof item.mime !== 'string' || !mimes.includes(item.mime) || !integer(item.bytes, 1, item.mime === 'image/svg+xml' ? 262144 : 8388608) || !integer(item.width, 1, 8192) || !integer(item.height, 1, 8192) || item.width * item.height > 16777216 || typeof item.url !== 'string') throw new Error('Invalid rendition.');
    const ratio = Number(slot.width) / Number(slot.height);
    if (Math.abs(item.width / item.height - ratio) / ratio > 0.02) throw new Error('Rendition aspect ratio does not match the placement.');
    const url = new URL(item.url, config.manifestUrl);
    if (url.origin !== new URL(config.manifestUrl).origin || url.username || url.password || url.search || url.hash || url.pathname !== `/api/delivery/${config.orgId}/${config.appId}/assets/${slot.assetId}/renditions/${item.sha256}`) throw new Error('Rendition URL is outside the configured app.');
    hashes.add(item.sha256);
  }
}

export function supportedFormats(formats: readonly AssetMime[] = ['image/webp', 'image/png']): readonly AssetMime[] {
  if (!Array.isArray(formats) || !formats.length || new Set(formats).size !== formats.length || !formats.includes('image/webp') || formats.some(mime => !mimes.includes(mime))) throw new Error('Supported formats must be unique known MIME types including image/webp.');
  return Object.freeze([...formats]);
}

export function targetPixels(ref: AssetRef, options: ResolveOptions): { width: number; height: number } {
  if (!record(options)) throw new Error('Invalid rendition target.');
  if (!own(options, 'pixelWidth') && !own(options, 'pixelHeight')) return { width: ref.width, height: ref.height };
  if (!integer(options.pixelWidth, 1, 8192) || !integer(options.pixelHeight, 1, 8192)) throw new Error('Supply both target pixel dimensions as integers between 1 and 8192.');
  return { width: options.pixelWidth, height: options.pixelHeight };
}

export type AssetCandidate = AssetRendition & { isRendition: boolean };
export function selectAssetCandidates(slot: ManifestSlot, target: { width: number; height: number }, formats: readonly AssetMime[]): AssetCandidate[] {
  const variants = (slot.renditions ?? []).filter(item => formats.includes(item.mime));
  const covers = (item: AssetRendition) => item.width >= target.width && item.height >= target.height;
  variants.sort((a, b) => {
    const vector = Number(b.mime === 'image/svg+xml') - Number(a.mime === 'image/svg+xml');
    if (vector) return vector;
    const coverage = Number(covers(b)) - Number(covers(a));
    if (coverage) return coverage;
    const area = a.width * a.height - b.width * b.height;
    return (covers(a) ? area : -area) || a.bytes - b.bytes || (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0);
  });
  return [...variants.map(item => ({ ...item, isRendition: true })), { ...slot, isRendition: false }];
}

/** Header checks supplement signed hashes; the platform renderer still must decode the image. */
export function validRenditionHeader(bytes: Uint8Array, candidate: AssetCandidate): boolean {
  if (!candidate.isRendition) return true; // Keep the existing opaque legacy transport contract.
  if (candidate.mime === 'image/png') {
    if (bytes.length < 33 || ![137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value)) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452 && view.getUint32(16) === candidate.width && view.getUint32(20) === candidate.height;
  }
  if (candidate.mime === 'image/webp') return bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0,4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8,12)) === 'WEBP';
  try {
    const svg = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return bytes.length <= 262144 && /^<svg\s/.test(svg) && !/<!|<\?|\b(?:href|style|on[a-z]+)\s*=|<(?:script|foreignObject|image|use|text|animate|set)\b/i.test(svg);
  } catch { return false; }
}
