#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

try {
  if (process.argv.includes('--help')) {
    console.log('Usage: node codegen.mjs <checked-in-catalog.json>\nPrints typed AppAssets to stdout. No network calls or automatic file writes.');
  } else {
    if (process.argv.length !== 3) throw new Error('Provide one checked-in catalog JSON path. Use --help.');
    const text = await readFile(process.argv[2], 'utf8');
    if (Buffer.byteLength(text) > 128 * 1024) throw new Error('Catalog exceeds 128 KiB.');
    const catalog = JSON.parse(text);
    if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.placements) || !catalog.placements.length || catalog.placements.length > 100) throw new Error('Expected catalog schemaVersion 1 with 1–100 placements.');
    const tree = Object.create(null);
    const keys = new Set();
    for (const placement of catalog.placements) {
      if (typeof placement.key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$/.test(placement.key) || keys.has(placement.key) || ![placement.width, placement.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 8192) || !Array.isArray(placement.symbol) || placement.symbol.length < 1 || placement.symbol.length > 5 || placement.symbol.some(value => typeof value !== 'string' || !/^[A-Za-z_$][\w$]{0,63}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value))) throw new Error('Invalid or duplicate catalog placement.');
      keys.add(placement.key);
      let node = tree;
      for (const name of placement.symbol.slice(0, -1)) {
        if (node[name]?.key) throw new Error('Catalog symbols overlap.');
        node = node[name] ??= Object.create(null);
      }
      const leaf = placement.symbol.at(-1);
      if (Object.hasOwn(node, leaf)) throw new Error('Catalog symbols overlap.');
      node[leaf] = { key: placement.key, width: placement.width, height: placement.height };
    }
    console.log('// Generated from the checked-in Assetlib catalog. Regenerate instead of editing.\n// No network dependency during compilation.\nexport const AppAssets = ' + JSON.stringify(tree, null, 2) + ' as const;\n');
  }
} catch (error) { console.error(`Assetlib codegen: ${error.message}`); process.exitCode = 1; }
