import type { AssetlibConfig } from './types.js';

/** Largest signed clip, `SDK_LIMITS.videoBytes`. */
export const VIDEO_BYTES = 4 * 1024 * 1024;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const dimension = (value: unknown): value is number => integer(value, 16, 1280) && value % 2 === 0;

/** Optional `videoSchemaVersion: 1` and a `video` descriptor on a base placement (envelope `h264-loop-v1`). */
export function validateVideoExtension(payload: Record<string, unknown>, slot: Record<string, unknown>, config: AssetlibConfig): void {
  if (own(payload, 'videoSchemaVersion') && payload.videoSchemaVersion !== 1) throw new Error('Unsupported video schema.');
  if (!own(slot, 'video')) return;
  const v = slot.video;
  if (payload.videoSchemaVersion !== 1 || !record(v) || v.format !== 'mp4' || v.profile !== 'h264-loop-v1' || v.mime !== 'video/mp4' || typeof v.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.sha256) || typeof v.url !== 'string' || !integer(v.bytes, 1, VIDEO_BYTES)) throw new Error('Invalid signed video descriptor.');
  if (!dimension(v.width) || !dimension(v.height) || v.width * v.height > 921600) throw new Error('Video dimensions must be even, 16–1280, and at most 921,600 pixels.');
  if (!integer(v.durationMs, 1000, 10000) || typeof v.frameRate !== 'number' || !Number.isFinite(v.frameRate) || v.frameRate < 1 || v.frameRate > 30) throw new Error('Video timing must be 1,000–10,000 ms at 1–30 fps.');
  if (own(slot, 'animation')) throw new Error('A placement cannot carry both an animation and a video.');
  if (v.width * Number(slot.height) !== v.height * Number(slot.width)) throw new Error('Video aspect ratio does not exactly match the placement.');
  const url = new URL(v.url, config.manifestUrl);
  if (url.origin !== new URL(config.manifestUrl).origin || url.username || url.password || url.search || url.hash || url.pathname !== `/api/delivery/${config.orgId}/${config.appId}/assets/${slot.assetId}/videos/${v.sha256}`) throw new Error('Video URL is outside the configured app.');
}

type Box = { type: string; body: number; end: number };
const headerFailure = (message: string): never => { throw new Error(`Clip header check failed: ${message}`); };
function children(bytes: Uint8Array, view: DataView, start: number, end: number, budget: { boxes: number }): Box[] {
  const result: Box[] = [];
  for (let offset = start; offset < end;) {
    if (--budget.boxes < 0) headerFailure('too many boxes.');
    if (end - offset < 8) headerFailure('truncated box header.');
    let size = view.getUint32(offset), header = 8;
    if (size === 1) {
      if (end - offset < 16) headerFailure('truncated box header.');
      size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12); header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || size > end - offset) headerFailure('a box overruns its parent.');
    result.push({ type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)), body: offset + header, end: offset + size });
    offset += size;
  }
  return result;
}

/** Bounded structural check, run only after byte count and SHA-256 matched: `ftyp` first, `moov` before
 * the first `mdat`, not fragmented, and one track whose one sample entry is `avc1` at the signed size.
 * It decodes no frames; the platform player still has to decode the clip. */
export function checkMp4Header(bytes: Uint8Array, width: number, height: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 8 || String.fromCharCode(...bytes.subarray(4, 8)) !== 'ftyp') headerFailure('the file must start with ftyp.');
  const budget = { boxes: 1024 };
  const top = children(bytes, view, 0, bytes.byteLength, budget);
  let moov: Box | undefined;
  let mdat = false;
  for (const box of top) {
    if (box.type === 'moof') headerFailure('fragmented MP4 is not supported.');
    if (box.type === 'moov') { if (moov) headerFailure('more than one moov.'); moov = box; }
    if (box.type === 'mdat') { if (!moov) headerFailure('moov must come before mdat.'); mdat = true; }
  }
  if (!moov || !mdat) headerFailure('moov and mdat are required.');
  const only = (parent: Box, type: string): Box => {
    const found = children(bytes, view, parent.body, parent.end, budget).filter(box => box.type === type);
    return found.length === 1 ? found[0] : headerFailure(`expected exactly one ${type}.`);
  };
  if (children(bytes, view, moov!.body, moov!.end, budget).some(box => box.type === 'mvex')) headerFailure('fragmented MP4 is not supported.');
  const stsd = only(only(only(only(only(moov!, 'trak'), 'mdia'), 'minf'), 'stbl'), 'stsd');
  if (stsd.end - stsd.body < 8 || view.getUint32(stsd.body + 4) !== 1) headerFailure('expected exactly one sample entry.');
  const entries = children(bytes, view, stsd.body + 8, stsd.end, budget);
  if (entries.length !== 1 || entries[0].type !== 'avc1') headerFailure('the sample entry must be avc1.');
  // VisualSampleEntry: 8 bytes SampleEntry, 16 bytes predefined/reserved, then 16-bit width and height.
  if (entries[0].end - entries[0].body < 28) headerFailure('truncated avc1 sample entry.');
  if (view.getUint16(entries[0].body + 24) !== width || view.getUint16(entries[0].body + 26) !== height) headerFailure('avc1 dimensions do not match the signed descriptor.');
}
