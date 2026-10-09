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
const temporary = await mkdtemp(path.join(root, 'test/.adapter-'));
after(async () => { delete globalThis.__assetlibAdapter; await rm(temporary, { recursive: true, force: true }); });
const transpile = async (name, replacements) => {
  let source = await readFile(path.join(root, 'src', name), 'utf8');
  for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(`'${from}'`, `'${to}'`);
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  await writeFile(path.join(temporary, name.replace(/\.tsx?$/, '.mjs')), compiled);
};
await writeFile(path.join(temporary, 'core.mjs'), `
export const SDK_LIMITS = { assetBytes: 8 * 1024 * 1024 };
export const hashBytes = () => 'a'.repeat(64);
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
await writeFile(path.join(temporary, 'image.mjs'), `export function Image() { return null; }`);
await writeFile(path.join(temporary, 'filesystem.mjs'), `
export class File { constructor() { globalThis.__assetlibAdapter.fileCalls++; throw new Error('Unexpected file access'); } }
export class Directory { constructor() { globalThis.__assetlibAdapter.fileCalls++; throw new Error('Unexpected directory access'); } }
export const Paths = { document: '/documents' };
`);
await writeFile(path.join(temporary, 'fetch.mjs'), `export const fetch = globalThis.fetch;`);
await transpile('index.tsx', { '@assetlib/sdk-core': './core.mjs', './platform': './platform.mjs', './shared': './shared.mjs', 'expo-image': './image.mjs' });
await transpile('shared.ts', { '@assetlib/sdk-core': './core.mjs' });
await transpile('platform.native.ts', { '@assetlib/sdk-core': './core.mjs', './shared': './shared.mjs', 'expo-file-system': './filesystem.mjs', 'expo/fetch': './fetch.mjs' });
const adapter = await import(pathToFileURL(path.join(temporary, 'index.mjs')));
const native = await import(pathToFileURL(path.join(temporary, 'platform.native.mjs')));
const { Image } = await import(pathToFileURL(path.join(temporary, 'image.mjs')));
const { rasterDataUri } = await import(pathToFileURL(path.join(temporary, 'shared.mjs')));
const resolved = (name = 'a', cachePolicy = 'none') => ({ source: 'remote', sequence: 7, message: 'verified', sha256: name.repeat(64), assetId: name, mime: 'image/png', bytes: new Uint8Array([1, 2, 3]), cachePolicy });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function harness() {
  const released = [];
  globalThis.__assetlibAdapter = { fileCalls: 0, imageUri: async (_config, result) => ({ uri: `verified:${result.assetId}`, release() { released.push(result.assetId); } }) };
  return { released };
}
const config = { appId: 'test' };
const group = { key: 'tasks.garden', width: 120, height: 120, states: ['sprout', 'grown'] };
const fallbacks = { sprout: 1, grown: 2 };
const description = text => ({ defaultLocale: 'en', descriptions: { en: text, th: `ไทย ${text}` } });

test('native memory and none policies render exact bytes without filesystem access', async () => {
  harness();
  for (const policy of ['memory', 'none']) {
    const image = await native.imageUri(config, resolved('a', policy));
    assert.equal(image.uri, 'data:image/png;base64,AQID');
    image.release();
  }
  assert.equal(globalThis.__assetlibAdapter.fileCalls, 0);
});

test('data URI encoding handles padding and chunk boundaries and rejects unsupported payloads', () => {
  for (const size of [1, 2, 3, 4, 12287, 12288, 12289, 65537]) {
    const bytes = Uint8Array.from({ length: size }, (_, index) => index % 256);
    assert.equal(rasterDataUri({ ...resolved(), bytes }).uri, `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
  }
  assert.throws(() => rasterDataUri({ ...resolved(), mime: 'image/svg+xml' }), /unsupported/);
  assert.throws(() => rasterDataUri({ ...resolved(), bytes: new Uint8Array() }), /Missing/);
});

test('factory preserves durable storage while forwarding image retention policy', () => {
  const client = adapter.createExpoAssetClient(config, { cachePolicy: 'none' });
  assert.equal(client.options.cachePolicy, 'none');
  assert.equal(client.options.storage.persistentConfig, config);
});

