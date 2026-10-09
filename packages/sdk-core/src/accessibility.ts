import type { AssetAccessibility } from './types.js';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validLocale = (value: unknown): value is string => typeof value === 'string' && value.length <= 63 && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*(?![\s\S])/.test(value);

/** Validate metadata before accepting it as part of a signed image descriptor. */
export function validateAccessibility(value: unknown): asserts value is AssetAccessibility {
  if (!record(value) || !validLocale(value.defaultLocale) || !record(value.descriptions)) throw new Error('Invalid image accessibility metadata.');
  const entries = Object.entries(value.descriptions), locales = new Set<string>();
  if (!entries.length || entries.length > 32) throw new Error('Image accessibility requires 1–32 descriptions.');
  for (const [locale, description] of entries) {
    if (!validLocale(locale) || locales.has(locale.toLowerCase()) || typeof description !== 'string' || !description.trim() || description.length > 1000) throw new Error('Invalid image accessibility description.');
    locales.add(locale.toLowerCase());
  }
  if (!locales.has(value.defaultLocale.toLowerCase())) throw new Error('The default image accessibility locale must have a description.');
}

/** Exact locale, then progressively less specific subtags, then the explicit default. */
export function resolveAccessibilityDescription(metadata: AssetAccessibility | undefined, locale?: string): string | undefined {
  if (!metadata) return undefined;
  const descriptions = new Map(Object.entries(metadata.descriptions).map(([key, value]) => [key.toLowerCase(), value]));
  let candidate = locale?.toLowerCase();
  while (candidate) {
    const description = descriptions.get(candidate);
    if (description !== undefined) return description;
    const separator = candidate.lastIndexOf('-');
    candidate = separator < 0 ? undefined : candidate.slice(0, separator);
  }
  return descriptions.get(metadata.defaultLocale.toLowerCase());
}
