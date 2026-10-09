import type { AssetRef } from './types.js';

/** Match backend assignments against app-owned, checked-in references. This
 * performs no requests and does not establish customer authorization. */
export function selectCatalogReferences(catalog: readonly AssetRef[], keys: readonly string[]): { references: AssetRef[]; unknownKeys: string[] } {
  if (!Array.isArray(catalog) || catalog.length > 100 || !Array.isArray(keys) || keys.length > 100) throw new Error('Catalog selections must be arrays of at most 100 items.');
  const byKey = new Map<string, AssetRef>();
  const validKey = (key: unknown): key is string => typeof key === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$/.test(key);
  for (const ref of catalog) {
    if (!ref || !validKey(ref.key) || !Number.isSafeInteger(ref.width) || ref.width < 1 || ref.width > 8192 || !Number.isSafeInteger(ref.height) || ref.height < 1 || ref.height > 8192 || byKey.has(ref.key)) throw new Error('The trusted catalog has an invalid or duplicate reference.');
    byKey.set(ref.key, ref);
  }
  const references: AssetRef[] = [], unknownKeys: string[] = [], seen = new Set<string>();
  for (const key of keys) {
    if (typeof key !== 'string' || key.length > 120) throw new Error('Assignment keys must be strings no longer than 120 characters.');
    if (seen.has(key)) continue;
    seen.add(key);
    const ref = validKey(key) ? byKey.get(key) : undefined;
    if (ref) references.push(ref); else unknownKeys.push(key);
  }
  return { references, unknownKeys };
}
