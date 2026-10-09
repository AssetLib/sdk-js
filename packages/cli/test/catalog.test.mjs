import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, catalogHash, readCatalog } from '../src/catalog.mjs';
import { generateCatalog } from '../src/codegen.mjs';

const input = { schemaVersion: 1, placements: [
  { width: 1200, key: 'travel.coast', symbol: ['Travel', 'coast'], height: 900 },
  { key: 'tasks.garden', symbol: ['Tasks', 'garden'], width: 600, height: 400, states: ['empty', 'growing', 'complete'], defaultState: 'empty' },
] };
const canonical = '{"placements":[{"height":900,"key":"travel.coast","symbol":["Travel","coast"],"width":1200},{"defaultState":"empty","height":400,"key":"tasks.garden","states":["empty","growing","complete"],"symbol":["Tasks","garden"],"width":600}],"schemaVersion":1}';

test('shared canonical catalog hash test vector', () => {
  assert.equal(canonicalize(input), canonical);
  assert.equal(catalogHash(input), 'e764f96b7bee781e687d7c52c4578ef3fda3b760e8e4ed88e3f29d64fe3a8fc6');
  assert.equal(catalogHash(JSON.parse(canonical)), catalogHash(input));
});

test('canonicalization sorts numeric and Unicode keys by code point and preserves JSON values/array order', () => {
  const value = { '\u{10000}': 'astral', '\uE000': 'bmp', '2': null, '10': [true, false, -0, '"\\\n'] };
  assert.equal(canonicalize(value), '{"10":[true,false,0,"\\\"\\\\\\n"],"2":null,"\uE000":"bmp","\u{10000}":"astral"}');
  assert.notEqual(catalogHash([1, 2]), catalogHash([2, 1]));
});

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'assetlib-catalog-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'catalog.json');
}

test('standalone generation is byte-identical to the existing core codegen', async t => {
  const file = await fixture(t);
  const catalog = structuredClone(input);
  catalog.placements[0].bundledAccessibility = { defaultLocale: 'en', descriptions: { en: 'Coast', th: 'ชายฝั่ง' } };
  catalog.placements[1].bundledStateAccessibility = { empty: { defaultLocale: 'en', descriptions: { en: 'Empty garden' } } };
  catalog.placements[0].variants = { appearance: ['dark'] };
  catalog.placements[1].variants = { appearance: ['light', 'dark'] };
  await writeFile(file, JSON.stringify(catalog));
  const existing = fileURLToPath(new URL('../../sdk-core/bin/codegen.mjs', import.meta.url));
  assert.equal(generateCatalog(await readCatalog(file)), execFileSync(process.execPath, [existing, file], { encoding: 'utf8' }));
  const generated = JSON.parse(generateCatalog(catalog).split('export const AppAssets = ')[1].split(' as const;')[0]);
  assert.deepEqual(generated.Travel.coast.variants, { appearance: ['dark'] });
  assert.deepEqual(generated.Tasks.garden.variants, { appearance: ['light', 'dark'] });
});

test('both codegens reject unknown axes, values and malformed appearance declarations', async t => {
  const file = await fixture(t);
  const existing = fileURLToPath(new URL('../../sdk-core/bin/codegen.mjs', import.meta.url));
  for (const variants of [null, [], {}, 'dark', { appearance: [] }, { appearance: 'dark' }, { appearance: ['dark', 'dark'] }, { appearance: ['any'] }, { appearance: [1] }, { platform: ['ios'] }, { appearance: ['dark'], locale: ['th'] }]) {
    const catalog = structuredClone(input);
    catalog.placements[0].variants = variants;
    await writeFile(file, JSON.stringify(catalog));
    assert.throws(() => generateCatalog(catalog), /Variants/);
    await assert.rejects(readCatalog(file), /Variants/);
    const result = spawnSync(process.execPath, [existing, file], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Variants/);
  }
});

test('catalog validation rejects malformed catalogs, placements, states, symbols and descriptions', async t => {
  const file = await fixture(t);
  const cases = [null, [], {}, { ...input, schemaVersion: 2 }, { ...input, placements: [] }, { ...input, placements: Array(101).fill(input.placements[0]) }];
  for (const mutate of [
    p => { p.key = 'invalid key'; }, p => { p.width = 0; }, p => { p.height = 8193; },
    p => { p.symbol = ['constructor']; }, p => { p.symbol = []; }, p => { p.symbol = Array(6).fill('x'); },
    p => { p.states = ['one']; }, p => { p.states = ['one', 'one']; }, p => { p.states = ['one', 'prototype']; },
    p => { p.states = ['one', 'two']; p.defaultState = 'three'; }, p => { p.defaultState = 'one'; },
    p => { p.bundledAccessibility = { defaultLocale: 'en', descriptions: { en: '' } }; },
    p => { p.bundledStateAccessibility = { wrong: { defaultLocale: 'en', descriptions: { en: 'x' } } }; },
  ]) {
    const catalog = structuredClone(input); mutate(catalog.placements[0]); cases.push(catalog);
  }
  cases.push({ ...input, placements: [null] });
  cases.push({ ...input, placements: [input.placements[0], input.placements[0]] });
  cases.push({ ...input, placements: [input.placements[0], { ...input.placements[1], symbol: ['Travel'] }] });
  cases.push({ ...input, placements: [{ ...input.placements[0], symbol: ['Travel'] }, { ...input.placements[1], symbol: ['Travel', 'garden'] }] });
  for (const catalog of cases) {
    await writeFile(file, JSON.stringify(catalog));
    await assert.rejects(readCatalog(file));
  }
  await writeFile(file, '{oops');
  await assert.rejects(readCatalog(file), /valid JSON/);
  await writeFile(file, ' '.repeat(128 * 1024 + 1));
  await assert.rejects(readCatalog(file), /128 KiB/);
  await assert.rejects(readCatalog(path.dirname(file)), /regular file/);
});
