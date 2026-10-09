// Copied from sdk-core/bin/codegen.mjs to keep CLI codegen independent of sdk-core.
// Parity with the existing core generator is checked in test/catalog.test.mjs.
import { validateAccessibility } from './accessibility.mjs';

export function generateCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog) || catalog.schemaVersion !== 1 || !Array.isArray(catalog.placements) || !catalog.placements.length || catalog.placements.length > 100) throw new Error('Expected catalog schemaVersion 1 with 1–100 placements.');
  const tree = Object.create(null);
  const keys = new Set();
  for (const placement of catalog.placements) {
    if (!placement || typeof placement !== 'object' || Array.isArray(placement) || typeof placement.key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$/.test(placement.key) || keys.has(placement.key) || ![placement.width, placement.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 8192) || !Array.isArray(placement.symbol) || placement.symbol.length < 1 || placement.symbol.length > 5 || placement.symbol.some(value => typeof value !== 'string' || !/^[A-Za-z_$][\w$]{0,63}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value))) throw new Error('Invalid or duplicate catalog placement.');
    keys.add(placement.key);
    if ('variants' in placement) {
      const variants = placement.variants;
      if (!variants || typeof variants !== 'object' || Array.isArray(variants) || !Object.keys(variants).length || Object.keys(variants).some(axis => axis !== 'appearance' && axis !== 'arm')) throw new Error('Variants support only appearance and arm axes.');
      if ('appearance' in variants && (!Array.isArray(variants.appearance) || !variants.appearance.length || new Set(variants.appearance).size !== variants.appearance.length || variants.appearance.some(value => value !== 'light' && value !== 'dark'))) throw new Error('Variants appearance requires unique light or dark values.');
      if ('arm' in variants && (!Array.isArray(variants.arm) || variants.arm.length < 1 || variants.arm.length > 4 || new Set(variants.arm).size !== variants.arm.length || variants.arm.some(value => typeof value !== 'string' || value !== value.trim() || !/^[a-z][a-z0-9_-]{0,19}$/.test(value) || ['control', 'any', 'constructor', 'prototype', '__proto__'].includes(value)))) throw new Error('Variants arm requires 1–4 unique valid arm names.');
    }
    if (placement.states !== undefined && (!Array.isArray(placement.states) || placement.states.length < 2 || placement.states.length > 16 || new Set(placement.states).size !== placement.states.length || placement.states.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(value) || ['constructor', 'prototype', '__proto__'].includes(value)))) throw new Error('State sets require 2–16 unique named states.');
    if ('bundledAccessibility' in placement) validateAccessibility(placement.bundledAccessibility);
    if ('bundledStateAccessibility' in placement) {
      if (!placement.states || !placement.bundledStateAccessibility || typeof placement.bundledStateAccessibility !== 'object' || Array.isArray(placement.bundledStateAccessibility)) throw new Error('Bundled state descriptions require a state set.');
      for (const [state, metadata] of Object.entries(placement.bundledStateAccessibility)) {
        if (!placement.states.includes(state)) throw new Error('Bundled description has an unknown state.');
        validateAccessibility(metadata);
      }
    }
    let node = tree;
    for (const name of placement.symbol.slice(0, -1)) {
      if (node[name]?.key) throw new Error('Catalog symbols overlap.');
      node = node[name] ??= Object.create(null);
    }
    const leaf = placement.symbol.at(-1);
    if (Object.hasOwn(node, leaf)) throw new Error('Catalog symbols overlap.');
    node[leaf] = { key: placement.key, width: placement.width, height: placement.height, ...(placement.states ? { states: placement.states } : {}), ...(placement.variants ? { variants: placement.variants } : {}), ...(placement.bundledAccessibility ? { bundledAccessibility: placement.bundledAccessibility } : {}), ...(placement.bundledStateAccessibility ? { bundledStateAccessibility: placement.bundledStateAccessibility } : {}) };
  }
  return '// Generated from the checked-in Assetlib catalog. Regenerate instead of editing.\n// No network dependency during compilation.\nexport const AppAssets = ' + JSON.stringify(tree, null, 2) + ' as const;\n\n';
}
