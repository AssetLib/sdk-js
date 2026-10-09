/** Dependency-free validation shared with upload services. This is deliberately a
 * small, versioned Lottie subset, not a general-purpose Lottie sanitizer. */
export const LOTTIE_LIMITS = Object.freeze({ bytes: 524288, dimension: 2048, pixels: 4194304, frameRate: 60, seconds: 30, frames: 1800, depth: 32, nodes: 30000, layers: 32, shapes: 2048, keyframes: 4096, vertices: 4096 });
export type LottieMetadata = { width: number; height: number; frameRate: number; inPoint: number; outPoint: number };
export type ValidatedLottie = LottieMetadata & { data: Record<string, unknown> };
type ObjectValue = Record<string, unknown>;
function fail(message: string): never { throw new Error(`Lottie vector-v1: ${message}`); }
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (value: ObjectValue, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e9;
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;

export function validateLottieMetadata(value: LottieMetadata): void {
  if (!integer(value.width, 1, LOTTIE_LIMITS.dimension) || !integer(value.height, 1, LOTTIE_LIMITS.dimension) || value.width * value.height > LOTTIE_LIMITS.pixels) fail('dimensions must be integers from 1 to 2048.');
  if (!number(value.frameRate) || value.frameRate < 1 || value.frameRate > LOTTIE_LIMITS.frameRate || !number(value.inPoint) || value.inPoint < 0 || !number(value.outPoint) || value.outPoint <= value.inPoint || value.outPoint - value.inPoint > LOTTIE_LIMITS.frames || (value.outPoint - value.inPoint) / value.frameRate > LOTTIE_LIMITS.seconds) fail('use 1–60 fps and a positive timeline no longer than 30 seconds / 1800 frames.');
}

function fields(value: unknown, allowed: readonly string[], label: string): ObjectValue {
  if (!object(value)) return fail(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`unsupported ${label} field "${key}"; remove expressions, resources, effects, or extensions and export simple vector shapes.`);
  for (const key of ['nm', 'mn']) if (own(value, key) && typeof value[key] !== 'string') fail(`${label} names must be strings.`);
  return value;
}
function vector(value: unknown, size?: number): value is number[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 4 && (size === undefined || value.length === size) && value.every(number);
}
function optionalNumber(value: ObjectValue, key: string): void { if (own(value, key) && !number(value[key])) fail(`"${key}" must be a finite number.`); }

export function validateLottie(bytes: Uint8Array): ValidatedLottie {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > LOTTIE_LIMITS.bytes) return fail('JSON must be between 1 byte and 512 KiB.');
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return fail('provide valid UTF-8 Lottie JSON.'); }
  // Count every value before examining it, including otherwise unused metadata.
  let nodes = 0;
  function bounded(value: unknown, depth = 0): void {
    if (++nodes > LOTTIE_LIMITS.nodes || depth > LOTTIE_LIMITS.depth) fail('document exceeds the complexity/depth limit; simplify the animation.');
    if (typeof value === 'number' && !number(value)) fail('all numbers must be finite and bounded.');
    if (typeof value === 'string' && value.length > 500) fail('metadata strings must be at most 500 characters.');
    if (Array.isArray(value)) for (const item of value) bounded(item, depth + 1);
    else if (object(value)) for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('prototype fields are unsupported.');
      bounded(item, depth + 1);
    }
  }
  bounded(decoded);
  const data = fields(decoded, ['v', 'fr', 'ip', 'op', 'w', 'h', 'nm', 'ddd', 'assets', 'layers'], 'document');
  if (typeof data.v !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(data.v)) fail('a Lottie export version is required.');
  const metadata = { width: data.w, height: data.h, frameRate: data.fr, inPoint: data.ip, outPoint: data.op } as LottieMetadata;
  validateLottieMetadata(metadata);
  if (own(data, 'ddd') && data.ddd !== 0) fail('3D content is unsupported.');
  if (own(data, 'assets') && (!Array.isArray(data.assets) || data.assets.length !== 0)) fail('assets/precompositions/images are unsupported; export self-contained vector shapes.');
  if (!Array.isArray(data.layers) || data.layers.length < 1 || data.layers.length > LOTTIE_LIMITS.layers) fail('provide between 1 and 32 shape layers.');
  let shapeCount = 0, keyframeCount = 0, vertexCount = 0;
  function path(value: unknown): void {
    const p = fields(value, ['i', 'o', 'v', 'c'], 'path');
    if (typeof p.c !== 'boolean' || !Array.isArray(p.v) || !Array.isArray(p.i) || !Array.isArray(p.o) || p.v.length < 1 || p.i.length !== p.v.length || p.o.length !== p.v.length) fail('paths require matching vertices/tangents and a closed flag.');
    vertexCount += (p.v as unknown[]).length;
    if (vertexCount > LOTTIE_LIMITS.vertices || ![p.v, p.i, p.o].every(points => (points as unknown[]).every(point => vector(point, 2)))) fail('path vertices exceed the bound or are invalid.');
  }
  function property(value: unknown, kind: 'scalar' | 'vector' | 'vector2' | 'color' | 'path' = 'scalar'): void {
    const p = fields(value, ['a', 'k', 'ix'], 'property');
    optionalNumber(p, 'ix');
    const staticValue = (item: unknown, animated = false) => {
      if (kind === 'path') { path(item); return; }
      const valid = kind === 'scalar' ? animated ? vector(item, 1) : number(item)
        : kind === 'color' ? vector(item, 3) || vector(item, 4)
        : kind === 'vector2' ? vector(item, 2) : vector(item, 2) || vector(item, 3);
      if (!valid) fail(`${kind} properties must contain correctly sized finite values; animated scalar values need a one-element array.`);
    };
    if (p.a === 0) { staticValue(p.k); return; }
    if (p.a !== 1 || !Array.isArray(p.k) || p.k.length < 2) fail('animated properties need at least two keyframes; use a:0 for a constant value.');
    const frames = p.k.map(frame => fields(frame, ['t', 's', 'e', 'i', 'o', 'h', 'to', 'ti'], 'keyframe'));
    let lastTime = -Infinity, valueShape: string | undefined, dimensions = 1;
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index];
      if (++keyframeCount > LOTTIE_LIMITS.keyframes || !number(frame.t) || frame.t < 0 || frame.t <= lastTime || frame.t > metadata.outPoint) fail('keyframes must have strictly increasing times within the bounded timeline.');
      lastTime = frame.t;
      if (!own(frame, 's') && index !== frames.length - 1) fail('nonterminal keyframes need a start value.');
      for (const name of ['s', 'e']) if (own(frame, name)) {
        let shape: string;
        if (kind === 'path') {
          if (!Array.isArray(frame[name]) || frame[name].length !== 1) fail('path keyframes require one path.');
          const item = frame[name][0]; path(item);
          shape = `${item.v.length}:${item.c}`;
        } else {
          staticValue(frame[name], true);
          dimensions = (frame[name] as number[]).length;
          shape = String(dimensions);
        }
        if (valueShape !== undefined && valueShape !== shape) fail('keyframe values must retain the same vector dimensions or path vertex count/closed flag.');
        valueShape = shape;
      }
      if (own(frame, 'h') && frame.h !== 0 && frame.h !== 1) fail('hold flags must be 0 or 1.');
    }
    // The player reads both the current and next keyframe. A final time-only
    // marker is safe only when the preceding interpolated segment supplies e.
    const terminal = frames[frames.length - 1], previous = frames[frames.length - 2];
    if (!own(terminal, 's') && (!own(previous, 'e') || previous.h === 1)) fail('a terminal keyframe needs a start value or a preceding non-hold end value.');
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index], segment = index < frames.length - 1;
      const spatial = own(frame, 'to') || own(frame, 'ti');
      if (spatial && (!['vector', 'vector2'].includes(kind) || frame.h === 1 || !vector(frame.to, dimensions) || !vector(frame.ti, dimensions))) fail('spatial tangents require a matching vector pair on a non-hold vector keyframe.');
      if (segment && frame.h !== 1 && !own(frames[index + 1], 's') && !own(frame, 'e')) fail('interpolated keyframes need an end value or the next start value.');
      const needsEasing = segment && frame.h !== 1;
      if (needsEasing || own(frame, 'i') || own(frame, 'o')) {
        const incoming = fields(frame.i, ['x', 'y'], 'incoming easing');
        const outgoing = fields(frame.o, ['x', 'y'], 'outgoing easing');
        const values = [outgoing.x, outgoing.y, incoming.x, incoming.y];
        const arrays = Array.isArray(outgoing.x);
        if (arrays ? !values.every(value => vector(value) && (value.length === 1 || value.length === dimensions)) : !values.every(number)) fail('easing coordinates must all be scalars or matching one/per-dimension arrays.');
        if (arrays && (spatial || kind === 'path') && !values.every(value => vector(value, 1))) fail('path/spatial easing requires scalar or one-element coordinates.');
        for (const value of [outgoing.x, incoming.x]) if (!(Array.isArray(value) ? value : [value]).every(x => number(x) && x >= 0 && x <= 1)) fail('easing x coordinates must be between 0 and 1.');
      }
    }
  }
  function transform(value: unknown, shape = false): void {
    const t = fields(value, ['o', 'r', 'p', 'a', 's', 'sk', 'sa', ...(shape ? ['ty', 'nm', 'mn', 'hd', 'ix'] : [])], 'transform');
    for (const name of ['o', 'r', 'p', 'a', 's']) {
      if (!own(t, name)) fail(`transforms require the "${name}" property.`);
      property(t[name], ['p', 'a', 's'].includes(name) ? 'vector' : 'scalar');
    }
    for (const name of ['sk', 'sa']) if (own(t, name)) property(t[name]);
  }
  function shapes(value: unknown): void {
    if (!Array.isArray(value) || value.length < 1) fail('shape collections must not be empty.');
    for (const item of value as unknown[]) {
      if (++shapeCount > LOTTIE_LIMITS.shapes || !object(item)) fail('shape count exceeds the bound or a shape is invalid.');
      const common = ['ty', 'nm', 'mn', 'hd', 'ix', 'bm'];
      const allowed: Record<string, string[]> = { gr: ['it', 'np', 'cix'], rc: ['d', 'p', 's', 'r'], el: ['d', 'p', 's'], sh: ['d', 'ks'], fl: ['c', 'o', 'r'], st: ['c', 'o', 'w', 'lc', 'lj', 'ml'], tr: ['o', 'r', 'p', 'a', 's', 'sk', 'sa'], tm: ['s', 'e', 'o', 'm'] };
      if (typeof item.ty !== 'string' || !own(allowed, item.ty)) fail(`unsupported shape "${String(item.ty)}"; use groups, paths, rectangles, ellipses, fills, strokes, transforms or trim paths.`);
      fields(item, [...common, ...allowed[item.ty]], 'shape');
      if (own(item, 'bm') && item.bm !== 0) fail('blend modes are unsupported.');
      if (own(item, 'hd') && typeof item.hd !== 'boolean') fail('hidden flags must be boolean.');
      if (item.ty === 'gr') shapes(item.it);
      else if (item.ty === 'tr') { const { bm: _bm, ...t } = item; transform(t, true); }
      else if (item.ty === 'sh') property(item.ks, 'path');
      else {
        const names: Record<string, string[]> = { rc: ['p', 's', 'r'], el: ['p', 's'], fl: ['c', 'o'], st: ['c', 'o', 'w'], tm: ['s', 'e', 'o'] };
        for (const name of names[item.ty]) property(item[name], name === 'c' ? 'color' : name === 'p' || name === 's' && item.ty !== 'tm' ? 'vector2' : 'scalar');
      }
      for (const name of ['d', 'ix', 'np', 'cix', 'lc', 'lj', 'ml', 'm']) optionalNumber(item, name);
      if (item.ty === 'fl') optionalNumber(item, 'r');
      for (const [name, max] of [['d', 3], ['lc', 3], ['lj', 3], ['m', 2]] as const) if (own(item, name) && !integer(item[name], 1, max)) fail(`invalid shape "${name}" mode.`);
      if (item.ty === 'fl' && own(item, 'r') && !integer(item.r, 1, 2)) fail('invalid fill rule.');
    }
  }
  const indexes = new Set<number>();
  for (const value of data.layers as unknown[]) {
    const layer = fields(value, ['ddd', 'ind', 'ty', 'nm', 'sr', 'ks', 'ao', 'shapes', 'ip', 'op', 'st', 'bm', 'hd'], 'layer');
    if (layer.ty !== 4) fail('only shape layers (ty:4) are supported; remove text, images, audio and precompositions.');
    if (own(layer, 'ddd') && layer.ddd !== 0 || own(layer, 'ao') && layer.ao !== 0 || own(layer, 'bm') && layer.bm !== 0 || own(layer, 'sr') && layer.sr !== 1 || own(layer, 'st') && layer.st !== 0) fail('use 2D layers with normal blending, start time 0 and time stretch 1.');
    if (own(layer, 'ind')) { if (!integer(layer.ind, 0, 100000) || indexes.has(layer.ind)) fail('layer indices must be unique bounded integers.'); indexes.add(layer.ind); }
    if (!number(layer.ip) || !number(layer.op) || layer.ip < 0 || layer.op <= layer.ip || layer.ip < metadata.inPoint || layer.op > metadata.outPoint) fail('layer timing must fit the document timeline.');
    if (own(layer, 'hd') && typeof layer.hd !== 'boolean') fail('hidden flags must be boolean.');
    transform(layer.ks); shapes(layer.shapes);
  }
  return { data, ...metadata };
}