test('state changes select a pinned complete family without refetching or mixing fallbacks', async () => {
  harness();
  const lastDecode = deferred();
  globalThis.__assetlibAdapter.imageUri = async (_config, result) => result.assetId === 'b' ? lastDecode.promise : { uri: 'verified:a', release() {} };
  const calls = [];
  const client = { config, resolveStateSet: async (asset, options) => { calls.push({ asset, options }); return { source: 'remote', sequence: 7, message: 'complete', states: { sprout: resolved('a'), grown: resolved('b') } }; } };
  let view;
  await act(async () => { view = create(React.createElement(adapter.AssetlibStateImage, { client, asset: group, state: 'sprout', fallbacks, cachePolicy: 'none' })); });
  assert.equal(view.root.findByType(Image).props.source, 1);
  await act(async () => { view.update(React.createElement(adapter.AssetlibStateImage, { client, asset: { ...group, states: [...group.states] }, state: 'grown', fallbacks: { ...fallbacks }, cachePolicy: 'none' })); });
  assert.equal(view.root.findByType(Image).props.source, 2);
  assert.equal(calls.length, 1);
  await act(async () => { lastDecode.resolve({ uri: 'verified:b', release() {} }); });
  assert.deepEqual(view.root.findByType(Image).props.source, { uri: 'verified:b' });
  await act(async () => { view.update(React.createElement(adapter.AssetlibStateImage, { client, asset: group, state: 'sprout', fallbacks, cachePolicy: 'none' })); });
  assert.deepEqual(view.root.findByType(Image).props.source, { uri: 'verified:a' });
  assert.equal(calls.length, 1);
  assert.equal(view.root.findByType(Image).props.cachePolicy, 'none');
  await act(async () => { view.unmount(); });
  assert.equal(calls[0].options.signal.aborted, true);
});

test('state decode failure returns every state to its own bundled fallback until revision changes', async () => {
  const { released } = harness();
  let calls = 0;
  const client = { config, resolveStateSet: async () => { calls++; return { source: 'remote', sequence: 7, message: 'complete', states: { sprout: resolved('a'), grown: resolved('b') } }; } };
  let view;
  await act(async () => { view = create(React.createElement(adapter.AssetlibStateImage, { client, asset: group, state: 'sprout', fallbacks })); });
  await act(async () => { view.root.findByType(Image).props.onError({ error: 'decode failed' }); });
  assert.equal(view.root.findByType(Image).props.source, 1);
  await act(async () => { view.update(React.createElement(adapter.AssetlibStateImage, { client, asset: group, state: 'grown', fallbacks })); });
  assert.equal(view.root.findByType(Image).props.source, 2);
  assert.equal(calls, 1);
  assert.ok(released.includes('a') && released.includes('b'));
  await act(async () => { view.update(React.createElement(adapter.AssetlibStateImage, { client, asset: group, state: 'grown', fallbacks, revision: 1 })); });
  assert.equal(calls, 2);
  assert.deepEqual(view.root.findByType(Image).props.source, { uri: 'verified:b' });
  await act(async () => { view.unmount(); });
});

test('incomplete state family releases prepared images and keeps the whole family bundled', async () => {
  const { released } = harness();
  const client = { config, resolveStateSet: async () => ({ source: 'remote', sequence: 7, message: 'incomplete', states: { sprout: resolved('a') } }) };
  let view;
  await act(async () => { view = create(React.createElement(adapter.AssetlibStateImage, { client, asset: group, state: 'sprout', fallbacks })); });
  assert.equal(view.root.findByType(Image).props.source, 1);
  assert.ok(released.includes('a'));
  await act(async () => { view.unmount(); });
});

