import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(path.join(root, 'test/.accessibility-'));
after(async () => { delete globalThis.__assetlibAdapter; await rm(temporary, { recursive: true, force: true }); });
await writeFile(path.join(temporary, 'core.mjs'), `
export const parsePublicConfig = value => value;
export const createAssetClient = (config, options) => ({ config, options });
export { resolveAccessibilityDescription } from '${pathToFileURL(path.join(root, '../sdk-core/dist/accessibility.js')).href}';
`);
await writeFile(path.join(temporary, 'platform.mjs'), `
export const vectorRenderingSupported = true;
export const platformFetch = globalThis.fetch;
export const createPlatformStorage = config => ({ persistentConfig: config });
export const imageUri = (...args) => globalThis.__assetlibAdapter.imageUri(...args);
`);
await writeFile(path.join(temporary, 'image.mjs'), 'export function Image() { return null; }');
let source = await readFile(path.join(root, 'src/index.tsx'), 'utf8');
for (const [from, to] of Object.entries({ '@assetlib/sdk-core': './core.mjs', './platform': './platform.mjs', 'expo-image': './image.mjs' })) source = source.replaceAll(`'${from}'`, `'${to}'`);
await writeFile(path.join(temporary, 'index.mjs'), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText);
const { AssetlibImage } = await import(pathToFileURL(path.join(temporary, 'index.mjs')));
const { Image } = await import(pathToFileURL(path.join(temporary, 'image.mjs')));
const description = text => ({ defaultLocale: 'en', descriptions: { en: text, th: `ไทย ${text}` } });
const resolved = (name = 'a', accessibility = description('Remote forest')) => ({ source: 'remote', sequence: 7, message: 'verified', sha256: name.repeat(64), assetId: name, mime: 'image/png', bytes: new Uint8Array([1, 2, 3]), accessibility });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const config = { appId: 'test' };
const asset = { key: 'travel.coast', width: 100, height: 100, bundledAccessibility: description('Bundled coast') };
function harness() {
  const released = [];
  globalThis.__assetlibAdapter = { imageUri: async (_config, result) => ({ uri: `verified:${result.assetId}`, release() { released.push(result.assetId); } }) };
  return { released };
}

test('descriptions follow selected artwork, locale changes, and decode fallback', async () => {
  harness(); const pending = deferred(); const client = { config, resolve: () => pending.promise };
  const props = { client, asset, fallback: 1, accessibilityMode: 'description', accessibilityLocale: 'TH-th' };
  let view;
  await act(async () => { view = create(React.createElement(AssetlibImage, props)); });
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'ไทย Bundled coast');
  assert.equal(view.root.findByType(Image).props.source, 1);
  await act(async () => { pending.resolve(resolved()); });
  assert.deepEqual(view.root.findByType(Image).props.source, { uri: 'verified:a' });
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'ไทย Remote forest');
  assert.equal(view.root.findByType(Image).props.accessible, true);
  await act(async () => { view.update(React.createElement(AssetlibImage, { ...props, accessibilityLocale: 'en-GB' })); });
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'Remote forest');
  await act(async () => { view.root.findByType(Image).props.onError({ error: 'decode' }); });
  assert.equal(view.root.findByType(Image).props.source, 1);
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'Bundled coast');
  await act(async () => { view.unmount(); });
});

test('legacy remote metadata is never borrowed from bundle and an explicit native label overrides descriptions', async () => {
  harness(); const client = { config, resolve: async () => ({ ...resolved(), accessibility: undefined }) };
  const props = { client, asset, fallback: 1, fallbackAccessibility: description('Placeholder'), accessibilityMode: 'description' };
  let view;
  await act(async () => { view = create(React.createElement(AssetlibImage, props)); });
  assert.equal(view.root.findByType(Image).props.source, 1);
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'Placeholder');
  await act(async () => { view.update(React.createElement(AssetlibImage, { ...props, accessibilityLabel: 'Explore trips' })); });
  assert.deepEqual(view.root.findByType(Image).props.source, { uri: 'verified:a' });
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'Explore trips');
  await act(async () => { view.unmount(); });
});

