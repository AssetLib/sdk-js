import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { generateCatalog } from './codegen.mjs';

const MAX_CATALOG_BYTES = 128 * 1024;

// Compare Unicode code points, including astral keys; Array.sort alone uses UTF-16.
function compareKeys(a, b) {
  const left = Array.from(a, char => char.codePointAt(0));
  const right = Array.from(b, char => char.codePointAt(0));
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

/** Canonicalize parsed JSON directly, avoiding JavaScript's integer-key reordering. */
export function canonicalize(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort(compareKeys).map(key => JSON.stringify(key) + ':' + canonicalize(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function catalogHash(catalog) {
  return createHash('sha256').update(canonicalize(catalog), 'utf8').digest('hex');
}

export async function readCatalog(file) {
  const handle = await open(file, 'r');
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Catalog must be a regular file.');
    if (stat.size > MAX_CATALOG_BYTES) throw new Error('Catalog exceeds 128 KiB.');
    // Also bound a file that grows after stat; never read the whole oversized file.
    const buffer = Buffer.alloc(MAX_CATALOG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_CATALOG_BYTES) throw new Error('Catalog exceeds 128 KiB.');
    bytes = buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
  let catalog;
  try { catalog = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('Catalog must be valid JSON.'); }
  generateCatalog(catalog); // The same validation used for offline generation.
  // Registration also carries the optional default state; codegen does not emit it.
  for (const placement of catalog.placements) {
    if ('defaultState' in placement && (!placement.states || !placement.states.includes(placement.defaultState))) {
      throw new Error('A default state must name a declared state.');
    }
  }
  return catalog;
}