test('dynamic references cancel replaced requests and ignore stale results', async () => {
  harness();
  const first = deferred(), second = deferred(), calls = [];
  const client = { config, resolveAsset: (asset, options) => { calls.push({ asset, options }); return calls.length === 1 ? first.promise : second.promise; } };
  let view;
  const firstRef = { kind: 'dynamic', assetId: 'first' }, secondRef = { kind: 'dynamic', assetId: 'second' };
  await act(async () => { view = create(React.createElement(adapter.AssetlibDynamicImage, { client, asset: firstRef, fallback: 1, cachePolicy: 'memory' })); });
  await act(async () => { view.update(React.createElement(adapter.AssetlibDynamicImage, { client, asset: secondRef, fallback: 2, cachePolicy: 'memory' })); });
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(calls[1].options.cachePolicy, 'memory');
  await act(async () => { second.resolve(resolved('b', 'memory')); first.resolve(resolved('a', 'memory')); });
  assert.deepEqual(view.root.findByType(Image).props.source, { uri: 'verified:b' });
  await act(async () => { view.unmount(); });
  assert.equal(calls[1].options.signal.aborted, true);
});

test('legacy placement requests abort on unmount', async () => {
  harness();
  let signal;
  const pending = deferred();
  const client = { config, resolve: (_asset, options) => { signal = options.signal; return pending.promise; } };
  let view;
  await act(async () => { view = create(React.createElement(adapter.AssetlibImage, { client, asset: { key: 'hero', width: 100, height: 100 }, fallback: 1 })); });
  await act(async () => { view.unmount(); pending.resolve(resolved()); });
  assert.equal(signal.aborted, true);
});

test('an image URI completing after unmount is released without publishing stale status', async () => {
  const { released } = harness();
  const decoding = deferred(), statuses = [];
  globalThis.__assetlibAdapter.imageUri = () => decoding.promise;
  const client = { config, resolveAsset: async () => resolved() };
  let view;
  await act(async () => { view = create(React.createElement(adapter.AssetlibDynamicImage, { client, asset: { kind: 'dynamic', assetId: 'first', sequence: 7 }, fallback: 1, onStatus: status => statuses.push(status) })); });
  assert.equal(view.root.findByType(Image).props.recyclingKey, 'first:7');
  await act(async () => { view.unmount(); });
  await act(async () => { decoding.resolve({ uri: 'verified:a', release() { released.push('a'); } }); });
  assert.deepEqual(released, ['a']);
  assert.deepEqual(statuses.map(status => status.source), ['bundle']);
});

test('opt-in descriptions follow displayed artwork and return to bundle metadata on decode failure', async () => {
  harness();
  const pending = deferred();
  const client = { config, resolve: () => pending.promise };
  const asset = { key: 'travel.coast', width: 100, height: 100, bundledAccessibility: description('Bundled coast') };
  let view;
  await act(async () => { view = create(React.createElement(adapter.AssetlibImage, { client, asset, fallback: 1, accessibilityMode: 'description', accessibilityLocale: 'TH-th' })); });
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'ไทย Bundled coast');
  assert.equal(view.root.findByType(Image).props.source, 1);
  await act(async () => { pending.resolve({ ...resolved(), accessibility: description('Remote forest') }); });
  assert.deepEqual(view.root.findByType(Image).props.source, { uri: 'verified:a' });
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'ไทย Remote forest');
  assert.equal(view.root.findByType(Image).props.accessible, true);
  await act(async () => { view.root.findByType(Image).props.onError({ error: 'decode' }); });
  assert.equal(view.root.findByType(Image).props.source, 1);
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'ไทย Bundled coast');
  await act(async () => { view.unmount(); });
});

test('description mode retains bundled artwork for unlabeled legacy content and permits native app overrides', async () => {
  harness();
  const client = { config, resolve: async () => resolved() };
  const props = { client, asset: { key: 'travel.coast', width: 100, height: 100 }, fallback: 1, fallbackAccessibility: description('Bundle'), accessibilityMode: 'description' };
  let view;
  await act(async () => { view = create(React.createElement(adapter.AssetlibImage, props)); });
  assert.equal(view.root.findByType(Image).props.source, 1);
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'Bundle');
  await act(async () => { view.update(React.createElement(adapter.AssetlibImage, { ...props, accessibilityLabel: 'Explore trips' })); });
  assert.deepEqual(view.root.findByType(Image).props.source, { uri: 'verified:a' });
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'Explore trips');
  await act(async () => { view.update(React.createElement(adapter.AssetlibImage, { ...props, accessibilityMode: 'decorative', accessibilityLabel: 'App label', accessible: true })); });
  assert.equal(view.root.findByType(Image).props.accessible, false);
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, undefined);
  assert.equal(view.root.findByType(Image).props.accessibilityElementsHidden, true);
  assert.equal(view.root.findByType(Image).props.importantForAccessibility, 'no-hide-descendants');
  assert.equal(view.root.findByType(Image).props['aria-hidden'], true);
  await act(async () => { view.update(React.createElement(adapter.AssetlibImage, { ...props, accessibilityMode: undefined })); });
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, undefined);
  assert.equal(view.root.findByType(Image).props.accessible, undefined);
  await act(async () => { view.unmount(); });
});

