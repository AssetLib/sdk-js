import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parsePublicConfig, verifySignedManifest } from '../dist/index.js';

const fixture = name => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = async name => JSON.parse(await fixture(name));
const config = parsePublicConfig(await json('config.json'));
const seed = (await fixture('keys/TEST_ONLY_seed.hex')).trim();
const privateKey = createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${seed}`, 'hex'), format: 'der', type: 'pkcs8' });
const armTemplate = JSON.parse((await json('manifests/valid-arm-seq9.json')).payload);
const bothTemplate = JSON.parse((await json('manifests/valid-arm-appearance-seq10.json')).payload);
const stateTemplate = JSON.parse((await json('manifests/valid-arm-stateful-seq11.json')).payload);

function signed(value) {
  const payload = JSON.stringify(value);
  return { algorithm: 'Ed25519', keyId: config.keyId, publicKey: config.pinnedPublicKey, payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') };
}
const verify = value => verifySignedManifest(signed(value), config);

test('signed arm fixtures accept valid axes and reject invalid coordinates after signature verification', async () => {
  for (const name of ['valid-arm-seq9', 'valid-arm-appearance-seq10', 'valid-arm-stateful-seq11']) {
    const envelope = await json(`manifests/${name}.json`);
    assert.doesNotThrow(() => verifySignedManifest(envelope, config), name);
  }
  for (const [name, reason] of [['arm-undeclared-cell', /arm is not declared/], ['arm-duplicate-coordinates', /Duplicate.*coordinates/], ['arm-missing-coordinates', /at least one/]]) {
    const envelope = await json(`manifests/invalid/${name}.json`);
    assert.throws(() => verifySignedManifest(envelope, config), reason, name);
  }
});

test('arm declarations accept one to four exact names and reject malformed or reserved values', () => {
  for (const names of [['b'], ['b', 'c', 'treatment_2', 'a'.repeat(20)]]) {
    const payload = structuredClone(armTemplate);
    payload.slots[0].variants.arm = names;
    assert.doesNotThrow(() => verify(payload));
  }
  for (const names of [null, {}, 'b', [], ['b', 'b'], ['a', 'b', 'c', 'd', 'e'], [0], [true], [''], ['B'], ['1b'], ['a.b'], ['b\n'], ['b\r'], [' b'], ['b '], ['a'.repeat(21)], ...['control', 'any', 'constructor', 'prototype', '__proto__'].map(name => [name])]) {
    const payload = structuredClone(armTemplate);
    payload.slots[0].variants.arm = names;
    assert.throws(() => verify(payload), /arm variants/, JSON.stringify(names));
  }
  for (const variants of [{}, { locale: ['en'] }, { arm: ['b'], appearance: [] }, { arm: ['b'], appearance: ['any'] }, { arm: ['b'], appearance: ['dark', 'dark'] }, { arm: ['b'], locale: ['en'] }]) {
    const payload = structuredClone(armTemplate); payload.slots[0].variants = variants;
    assert.throws(() => verify(payload), /variant/);
  }
  const noVersion = structuredClone(armTemplate); delete noVersion.variantSchemaVersion;
  assert.throws(() => verify(noVersion), /variant/);
});

test('coordinate validation permits the full matrix, optional cells, and partial bound coordinates', () => {
  const payload = structuredClone(bothTemplate), slot = payload.slots[0];
  slot.variants.arm = ['b', 'c', 'd', 'e'];
  const image = { ...slot.cells[1] }; delete image.arm;
  slot.cells = [];
  for (const arm of [undefined, ...slot.variants.arm]) {
    for (const appearance of [undefined, ...slot.variants.appearance]) {
      if (arm === undefined && appearance === undefined) continue;
      slot.cells.push({ ...image, ...(arm ? { arm } : {}), ...(appearance ? { appearance } : {}) });
    }
  }
  assert.equal(slot.cells.length, 14);
  assert.doesNotThrow(() => verify(payload));
  slot.cells = [slot.cells[3]];
  assert.doesNotThrow(() => verify(payload));
  slot.cells = [];
  assert.doesNotThrow(() => verify(payload));
  delete slot.cells;
  assert.doesNotThrow(() => verify(payload));
});

test('cells require a declared coordinate and cannot duplicate either one-axis or two-axis coordinates', () => {
  const invalid = [
    slot => { slot.cells = null; },
    slot => { slot.cells = [null]; },
    slot => { delete slot.variants; },
    slot => { delete slot.variants.arm; },
    slot => { delete slot.variants.appearance; },
    slot => { slot.cells[1].arm = 'control'; },
    slot => { slot.cells[1].arm = null; },
    slot => { slot.cells[1].arm = ''; },
    slot => { slot.cells[1].arm = 'missing'; },
    slot => { slot.cells[1].appearance = 'any'; },
    slot => { slot.cells[1].appearance = null; },
    slot => { slot.cells[1].appearance = ''; },
    slot => { slot.cells[1].appearance = 'system'; },
    slot => { delete slot.cells[1].arm; },
    ...[0, 1, 2].map(index => slot => { slot.cells.push(structuredClone(slot.cells[index])); }),
  ];
  for (const mutate of invalid) {
    const payload = structuredClone(bothTemplate); mutate(payload.slots[0]);
    assert.throws(() => verify(payload), undefined, mutate.toString());
  }
});

test('each arm coordinate owns a complete state family and duplicates all default descriptor metadata', () => {
  for (const coordinate of [1, 2, 3]) {
    const invalid = [
      cell => { delete cell.states; },
      cell => { delete cell.states.growing; },
      cell => { cell.states.extra = structuredClone(cell.states.growing); },
      cell => { cell.states.empty = structuredClone(cell.states.growing); },
      cell => { cell.defaultState = 'growing'; },
      cell => { cell.states.growing.bytes = 0; },
      cell => { cell.states.growing.url = 'https://outside.example/image'; },
      cell => { cell.accessibility = { defaultLocale: 'en', descriptions: { en: 'Only the cell description' } }; },
      cell => { cell.states.empty.accessibility = { defaultLocale: 'en', descriptions: { en: 'Only the default state description' } }; },
    ];
    for (const mutate of invalid) {
      const payload = structuredClone(stateTemplate); mutate(payload.slots[0].cells[coordinate]);
      assert.throws(() => verify(payload), undefined, `${coordinate}: ${mutate}`);
    }
    const valid = structuredClone(stateTemplate), cell = valid.slots[0].cells[coordinate];
    cell.accessibility = { defaultLocale: 'en', descriptions: { en: 'Cell artwork', th: 'ภาพประกอบ' } };
    cell.states.empty.accessibility = { descriptions: { th: 'ภาพประกอบ', en: 'Cell artwork' }, defaultLocale: 'en' };
    assert.doesNotThrow(() => verify(valid), 'Object property order does not affect default metadata equivalence.');
    valid.slots[0].cells.splice(coordinate, 1);
    assert.doesNotThrow(() => verify(valid), 'An entirely absent coordinate family is permitted.');
  }
  const stateless = structuredClone(armTemplate); stateless.slots[0].cells[0].states = {};
  assert.throws(() => verify(stateless), /stateless/);
});

test('arm cells retain image descriptor, rendition, and complete-family byte bounds', () => {
  for (const mutate of [
    cell => { cell.assetId = 'invalid'; },
    cell => { cell.sha256 = 'invalid'; },
    cell => { cell.mime = 'image/png'; },
    cell => { cell.bytes = 0; },
    cell => { cell.bytes = 8 * 1024 * 1024 + 1; },
    cell => { cell.url += '?unexpected'; },
    cell => { cell.renditions = []; },
    cell => { cell.accessibility = null; },
  ]) {
    const payload = structuredClone(armTemplate); mutate(payload.slots[0].cells[0]);
    assert.throws(() => verify(payload));
  }
  const payload = structuredClone(stateTemplate), slot = payload.slots[0];
  for (let i = 0; i < 5; i++) slot.states[`extra${i}`] = structuredClone(slot.states.empty);
  for (const cell of slot.cells) {
    for (let i = 0; i < 5; i++) cell.states[`extra${i}`] = structuredClone(cell.states.empty);
  }
  for (const state of Object.values(slot.cells[1].states)) state.bytes = 8 * 1024 * 1024;
  slot.cells[1].bytes = 8 * 1024 * 1024;
  assert.throws(() => verify(payload), /complete-group byte budget/);
});
