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
  await writeFile(path.join(temporary, name.replace(/\.tsx?$/, '.mjs')), (name === 'telemetry.ts' ? `const require = name => globalThis.__assetlibAdapter.optionalRequire(name);\n` : '') + compiled);
};
await writeFile(path.join(temporary, 'core.mjs'), `
export const SDK_LIMITS = { assetBytes: 8 * 1024 * 1024 };
import { createHash } from 'node:crypto';
export const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
export const parsePublicConfig = value => value;
export const createAssetClient = (config, options) => ({ config, options, flush: async () => { globalThis.__assetlibAdapter.flushes++; if (globalThis.__assetlibAdapter.flushError) throw new Error('offline'); }, dispose: () => { globalThis.__assetlibAdapter.disposals++; } });
export { resolveAccessibilityDescription } from '${pathToFileURL(path.join(root, '../sdk-core/dist/accessibility.js')).href}';
`);
await writeFile(path.join(temporary, 'platform.mjs'), `
export const vectorRenderingSupported = true;
export const platformFetch = globalThis.fetch;
export const createPlatformStorage = config => ({ persistentConfig: config });
export const imageUri = (...args) => globalThis.__assetlibAdapter.imageUri(...args);
`);
await writeFile(path.join(temporary, 'image.mjs'), `
import React from 'react';
export class Image extends React.Component {
  onLoad = event => this.props.onLoad?.(event);
  onError = event => this.props.onError?.(event);
  render() { return null; }
}
`);
await writeFile(path.join(temporary, 'react-native.mjs'), `
import { useSyncExternalStore } from 'react';
export const Platform = { get OS() { return globalThis.__assetlibAdapter.os ?? 'ios'; } };
export const AppState = { addEventListener: (_event, listener) => {
  if (globalThis.__assetlibAdapter.appStateError) throw new Error('AppState unavailable');
  const listeners = globalThis.__assetlibAdapter.appStateListeners;
  listeners.add(listener); return { remove() { listeners.delete(listener); } };
} };
export function background(state = 'background') { for (const listener of globalThis.__assetlibAdapter.appStateListeners) listener(state); };
const listeners = new Set();
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
const snapshot = () => globalThis.__assetlibAdapter.colorScheme ?? null;
export function useColorScheme() { return useSyncExternalStore(subscribe, snapshot); }
export function setColorScheme(value) {
  globalThis.__assetlibAdapter.colorScheme = value;
  for (const listener of listeners) listener();
}
`);
await writeFile(path.join(temporary, 'filesystem.mjs'), `
export class File {
  constructor(directory, name) {
    globalThis.__assetlibAdapter.fileCalls++;
    if (!globalThis.__assetlibAdapter.allowFiles) throw new Error('Unexpected file access');
    this.key = directory.uri + '/' + name;
    this.name = name;
    this.uri = 'file:///mock/' + name;
  }
  get exists() { return globalThis.__assetlibAdapter.fileData.has(this.key) || globalThis.__assetlibAdapter.files?.includes(this.name); }
  get size() { return globalThis.__assetlibAdapter.fileData.get(this.key)?.length ?? 0; }
  async text() { return globalThis.__assetlibAdapter.fileData.get(this.key); }
  create() { globalThis.__assetlibAdapter.fileData.set(this.key, ''); }
  write(value) { globalThis.__assetlibAdapter.fileData.set(this.key, value); }
  async move(target) { const data = globalThis.__assetlibAdapter.fileData; data.set(target.key, data.get(this.key)); data.delete(this.key); }
}
export class Directory {
  constructor(parent, name = '', child = '') {
    globalThis.__assetlibAdapter.fileCalls++;
    if (!globalThis.__assetlibAdapter.allowFiles) throw new Error('Unexpected directory access');
    this.uri = (parent.uri ?? parent) + '/' + name + '/' + child;
  }
  create() {}
}
export const Paths = { document: '/documents' };
`);
await writeFile(path.join(temporary, 'fetch.mjs'), `export const fetch = globalThis.fetch;`);
await transpile('index.tsx', { '@assetlib/sdk-core': './core.mjs', './platform': './platform.mjs', './shared': './shared.mjs', './telemetry': './telemetry.mjs', 'expo-image': './image.mjs', 'react-native': './react-native.mjs' });
await transpile('telemetry.ts', { '@assetlib/sdk-core': './core.mjs', 'react-native': './react-native.mjs' });
await transpile('platform.web.ts', { '@assetlib/sdk-core': './core.mjs', './shared': './shared.mjs' });
await transpile('shared.ts', { '@assetlib/sdk-core': './core.mjs' });
await transpile('platform.native.ts', { '@assetlib/sdk-core': './core.mjs', './shared': './shared.mjs', 'expo-file-system': './filesystem.mjs', 'expo/fetch': './fetch.mjs' });
const adapter = await import(pathToFileURL(path.join(temporary, 'index.mjs')));
const native = await import(pathToFileURL(path.join(temporary, 'platform.native.mjs')));
const { Image } = await import(pathToFileURL(path.join(temporary, 'image.mjs')));
const web = await import(pathToFileURL(path.join(temporary, 'platform.web.mjs')));
const { setColorScheme, background } = await import(pathToFileURL(path.join(temporary, 'react-native.mjs')));
const { namespace, rasterDataUri } = await import(pathToFileURL(path.join(temporary, 'shared.mjs')));
const resolved = (name = 'a', cachePolicy = 'none') => ({ source: 'remote', sequence: 7, message: 'verified', arm: null, armSource: 'control', sha256: name.repeat(64), assetId: name, mime: 'image/png', bytes: new Uint8Array([1, 2, 3]), cachePolicy });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function harness() {
  const released = [];
  globalThis.__assetlibAdapter = { fileCalls: 0, fileData: new Map(), appStateListeners: new Set(), flushes: 0, disposals: 0, optionalRequire: () => { throw new Error('Module absent'); }, imageUri: async (_config, result) => ({ uri: `verified:${result.assetId}`, release() { released.push(result.assetId); } }) };
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

test('native disk rendering opens the appearance cache key and supports legacy content-hash entries', async () => {
  harness();
  const hash = 'a'.repeat(64), cacheKey = 'b'.repeat(64);
  Object.assign(globalThis.__assetlibAdapter, { allowFiles: true, files: [`${cacheKey}.png`] });
  assert.equal((await native.imageUri(config, { ...resolved('a', 'disk'), cacheKey })).uri, `file:///mock/${cacheKey}.png`);
  await assert.rejects(native.imageUri(config, resolved('a', 'disk')), /evicted/);
  globalThis.__assetlibAdapter.files = [`${hash}.png`];
  assert.equal((await native.imageUri(config, resolved('a', 'disk'))).uri, `file:///mock/${hash}.png`);
  await assert.rejects(native.imageUri(config, { ...resolved('a', 'disk'), cacheKey: '../invalid' }), /Invalid cache key/);
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

test('factory forwards the app decision callback unchanged', () => {
  const decide = async ({ arms }) => arms[0];
  const client = adapter.createExpoAssetClient(config, { decide });
  assert.equal(client.options.decide, decide);
});

test('state changes select a pinned complete family without refetching or mixing fallbacks', async () => {
  harness();
  const lastDecode = deferred();
  globalThis.__assetlibAdapter.imageUri = async (_config, result) => result.assetId === 'b' ? lastDecode.promise : { uri: 'verified:a', release() {} };
  const calls = [];
  const client = { reportDisplay() {}, reportFallback() {}, config, resolveStateSet: async (asset, options) => { calls.push({ asset, options }); return { source: 'remote', sequence: 7, message: 'complete', states: { sprout: resolved('a'), grown: resolved('b') } }; } };
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
  const client = { reportDisplay() {}, reportFallback() {}, config, resolveStateSet: async () => { calls++; return { source: 'remote', sequence: 7, message: 'complete', states: { sprout: resolved('a'), grown: resolved('b') } }; } };
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
  const client = { reportDisplay() {}, reportFallback() {}, config, resolveStateSet: async () => ({ source: 'remote', sequence: 7, message: 'incomplete', states: { sprout: resolved('a') } }) };
  let view;
  await act(async () => { view = create(React.createElement(adapter.AssetlibStateImage, { client, asset: group, state: 'sprout', fallbacks })); });
  assert.equal(view.root.findByType(Image).props.source, 1);
  assert.ok(released.includes('a'));
  await act(async () => { view.unmount(); });
});

test('dynamic references cancel replaced requests and ignore stale results', async () => {
  harness();
  const first = deferred(), second = deferred(), calls = [];
  const client = { reportDisplay() {}, reportFallback() {}, config, resolveAsset: (asset, options) => { calls.push({ asset, options }); return calls.length === 1 ? first.promise : second.promise; } };
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
  const client = { reportDisplay() {}, reportFallback() {}, config, resolve: (_asset, options) => { signal = options.signal; return pending.promise; } };
  let view;
  await act(async () => { view = create(React.createElement(adapter.AssetlibImage, { client, asset: { key: 'hero', width: 100, height: 100 }, fallback: 1 })); });
  await act(async () => { view.unmount(); pending.resolve(resolved()); });
  assert.equal(signal.aborted, true);
});

test('an image URI completing after unmount is released without publishing stale status', async () => {
  const { released } = harness();
  const decoding = deferred(), statuses = [];
  globalThis.__assetlibAdapter.imageUri = () => decoding.promise;
  const client = { reportDisplay() {}, reportFallback() {}, config, resolveAsset: async () => resolved() };
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
  const client = { reportDisplay() {}, reportFallback() {}, config, resolve: () => pending.promise };
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
  const client = { reportDisplay() {}, reportFallback() {}, config, resolve: async () => resolved() };
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
  const client = { reportDisplay() {}, reportFallback() {}, config, resolveAsset: asset => asset === firstRef ? first.promise : second.promise };
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
  const client = { reportDisplay() {}, reportFallback() {}, config, resolveStateSet: async () => ({ source: 'remote', sequence: 7, message: 'complete', states: { sprout: { ...resolved('a'), accessibility: description('Remote sprout') }, grown: { ...resolved('b'), accessibility: description('Remote grown') } } }) };
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
  const client = { reportDisplay() {}, reportFallback() {}, config, resolveStateSet: async () => ({ source: 'remote', sequence: 7, message: 'complete', states: { sprout: { ...resolved('a'), accessibility: description('Remote sprout') }, grown: resolved('b') } }) };
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

for (const [component, method, asset] of [
  ['AssetlibImage', 'resolve', { key: 'travel.coast', width: 120, height: 120 }],
  ['AssetlibDynamicImage', 'resolveAsset', { kind: 'dynamic', assetId: 'coast', sequence: 7 }],
]) {
  test(`${component} follows effective system appearance, aborts stale requests and selects dark fallbacks`, async () => {
    const { released } = harness(), calls = [];
    const client = { reportDisplay() {}, reportFallback() {}, config, [method]: (_asset, options) => {
      const pending = deferred(); calls.push({ options, ...pending }); return pending.promise;
    } };
    const props = { client, asset, fallback: 1, fallbackDark: 2 };
    let view;
    await act(async () => { view = create(React.createElement(adapter[component], props)); });
    assert.equal(calls[0].options.appearance, undefined);
    assert.equal(view.root.findByType(Image).props.source, 1);
    await act(async () => { setColorScheme('dark'); });
    assert.equal(calls[0].options.signal.aborted, true);
    assert.equal(calls[1].options.appearance, 'dark');
    assert.equal(view.root.findByType(Image).props.source, 2);
    assert.equal(view.root.findByType(Image).props.appearance, undefined);
    assert.equal(view.root.findByType(Image).props.fallbackDark, undefined);
    await act(async () => { calls[1].resolve(resolved('b')); calls[0].resolve(resolved('a')); });
    assert.deepEqual(view.root.findByType(Image).props.source, { uri: 'verified:b' });
    await act(async () => { setColorScheme('light'); });
    assert.equal(calls[2].options.appearance, 'light');
    assert.equal(view.root.findByType(Image).props.source, 1);
    assert.ok(released.includes('b'));
    await act(async () => { setColorScheme(null); });
    assert.equal(calls[3].options.appearance, undefined);
    assert.equal(view.root.findByType(Image).props.source, 1);
    await act(async () => { setColorScheme('unspecified'); });
    assert.equal(calls.length, 4, 'unspecified system appearance also means no preference');
    await act(async () => { view.update(React.createElement(adapter[component], { ...props, appearance: 'light' })); });
    assert.equal(calls[4].options.appearance, 'light');
    await act(async () => { setColorScheme('dark'); });
    assert.equal(calls.length, 5, 'an explicit light preference does not re-resolve for system changes');
    await act(async () => { view.update(React.createElement(adapter[component], { ...props, appearance: 'dark' })); });
    assert.equal(calls[5].options.appearance, 'dark');
    assert.equal(view.root.findByType(Image).props.source, 2);
    await act(async () => { calls[5].resolve(resolved('c')); });
    await act(async () => { view.root.findByType(Image).props.onError({ error: 'decode' }); });
    assert.equal(view.root.findByType(Image).props.source, 2);
    await act(async () => { view.update(React.createElement(adapter[component], { ...props, fallbackDark: undefined, appearance: 'dark' })); });
    assert.equal(view.root.findByType(Image).props.source, 1, 'dark fallback remains optional');
    assert.equal(calls.length, 6);
    await act(async () => { view.unmount(); });
  });
}

test('state images re-resolve a whole family for appearance changes and use matching dark bundle states', async () => {
  const { released } = harness(), calls = [];
  const client = { reportDisplay() {}, reportFallback() {}, config, resolveStateSet: (_asset, options) => {
    const pending = deferred(); calls.push({ options, ...pending }); return pending.promise;
  } };
  const props = { client, asset: group, state: 'sprout', fallbacks, fallbacksDark: { sprout: 3, grown: 4 } };
  const family = (a, b) => ({ source: 'remote', sequence: 7, message: 'complete', states: { sprout: resolved(a), grown: resolved(b) } });
  let view;
  await act(async () => { view = create(React.createElement(adapter.AssetlibStateImage, props)); });
  assert.equal(calls[0].options.appearance, undefined);
  await act(async () => { calls[0].resolve(family('a', 'b')); });
  assert.deepEqual(view.root.findByType(Image).props.source, { uri: 'verified:a' });
  await act(async () => { setColorScheme('dark'); });
  assert.equal(calls[1].options.appearance, 'dark');
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(view.root.findByType(Image).props.source, 3);
  assert.ok(released.includes('a') && released.includes('b'));
  await act(async () => { view.update(React.createElement(adapter.AssetlibStateImage, { ...props, state: 'grown' })); });
  assert.equal(view.root.findByType(Image).props.source, 4);
  assert.equal(calls.length, 2);
  await act(async () => { calls[1].resolve(family('c', 'd')); });
  assert.deepEqual(view.root.findByType(Image).props.source, { uri: 'verified:d' });
  await act(async () => { view.root.findByType(Image).props.onError({ error: 'decode' }); });
  assert.equal(view.root.findByType(Image).props.source, 4);
  await act(async () => { view.update(React.createElement(adapter.AssetlibStateImage, props)); });
  assert.equal(view.root.findByType(Image).props.source, 3);
  assert.equal(calls.length, 2);
  await act(async () => { setColorScheme('light'); });
  assert.equal(calls[2].options.appearance, 'light');
  assert.equal(view.root.findByType(Image).props.source, 1);
  await act(async () => { setColorScheme(null); });
  assert.equal(calls[3].options.appearance, undefined);
  await act(async () => { view.update(React.createElement(adapter.AssetlibStateImage, { ...props, appearance: 'dark', fallbacksDark: undefined })); });
  assert.equal(calls[4].options.appearance, 'dark');
  assert.equal(view.root.findByType(Image).props.source, 1);
  await act(async () => { setColorScheme('dark'); });
  assert.equal(calls.length, 5, 'unchanged effective appearance keeps the request pinned');
  await act(async () => { view.unmount(); });
});

test('a supplied dark bundle must cover every state instead of borrowing from the any bundle', async () => {
  harness();
  const client = { reportDisplay() {}, reportFallback() {}, config, resolveStateSet: async () => ({ source: 'bundle', sequence: null, message: 'offline', states: {} }) };
  await assert.rejects(async () => {
    await act(async () => {
      create(React.createElement(adapter.AssetlibStateImage, { client, asset: group, state: 'sprout', fallbacks, fallbacksDark: { sprout: 3 }, appearance: 'dark' }));
    });
  }, /Every artwork state requires its own dark bundled fallback/);
});

for (const [component, method, initialProps, finish] of [
  ['AssetlibImage', 'resolve', { asset: { key: 'travel.coast', width: 120, height: 120 }, fallback: 1 }, (name, arm, armSource) => ({ ...resolved(name), arm, armSource })],
  ['AssetlibStateImage', 'resolveStateSet', { asset: group, state: 'sprout', fallbacks }, (name, arm, armSource) => ({ source: 'remote', sequence: 7, message: 'complete', arm, armSource, states: { sprout: { ...resolved(name), arm, armSource }, grown: { ...resolved(`${name}2`), arm, armSource } } })],
]) {
  test(`${component} re-resolves on arm changes, discards stale results and reports the rendered arm`, async () => {
    const { released } = harness(), calls = [], statuses = [];
    const client = { reportDisplay() {}, reportFallback() {}, config, [method]: (_asset, options) => {
      const pending = deferred(); calls.push({ options, ...pending }); return pending.promise;
    } };
    const props = { ...initialProps, client, appearance: 'dark', onStatus: status => statuses.push(status) };
    let view;
    await act(async () => { view = create(React.createElement(adapter[component], props)); });
    assert.equal(calls[0].options.arm, undefined);
    assert.equal(calls[0].options.appearance, 'dark');
    assert.equal(statuses.at(-1).arm, null);
    assert.equal(statuses.at(-1).armSource, 'control');
    await act(async () => { calls[0].resolve(finish('a', 'b', 'decision')); });
    assert.deepEqual(view.root.findByType(Image).props.source, { uri: 'verified:a' });
    assert.equal(statuses.at(-1).arm, 'b');
    assert.equal(statuses.at(-1).armSource, 'decision');

    await act(async () => { view.update(React.createElement(adapter[component], { ...props, arm: 'c' })); });
    assert.equal(calls[0].options.signal.aborted, true);
    assert.equal(calls[1].options.arm, 'c');
    assert.equal(view.root.findByType(Image).props.source, 1);
    assert.equal(view.root.findByType(Image).props.arm, undefined, 'arm is consumed by the adapter');
    assert.ok(released.includes('a'));
    assert.equal(statuses.at(-1).arm, null);
    assert.equal(statuses.at(-1).armSource, 'control');
    await act(async () => { view.update(React.createElement(adapter[component], { ...props, arm: 'b' })); });
    assert.equal(calls[1].options.signal.aborted, true);
    assert.equal(calls[2].options.arm, 'b');
    const countBeforeStale = statuses.length;
    await act(async () => { calls[1].resolve(finish('c', 'c', 'explicit')); });
    assert.equal(statuses.length, countBeforeStale);
    assert.equal(view.root.findByType(Image).props.source, 1);
    await act(async () => { calls[2].resolve(finish('b', 'b', 'explicit')); });
    assert.deepEqual(view.root.findByType(Image).props.source, { uri: 'verified:b' });
    assert.equal(statuses.at(-1).arm, 'b');
    assert.equal(statuses.at(-1).armSource, 'explicit');

    if (component === 'AssetlibStateImage') {
      await act(async () => { view.update(React.createElement(adapter[component], { ...props, state: 'grown', arm: 'b' })); });
      assert.deepEqual(view.root.findByType(Image).props.source, { uri: 'verified:b2' });
      assert.equal(calls.length, 3, 'state changes keep the selected arm family pinned');
    }
    await act(async () => { view.root.findByType(Image).props.onError({ error: 'decode' }); });
    assert.equal(statuses.at(-1).source, 'bundle');
    assert.equal(statuses.at(-1).arm, null);
    assert.equal(statuses.at(-1).armSource, 'control');
    await act(async () => { view.unmount(); });
    assert.equal(calls[2].options.signal.aborted, true);
  });

  test(`${component} preserves invalid-decision diagnostics for control and bundled results`, async () => {
    harness();
    const statuses = [];
    let result = { ...finish('a', null, 'invalid-decision'), message: 'Decision returned an undeclared arm; using control.' };
    const client = { reportDisplay() {}, reportFallback() {}, config, [method]: async () => result };
    const props = { ...initialProps, client, onStatus: status => statuses.push(status) };
    let view;
    await act(async () => { view = create(React.createElement(adapter[component], props)); });
    assert.equal(statuses.at(-1).arm, null);
    assert.equal(statuses.at(-1).armSource, 'invalid-decision');
    assert.equal(statuses.at(-1).message, result.message);
    result = { source: 'bundle', sequence: null, arm: null, armSource: 'invalid-decision', message: 'Decision failed; using bundled artwork.', states: {} };
    await act(async () => { view.update(React.createElement(adapter[component], { ...props, revision: 1 })); });
    assert.equal(view.root.findByType(Image).props.source, 1);
    assert.equal(statuses.at(-1).source, 'bundle');
    assert.equal(statuses.at(-1).arm, null);
    assert.equal(statuses.at(-1).armSource, 'invalid-decision');
    assert.equal(statuses.at(-1).message, result.message);
    await act(async () => { view.unmount(); });
  });
}

test('telemetry is opt-in, passes explicit metadata through, and needs no optional packages', () => {
  harness();
  let lookups = 0;
  globalThis.__assetlibAdapter.optionalRequire = () => { lookups++; throw new Error('absent'); };
  assert.equal(adapter.createExpoAssetClient(config).options.telemetry, undefined);
  assert.deepEqual(adapter.createExpoAssetClient(config, { telemetry: { enabled: false } }).options.telemetry, { enabled: false });
  assert.equal(lookups, 0);
  assert.equal(globalThis.__assetlibAdapter.appStateListeners.size, 0);
  const telemetry = { enabled: true, installId: 'custom-install', flushIntervalMs: 1234, maxBatch: 12, sdk: { name: 'custom', version: '1' }, build: { platform: 'ios', appVersion: '2.3', buildNumber: '40' } };
  const explicit = adapter.createExpoAssetClient(config, { telemetry });
  assert.deepEqual(explicit.options.telemetry, telemetry);
  assert.equal(lookups, 0, 'explicit metadata avoids optional lookups');
  explicit.dispose();
  const missing = adapter.createExpoAssetClient(config, { telemetry: { enabled: true } });
  assert.deepEqual(missing.options.telemetry.sdk, { name: 'sdk-expo', version: '0.3.0-preview.1' });
  assert.deepEqual(missing.options.telemetry.build, { platform: 'expo', appVersion: 'unknown', buildNumber: 'unknown' });
  assert.equal(lookups, 2);
  missing.dispose();
});

test('optional application and constants metadata are read safely with native versions preferred', () => {
  harness();
  const modules = { 'expo-application': { nativeApplicationVersion: '1.6.0', nativeBuildVersion: '231' }, 'expo-constants': { default: { expoConfig: { version: '1.5.0', ios: { buildNumber: '201' }, android: { versionCode: 202 } } } } };
  globalThis.__assetlibAdapter.optionalRequire = name => modules[name];
  const createClient = () => adapter.createExpoAssetClient(config, { telemetry: { enabled: true } });
  let client = createClient();
  assert.deepEqual(client.options.telemetry.build, { platform: 'ios', appVersion: '1.6.0', buildNumber: '231' }); client.dispose();
  delete modules['expo-application'];
  globalThis.__assetlibAdapter.os = 'android';
  client = createClient();
  assert.deepEqual(client.options.telemetry.build, { platform: 'android', appVersion: '1.5.0', buildNumber: '202' }); client.dispose();
  modules['expo-application'] = { get nativeApplicationVersion() { throw new Error('native bridge unavailable'); } };
  assert.doesNotThrow(() => { client = createClient(); client.dispose(); });
  assert.deepEqual(client.options.telemetry.build, { platform: 'expo', appVersion: 'unknown', buildNumber: 'unknown' });
  modules['expo-application'] = { nativeApplicationVersion: 'bad version', nativeBuildVersion: 10 };
  client = createClient(); client.dispose();
  assert.deepEqual(client.options.telemetry.build, { platform: 'expo', appVersion: 'unknown', buildNumber: 'unknown' });
});

test('enabled clients flush on app background, swallow failure, and remove subscriptions on dispose', async () => {
  harness();
  const client = adapter.createExpoAssetClient(config, { telemetry: { enabled: true } });
  assert.equal(globalThis.__assetlibAdapter.appStateListeners.size, 1);
  background('active'); background('inactive');
  assert.equal(globalThis.__assetlibAdapter.flushes, 0);
  globalThis.__assetlibAdapter.flushError = true;
  background();
  await Promise.resolve();
  assert.equal(globalThis.__assetlibAdapter.flushes, 1);
  client.dispose();
  assert.equal(globalThis.__assetlibAdapter.disposals, 1);
  assert.equal(globalThis.__assetlibAdapter.appStateListeners.size, 0);
  background();
  assert.equal(globalThis.__assetlibAdapter.flushes, 1);
  globalThis.__assetlibAdapter.appStateError = true;
  assert.doesNotThrow(() => adapter.createExpoAssetClient(config, { telemetry: { enabled: true } }).dispose());
});

for (const [component, method, componentProps, finish] of [
  ['AssetlibImage', 'resolve', { asset: { key: 'travel.coast', width: 120, height: 120 }, fallback: 1 }, result => result],
  ['AssetlibDynamicImage', 'resolveAsset', { asset: { kind: 'dynamic', assetId: 'coast', sequence: 7 }, fallback: 1 }, result => result],
  ['AssetlibStateImage', 'resolveStateSet', { asset: group, state: 'sprout', fallbacks }, result => ({ ...result, states: { sprout: result, grown: resolved('c') } })],
]) {
  test(`${component} reports one decoded display per mount and only current verified decode failures`, async () => {
    harness();
    const calls = [], displays = [], failures = [], loads = [], errors = [];
    const client = { config, [method]: () => { const pending = deferred(); calls.push(pending); return pending.promise; }, reportDisplay: (...args) => displays.push(args), reportFallback: (...args) => failures.push(args) };
    const props = { ...componentProps, client, onLoad: event => loads.push(event), onError: event => errors.push(event) };
    let view;
    await act(async () => { view = create(React.createElement(adapter[component], props)); });
    const bundleRenderer = view.root.findByType(Image).props;
    await act(async () => { bundleRenderer.onLoad('bundle'); bundleRenderer.onError('bundle error'); });
    assert.deepEqual(displays, []); assert.deepEqual(failures, []);
    const first = { ...resolved('a'), arm: 'b', appearance: 'dark' };
    await act(async () => { calls[0].resolve(finish(first)); });
    const oldRenderer = view.root.findByType(Image).props;
    await act(async () => { bundleRenderer.onLoad('late bundle'); oldRenderer.onLoad('first'); oldRenderer.onLoad('duplicate'); });
    assert.deepEqual(displays, [[componentProps.asset, first]]);
    await act(async () => { view.update(React.createElement(adapter[component], { ...props, revision: 1 })); });
    const second = { ...resolved('b'), source: 'cache' };
    await act(async () => { calls[1].resolve(finish(second)); oldRenderer.onError('stale'); oldRenderer.onLoad('stale'); });
    assert.deepEqual(view.root.findByType(Image).props.source, { uri: 'verified:b' });
    assert.equal(failures.length, 0);
    const currentRenderer = view.root.findByType(Image).props;
    await act(async () => { currentRenderer.onLoad('second'); currentRenderer.onError('decode'); currentRenderer.onError('duplicate decode'); });
    assert.equal(displays.length, 1, 'revision changes do not create another display for this mount');
    assert.deepEqual(failures, [[componentProps.asset, second, 'decode']]);
    assert.equal(view.root.findByType(Image).props.source, 1);
    await act(async () => { view.unmount(); currentRenderer.onLoad('unmounted'); currentRenderer.onError('unmounted'); });
    assert.equal(displays.length, 1); assert.equal(failures.length, 1);
    assert.ok(loads.includes('first') && loads.includes('bundle') && loads.includes('second'));
    assert.ok(errors.includes('decode') && errors.includes('bundle error'));
    await act(async () => { view = create(React.createElement(adapter[component], props)); });
    await act(async () => { calls[2].resolve(finish(second)); });
    await act(async () => { view.root.findByType(Image).props.onLoad('remount'); });
    assert.equal(displays.length, 2);
    await act(async () => { view.unmount(); });
  });
}

test('state image observations follow the active state and ignore replaced state callbacks', async () => {
  harness();
  const displays = [], failures = [];
  const sprout = resolved('a'), grown = { ...resolved('b'), source: 'cache' };
  const client = { config, resolveStateSet: async () => ({ ...sprout, states: { sprout, grown } }), reportDisplay: (...args) => displays.push(args), reportFallback: (...args) => failures.push(args) };
  const props = { client, asset: group, fallbacks };
  let view;
  await act(async () => { view = create(React.createElement(adapter.AssetlibStateImage, { ...props, state: 'sprout' })); });
  const first = view.root.findByType(Image).props;
  await act(async () => { view.update(React.createElement(adapter.AssetlibStateImage, { ...props, state: 'grown' })); });
  await act(async () => { first.onLoad('late'); first.onError('late'); });
  assert.deepEqual(displays, []); assert.deepEqual(failures, []);
  await act(async () => { view.root.findByType(Image).props.onLoad('loaded'); });
  assert.deepEqual(displays, [[group, grown]]);
  await act(async () => { view.root.findByType(Image).props.onError('decode'); });
  assert.deepEqual(failures, [[group, grown, 'decode']]);
  await act(async () => { view.unmount(); });
});

test('storage namespace preserves legacy single-key and equivalent singleton-set configurations', () => {
  const legacy = { manifestUrl: 'https://delivery.test/manifest', orgId: 'org', appId: 'app', environment: 'production', pinnedPublicKey: 'first' };
  assert.equal(namespace(legacy), '7363dc89776f6a9ba092184860871bce');
  assert.equal(namespace({ ...legacy, pinnedPublicKeys: ['first'] }), namespace(legacy));
  assert.equal(namespace({ ...legacy, pinnedPublicKey: undefined, pinnedPublicKeys: ['first'] }), namespace(legacy));
});

test('native replay state survives rotation within a pinned set and is isolated from other trust sets', async () => {
  harness(); globalThis.__assetlibAdapter.allowFiles = true;
  const common = { manifestUrl: 'https://delivery.test/manifest', orgId: 'org', appId: 'app', environment: 'production' };
  const original = native.createPlatformStorage({ ...common, pinnedPublicKey: 'first', pinnedPublicKeys: ['second', 'first'] });
  const state = JSON.stringify({ highestSequence: 7, history: [{ payload: 'verified-manifest' }] });
  await original.saveState(state);
  for (const signingConfig of [
    { pinnedPublicKey: 'second', pinnedPublicKeys: ['first', 'second'] },
    { pinnedPublicKeys: ['second', 'first'] },
    { pinnedPublicKeys: ['first', 'second', 'first'] },
  ]) {
    const rotated = native.createPlatformStorage({ ...common, ...signingConfig });
    assert.equal(await rotated.loadState(), state);
    await assert.rejects(rotated.saveState(JSON.stringify({ highestSequence: 6, history: [{ payload: 'older' }] })), /newer or conflicting sequence/);
  }
  for (const signingConfig of [
    { pinnedPublicKey: 'first' },
    { pinnedPublicKeys: ['first', 'third'] },
    { pinnedPublicKeys: ['third', 'fourth'] },
  ]) {
    const other = native.createPlatformStorage({ ...common, ...signingConfig });
    assert.equal(await other.loadState(), null);
  }
});

test('native install metadata persists across clients and environments outside the image cache', async () => {
  harness(); globalThis.__assetlibAdapter.allowFiles = true;
  const first = native.createPlatformStorage({ ...config, environment: 'staging' });
  const second = native.createPlatformStorage({ ...config, environment: 'production', pinnedPublicKey: 'rotated' });
  let generated = 0;
  const createId = () => { generated++; return 'a'.repeat(32); };
  const key = 'https://delivery.test/org/app';
  assert.deepEqual(await Promise.all([first.getOrCreateInstallId(key, createId), second.getOrCreateInstallId(key, createId)]), ['a'.repeat(32), 'a'.repeat(32)]);
  assert.equal(generated, 1);
  assert.equal(await second.getOrCreateInstallId(key + '-other', () => 'b'.repeat(32)), 'b'.repeat(32));
  assert.equal(globalThis.__assetlibAdapter.fileData.size, 2);
  assert.ok([...globalThis.__assetlibAdapter.fileData.keys()].every(name => name.includes('assetlib-installs-v1') && name.endsWith('.id')));
  globalThis.__assetlibAdapter.fileData.clear();
  assert.equal(await first.getOrCreateInstallId(key, () => 'c'.repeat(32)), 'c'.repeat(32));
});

test('web install IDs use a separate transactional metadata database and persist by app key', async () => {
  harness();
  const databases = new Map(), names = [];
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = { open(name) {
    names.push(name);
    const request = {};
    queueMicrotask(() => {
      const fresh = !databases.has(name);
      if (fresh) databases.set(name, new Map());
      const entries = databases.get(name);
      request.result = {
        createObjectStore() {}, close() {},
        transaction(storeName, mode) {
          assert.equal(storeName, 'meta'); assert.equal(mode, 'readwrite');
          const tx = { objectStore: () => ({
            get(key) {
              const get = {};
              queueMicrotask(() => { get.result = entries.get(key); get.onsuccess(); queueMicrotask(() => tx.oncomplete()); });
              return get;
            },
            put(value, key) { entries.set(key, value); },
          }), abort() { tx.onabort(); } };
          return tx;
        },
      };
      if (fresh) request.onupgradeneeded();
      request.onsuccess();
    });
    return request;
  } };
  try {
    const first = web.createPlatformStorage({ ...config, environment: 'staging' });
    const second = web.createPlatformStorage({ ...config, environment: 'production' });
    const key = 'https://delivery.test/org/app';
    assert.equal(await first.getOrCreateInstallId(key, () => 'a'.repeat(32)), 'a'.repeat(32));
    assert.equal(await second.getOrCreateInstallId(key, () => { throw new Error('must reuse'); }), 'a'.repeat(32));
    assert.equal(await second.getOrCreateInstallId(key + '-other', () => 'b'.repeat(32)), 'b'.repeat(32));
    assert.deepEqual([...new Set(names)], ['assetlib-installs-v1']);
    assert.equal(databases.get('assetlib-installs-v1').size, 2);
  } finally { globalThis.indexedDB = previous; }
});

test('native install IDs use the Expo secure random UUID bridge when Web Crypto is absent', async () => {
  harness(); globalThis.__assetlibAdapter.allowFiles = true;
  const previous = globalThis.expo;
  let generated = 0;
  globalThis.expo = { uuidv4() { generated++; return '8b5c139c-a9bd-4cee-9a93-5bd5f225492a'; } };
  try {
    const storage = native.createPlatformStorage(config);
    const withoutWebCrypto = () => { throw new Error('crypto.getRandomValues must be defined'); };
    assert.equal(await storage.getOrCreateInstallId('native-app', withoutWebCrypto), '8b5c139ca9bd4cee9a935bd5f225492a');
    assert.equal(await native.createPlatformStorage(config).getOrCreateInstallId('native-app', withoutWebCrypto), '8b5c139ca9bd4cee9a935bd5f225492a');
    assert.equal(generated, 1);
    globalThis.expo = undefined;
    await assert.rejects(storage.getOrCreateInstallId('other-native-app', withoutWebCrypto), /Secure install ID generation is unavailable/);
  } finally { globalThis.expo = previous; }
});

for (const [component, method, componentProps, finish] of [
  ['AssetlibImage', 'resolve', { asset: { key: 'travel.coast', width: 120, height: 120 }, fallback: 1 }, result => result],
  ['AssetlibDynamicImage', 'resolveAsset', { asset: { kind: 'dynamic', assetId: 'coast', sequence: 7 }, fallback: 1 }, result => result],
  ['AssetlibStateImage', 'resolveStateSet', { asset: group, state: 'sprout', fallbacks }, result => ({ ...result, states: { sprout: result, grown: resolved('c') } })],
]) {
  test(`${component} isolates queued native events dispatched through the renderer's current props`, async () => {
    harness();
    const pending = deferred(), displays = [], failures = [];
    const client = { config, [method]: () => pending.promise, reportDisplay: (...args) => displays.push(args), reportFallback: (...args) => failures.push(args) };
    const props = { ...componentProps, client };
    let view;
    await act(async () => { view = create(React.createElement(adapter[component], props)); });
    const bundleInstance = view.root.findByType(Image).instance;
    await act(async () => { pending.resolve(finish(resolved('a'))); });
    const verifiedInstance = view.root.findByType(Image).instance;
    assert.notEqual(bundleInstance, verifiedInstance, 'a native renderer with queued bundle events is replaced');
    await act(async () => {
      bundleInstance.onLoad({ source: { url: 'bundle.png' } });
      bundleInstance.onError({ error: 'late bundle error' });
      verifiedInstance.onLoad({ source: { url: 'previous-image.png' } });
    });
    assert.deepEqual(displays, []); assert.deepEqual(failures, []);
    assert.deepEqual(view.root.findByType(Image).props.source, { uri: 'verified:a' });
    if (component === 'AssetlibStateImage') {
      await act(async () => { view.update(React.createElement(adapter[component], { ...props, state: 'grown' })); });
      assert.notEqual(view.root.findByType(Image).instance, verifiedInstance, 'state transitions isolate native error events without source data');
      await act(async () => { verifiedInstance.onLoad({ source: { url: 'verified:a' } }); verifiedInstance.onError({ error: 'old state' }); });
      assert.deepEqual(displays, []); assert.deepEqual(failures, []);
      assert.deepEqual(view.root.findByType(Image).props.source, { uri: 'verified:c' });
    }
    const currentInstance = view.root.findByType(Image).instance;
    await act(async () => { currentInstance.onLoad({ source: { url: currentInstance.props.source.uri } }); });
    assert.equal(displays.length, 1);
    await act(async () => { view.unmount(); });
    await act(async () => { currentInstance.onError({ error: 'unmounted' }); currentInstance.onLoad({ source: { url: currentInstance.props.source.uri } }); });
    assert.equal(displays.length, 1); assert.deepEqual(failures, []);
  });
}
