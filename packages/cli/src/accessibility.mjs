// Copied from sdk-core/src/accessibility.ts for standalone catalog validation.
const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const validLocale = (value) => typeof value === 'string' && value.length <= 63 && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*(?![\s\S])/.test(value);

/** Validate metadata before accepting it as part of a signed image descriptor. */
export function validateAccessibility(value) {
  if (!record(value) || !validLocale(value.defaultLocale) || !record(value.descriptions)) throw new Error('Invalid image accessibility metadata.');
  const entries = Object.entries(value.descriptions), locales = new Set();
  if (!entries.length || entries.length > 32) throw new Error('Image accessibility requires 1–32 descriptions.');
  for (const [locale, description] of entries) {
    if (!validLocale(locale) || locales.has(locale.toLowerCase()) || typeof description !== 'string' || !description.trim() || description.length > 1000) throw new Error('Invalid image accessibility description.');
    locales.add(locale.toLowerCase());
  }
  if (!locales.has(value.defaultLocale.toLowerCase())) throw new Error('The default image accessibility locale must have a description.');
}