test('decorative mode hides artwork and default mode does not apply a universal label', async () => {
  harness(); const client = { config, resolve: async () => resolved() };
  const props = { client, asset, fallback: 1 };
  let view;
  await act(async () => { view = create(React.createElement(AssetlibImage, props)); });
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, undefined);
  assert.equal(view.root.findByType(Image).props.accessible, undefined);
  await act(async () => { view.update(React.createElement(AssetlibImage, { ...props, accessibilityMode: 'decorative', accessibilityLabel: 'App label', accessible: true })); });
  assert.equal(view.root.findByType(Image).props.accessible, false);
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, undefined);
  assert.equal(view.root.findByType(Image).props.accessibilityElementsHidden, true);
  assert.equal(view.root.findByType(Image).props.importantForAccessibility, 'no-hide-descendants');
  assert.equal(view.root.findByType(Image).props['aria-hidden'], true);
  await act(async () => { view.unmount(); });
});

test('a replaced request immediately pairs the new bundle and description and ignores stale events', async () => {
  harness(); const first = deferred(), second = deferred();
  const client = { config, resolve: ref => ref.key === asset.key ? first.promise : second.promise };
  const props = { client, asset, fallback: 1, accessibilityMode: 'description' };
  let view;
  await act(async () => { view = create(React.createElement(AssetlibImage, props)); });
  await act(async () => { first.resolve(resolved('a', description('First remote'))); });
  const staleError = view.root.findByType(Image).props.onError;
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'First remote');
  await act(async () => { view.update(React.createElement(AssetlibImage, { ...props, asset: { ...asset, key: 'travel.forest', bundledAccessibility: description('Second placeholder') }, fallback: 2 })); });
  assert.equal(view.root.findByType(Image).props.source, 2);
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'Second placeholder');
  await act(async () => { second.resolve(resolved('b', description('Second remote'))); });
  await act(async () => { staleError({ error: 'old decode' }); });
  assert.deepEqual(view.root.findByType(Image).props.source, { uri: 'verified:b' });
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'Second remote');
  await act(async () => { view.unmount(); });
});

test('a late response after request replacement never publishes the previous description', async () => {
  harness(); const first = deferred(), second = deferred();
  const client = { config, resolve: ref => ref.key === asset.key ? first.promise : second.promise };
  const props = { client, asset, fallback: 1, accessibilityMode: 'description' };
  let view;
  await act(async () => { view = create(React.createElement(AssetlibImage, props)); });
  await act(async () => { view.update(React.createElement(AssetlibImage, { ...props, asset: { ...asset, key: 'other' }, fallback: 2, fallbackAccessibility: description('New placeholder') })); });
  await act(async () => { first.resolve(resolved('a', description('Stale remote'))); });
  assert.equal(view.root.findByType(Image).props.source, 2);
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'New placeholder');
  await act(async () => { second.resolve(resolved('b', description('Current remote'))); });
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'Current remote');
  await act(async () => { view.unmount(); });
});

test('URI preparation failure preserves the bundle description and unmounted preparation is released', async () => {
  const { released } = harness(); const pending = deferred(); const statuses = [];
  globalThis.__assetlibAdapter.imageUri = () => pending.promise;
  const client = { config, resolve: async () => resolved() };
  let view;
  await act(async () => { view = create(React.createElement(AssetlibImage, { client, asset, fallback: 1, accessibilityMode: 'description', onStatus: status => statuses.push(status.source) })); });
  await act(async () => { pending.reject(new Error('invalid dimensions')); });
  assert.equal(view.root.findByType(Image).props.source, 1);
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'Bundled coast');
  const late = deferred(); globalThis.__assetlibAdapter.imageUri = () => late.promise;
  await act(async () => { view.update(React.createElement(AssetlibImage, { client, asset, fallback: 1, accessibilityMode: 'description', revision: 1, onStatus: status => statuses.push(status.source) })); });
  await act(async () => { view.unmount(); });
  await act(async () => { late.resolve({ uri: 'verified:a', release() { released.push('a'); } }); });
  assert.deepEqual(released, ['a']);
  assert.ok(statuses.every(value => value === 'bundle'));
});