test('dynamic request changes immediately pair the new bundle and its description, ignoring stale metadata', async () => {
  harness();
  const first = deferred(), second = deferred();
  const firstRef = { kind: 'dynamic', assetId: 'first', sequence: 1 }, secondRef = { kind: 'dynamic', assetId: 'second', sequence: 1 };
  const client = { config, resolveAsset: asset => asset === firstRef ? first.promise : second.promise };
  const common = { client, accessibilityMode: 'description' };
  let view;
  await act(async () => { view = create(React.createElement(adapter.AssetlibDynamicImage, { ...common, asset: firstRef, fallback: 1, fallbackAccessibility: description('First placeholder') })); });
  await act(async () => { first.resolve({ ...resolved('a'), accessibility: description('First remote') }); });
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'First remote');
  await act(async () => { view.update(React.createElement(adapter.AssetlibDynamicImage, { ...common, asset: secondRef, fallback: 2, fallbackAccessibility: description('Second placeholder') })); });
  assert.equal(view.root.findByType(Image).props.source, 2);
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'Second placeholder');
  await act(async () => { second.resolve({ ...resolved('b'), accessibility: description('Second remote') }); });
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'Second remote');
  await act(async () => { view.unmount(); });
});

test('state selection and family decode fallback keep each description with its image', async () => {
  harness();
  const client = { config, resolveStateSet: async () => ({ source: 'remote', sequence: 7, message: 'complete', states: { sprout: { ...resolved('a'), accessibility: description('Remote sprout') }, grown: { ...resolved('b'), accessibility: description('Remote grown') } } }) };
  const common = { client, asset: { ...group, bundledStateAccessibility: { sprout: description('Bundle sprout'), grown: description('Bundle grown') } }, fallbacks, accessibilityMode: 'description' };
  let view;
  await act(async () => { view = create(React.createElement(adapter.AssetlibStateImage, { ...common, state: 'sprout' })); });
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'Remote sprout');
  await act(async () => { view.update(React.createElement(adapter.AssetlibStateImage, { ...common, state: 'grown' })); });
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'Remote grown');
  await act(async () => { view.root.findByType(Image).props.onError({ error: 'decode' }); });
  assert.equal(view.root.findByType(Image).props.source, 2);
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'Bundle grown');
  await act(async () => { view.update(React.createElement(adapter.AssetlibStateImage, { ...common, state: 'sprout' })); });
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'Bundle sprout');
  await act(async () => { view.unmount(); });
});

test('a state family missing one description stays entirely bundled in description mode', async () => {
  harness();
  const client = { config, resolveStateSet: async () => ({ source: 'remote', sequence: 7, message: 'complete', states: { sprout: { ...resolved('a'), accessibility: description('Remote sprout') }, grown: resolved('b') } }) };
  const common = { client, asset: group, fallbacks, fallbackAccessibility: { sprout: description('Bundle sprout'), grown: description('Bundle grown') }, accessibilityMode: 'description' };
  let view;
  await act(async () => { view = create(React.createElement(adapter.AssetlibStateImage, { ...common, state: 'sprout' })); });
  assert.equal(view.root.findByType(Image).props.source, 1);
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'Bundle sprout');
  await act(async () => { view.update(React.createElement(adapter.AssetlibStateImage, { ...common, state: 'grown' })); });
  assert.equal(view.root.findByType(Image).props.source, 2);
  assert.equal(view.root.findByType(Image).props.accessibilityLabel, 'Bundle grown');
  await act(async () => { view.unmount(); });
});
