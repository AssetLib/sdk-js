import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import React from 'react';
import { create, act } from 'react-test-renderer';

// Runs the real AssetlibVideo source. Only expo-video, React Native, the poster image
// component and the platform clip URI are replaced; no device or browser is involved.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(path.join(root, 'test/.video-'));
after(async () => { delete globalThis.__assetlibVideo; await rm(temporary, { recursive: true, force: true }); });
const source = (await readFile(path.join(root, 'src/video.tsx'), 'utf8'))
  .replaceAll("'react-native'", "'./react-native.mjs'").replaceAll("'expo-video'", "'./expo-video.mjs'")
  .replaceAll("'./index'", "'./index.mjs'").replaceAll("'./platform'", "'./platform.mjs'");
await writeFile(path.join(temporary, 'video.mjs'), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText);
await writeFile(path.join(temporary, 'react-native.mjs'), `
import React from 'react';
const env = () => globalThis.__assetlibVideo;
export const AccessibilityInfo = {
  isReduceMotionEnabled: () => env().reduceMotionQuery(),
  addEventListener: (event, listener) => { env().motionListeners.add(listener); return { remove() { env().motionListeners.delete(listener); } }; },
};
export const AppState = {
  get currentState() { return env().appState; },
  addEventListener: (event, listener) => { env().appListeners.add(listener); return { remove() { env().appListeners.delete(listener); } }; },
};
export const StyleSheet = { absoluteFill: { position: 'absolute' } };
export const View = props => React.createElement('View', props);
`);
await writeFile(path.join(temporary, 'expo-video.mjs'), `
import React, { forwardRef, useImperativeHandle, useMemo } from 'react';
const env = () => globalThis.__assetlibVideo;
export function useVideoPlayer(source, setup) {
  return useMemo(() => {
    const listeners = new Set();
    const player = { source, status: 'idle', plays: 0, loop: false, muted: false, keepScreenOnWhilePlaying: true,
      play() { player.plays++; },
      addListener(event, listener) { assert(event === 'statusChange'); listeners.add(listener); return { remove: () => listeners.delete(listener) }; },
      emitStatus(status) { player.status = status; for (const listener of listeners) listener({ status }); } };
    const assert = condition => { if (!condition) throw new Error('Unexpected player event'); };
    setup?.(player);
    env().players.push(player);
    return player;
  }, [source]);
}
export const VideoView = forwardRef(function VideoView(props, ref) {
  // The web VideoView exposes its <video> element; the native one does not.
  useImperativeHandle(ref, () => env().web ? { nativeRef: { current: { play: () => env().webPlay(props.player) } } } : {}, [props.player]);
  return React.createElement('VideoView', props);
});
`);
await writeFile(path.join(temporary, 'index.mjs'), `import React from 'react';\nexport const AssetlibImage = props => React.createElement('AssetlibImage', props);\n`);
await writeFile(path.join(temporary, 'platform.mjs'), `export const videoUri = (...args) => globalThis.__assetlibVideo.videoUri(...args);\n`);
const { AssetlibVideo } = await import(pathToFileURL(path.join(temporary, 'video.mjs')));

const verified = (asset = 'a') => ({ source: 'remote', sequence: 4, message: 'verified', sha256: asset.repeat(64), assetId: asset, mime: 'video/mp4', width: 320, height: 240, durationMs: 2000, frameRate: 30, uri: `file:///clips/${asset}.mp4` });
function harness({ reduceMotion = false, appState = 'active', web = false } = {}) {
  const env = { motionListeners: new Set(), appListeners: new Set(), players: [], resolves: [], released: [], appState, web,
    reduceMotionQuery: async () => reduceMotion,
    webPlay: async () => {},
    resolveVideo: async asset => verified(asset.key),
    videoUri: async (_config, result) => ({ uri: result.uri, release() { env.released.push(result.assetId); } }) };
  globalThis.__assetlibVideo = env;
  const client = { config: {}, resolveVideo: (asset, options) => { env.resolves.push({ key: asset.key, options }); return env.resolveVideo(asset, options); } };
  return { env, client };
}
const asset = key => ({ key, width: 400, height: 300 });
const flush = () => act(async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); });
const videos = renderer => renderer.root.findAll(node => node.type === 'VideoView');
const posters = renderer => renderer.root.findAll(node => node.type === 'AssetlibImage');
const posterOpacity = (renderer, index = 0) => posters(renderer)[index].props.style[1].opacity;
const emit = (listeners, value) => act(() => { for (const listener of [...listeners]) listener(value); });
const view = (client, key, props = {}) => React.createElement(AssetlibVideo, { key, client, asset: asset(key), fallback: 1, style: { width: 200, height: 150 }, ...props });

test('reduced motion shows the poster without resolving; allowed motion plays a muted looping clip with no controls', async () => {
  const { env, client } = harness({ reduceMotion: true });
  let renderer;
  await act(async () => { renderer = create(view(client, 'a', { cachePolicy: 'disk', contentFit: 'contain', accessibilityLabel: 'Gold card' })); });
  await flush();
  assert.equal(env.resolves.length, 0);
  assert.equal(videos(renderer).length, 0);
  assert.equal(posterOpacity(renderer), 1);
  // The poster is the AssetlibImage with the caller's props, filling the sized container.
  const poster = posters(renderer)[0];
  assert.equal(poster.props.accessibilityLabel, 'Gold card'); assert.equal(poster.props.fallback, 1); assert.equal(poster.props.paused, undefined);
  assert.deepEqual(renderer.root.findByType('View').props.style[1], { width: 200, height: 150 });
  await emit(env.motionListeners, false); await flush();
  assert.deepEqual(env.resolves.map(item => [item.key, item.options.cachePolicy, item.options.signal instanceof AbortSignal]), [['a', 'disk', true]]);
  const [clip] = videos(renderer);
  assert.equal(clip.props.nativeControls, false); assert.equal(clip.props.contentFit, 'contain'); assert.equal(clip.props.allowsPictureInPicture, false);
  // On web expo-video styles the <video> element, which keeps its intrinsic size under absolute positioning alone.
  assert.deepEqual(clip.props.style, [{ position: 'absolute' }, { width: '100%', height: '100%' }], 'the clip fills the placement like the poster');
  const player = env.players[0];
  assert.deepEqual({ source: player.source, loop: player.loop, muted: player.muted, keepScreenOn: player.keepScreenOnWhilePlaying, plays: player.plays }, { source: 'file:///clips/a.mp4', loop: true, muted: true, keepScreenOn: false, plays: 1 });
  assert.equal(posterOpacity(renderer), 1, 'the poster stays until the first frame renders');
  await act(() => clip.props.onFirstFrameRender());
  assert.equal(posterOpacity(renderer), 0);
  await emit(env.motionListeners, true); await flush();
  assert.equal(videos(renderer).length, 0); assert.equal(posterOpacity(renderer), 1);
  await emit(env.motionListeners, false); await flush();
  assert.equal(videos(renderer).length, 1); assert.equal(posterOpacity(renderer), 1, 'a remounted clip waits for its first frame again');
  assert.equal(env.resolves.length, 1, 'the resolved clip is kept while mounted');
  await act(() => renderer.unmount());
  assert.deepEqual(env.released, ['a'], 'unmounting releases the clip URI (a Blob URL on web)');
});

test('on web a started play() hides the poster without onFirstFrameRender, which Safari never sends', async () => {
  const { env, client } = harness({ web: true });
  const started = [];
  env.webPlay = () => new Promise(resolve => started.push(resolve));
  let renderer;
  await act(async () => { renderer = create(view(client, 'a')); });
  await flush();
  assert.equal(videos(renderer).length, 1); assert.equal(started.length, 1);
  assert.equal(posterOpacity(renderer), 1, 'the poster stays until playback starts');
  await act(async () => started[0]()); await flush();
  assert.equal(posterOpacity(renderer), 0);
  // A play() that starts after its clip unmounted must not hide the next clip's poster early.
  await emit(env.motionListeners, true); await flush();
  await emit(env.motionListeners, false); await flush();
  assert.equal(started.length, 2);
  await emit(env.motionListeners, true); await flush();
  await act(async () => started[1]()); await flush();
  await emit(env.motionListeners, false); await flush();
  assert.equal(videos(renderer).length, 1); assert.equal(posterOpacity(renderer), 1);
  await act(async () => started[2]()); await flush();
  assert.equal(posterOpacity(renderer), 0);
  await act(() => renderer.unmount());
});

test('an unknown or failing reduced-motion query keeps the poster', async () => {
  for (const reduceMotionQuery of [() => new Promise(() => {}), async () => { throw new Error('unavailable'); }]) {
    const { env, client } = harness();
    env.reduceMotionQuery = reduceMotionQuery;
    let renderer;
    await act(async () => { renderer = create(view(client, 'a')); });
    await flush();
    assert.equal(env.resolves.length, 0); assert.equal(videos(renderer).length, 0);
    await act(() => renderer.unmount());
  }
});

test('at most two clips play at once, and a freed slot goes to a waiting view', async () => {
  const { env, client } = harness();
  const tree = keys => React.createElement(React.Fragment, null, ...keys.map(key => view(client, key, typeof key === 'object' ? key : {})));
  let renderer;
  await act(async () => { renderer = create(tree(['a', 'b', 'c'])); });
  await flush();
  assert.equal(videos(renderer).length, 2);
  assert.deepEqual(env.resolves.map(item => item.key), ['a', 'b'], 'a waiting view does not download its clip yet');
  assert.equal(posters(renderer).length, 3);
  await act(() => renderer.update(tree(['b', 'c']))); await flush();
  assert.deepEqual(videos(renderer).map(node => node.props.player.source), ['file:///clips/b.mp4', 'file:///clips/c.mp4']);
  await act(() => renderer.update(React.createElement(React.Fragment, null, view(client, 'b', { paused: true }), view(client, 'c'), view(client, 'd')))); await flush();
  assert.deepEqual(videos(renderer).map(node => node.props.player.source), ['file:///clips/c.mp4', 'file:///clips/d.mp4'], 'a paused view frees its slot');
  await act(() => renderer.unmount());
  await act(async () => { renderer = create(tree(['e', 'f'])); }); await flush();
  assert.equal(videos(renderer).length, 2, 'unmounting returns every slot');
  await act(() => renderer.unmount());
});

test('backgrounding stops playback; returning to the foreground plays the retained clip again', async () => {
  const { env, client } = harness();
  let renderer;
  await act(async () => { renderer = create(view(client, 'a')); });
  await flush();
  assert.equal(videos(renderer).length, 1);
  for (const state of ['background', 'inactive']) {
    await emit(env.appListeners, state); await flush();
    assert.equal(videos(renderer).length, 0, state); assert.equal(posterOpacity(renderer), 1);
    await emit(env.appListeners, 'active'); await flush();
    assert.equal(videos(renderer).length, 1);
  }
  assert.equal(env.resolves.length, 1);
  await act(() => renderer.unmount());
  const started = harness({ appState: 'background' });
  await act(async () => { renderer = create(view(started.client, 'a')); }); await flush();
  assert.equal(started.env.resolves.length, 0, 'a view mounted in the background waits');
  await act(() => renderer.unmount());
});

test('a missing clip, a player error, a rejected web play() or an unusable clip URI shows the poster', async () => {
  const cases = {
    missing: env => { env.resolveVideo = async () => ({ source: 'poster', sequence: null, message: 'none' }); },
    'player error': () => {},
    'rejected web play': env => { env.web = true; env.webPlay = async () => { throw new DOMException('blocked', 'NotAllowedError'); }; },
    'clip URI': env => { env.videoUri = async () => { throw new Error('not a file'); }; },
    'resolution error': env => { env.resolveVideo = async () => { throw new Error('offline'); }; },
  };
  for (const [name, setup] of Object.entries(cases)) {
    const { env, client } = harness();
    setup(env);
    let renderer;
    await act(async () => { renderer = create(view(client, 'a')); });
    await flush();
    if (name === 'player error') { assert.equal(videos(renderer).length, 1); await act(() => env.players[0].emitStatus('error')); await flush(); }
    assert.equal(videos(renderer).length, 0, name); assert.equal(posterOpacity(renderer), 1, name);
    assert.equal(env.resolves.length, 1, `${name}: no retry for the same request`);
    if (name === 'rejected web play') assert.equal(env.players[0].plays, 0, 'web plays through the <video> element so the rejection is seen');
    if (name === 'player error' || name === 'rejected web play') assert.deepEqual(env.released, ['a'], `${name}: the clip URI is released`);
    // A new revision is a new request and tries again.
    await act(() => renderer.update(view(client, 'a', { revision: 1 }))); await flush();
    assert.equal(env.resolves.length, 2, name);
    await act(() => renderer.unmount());
  }
  // A failed view frees its slot for the next one.
  const { env, client } = harness();
  env.resolveVideo = async item => item.key === 'a' ? { source: 'poster', sequence: null, message: 'none' } : verified(item.key);
  let renderer;
  await act(async () => { renderer = create(React.createElement(React.Fragment, null, view(client, 'a'), view(client, 'b'), view(client, 'c'))); }); await flush();
  assert.deepEqual(videos(renderer).map(node => node.props.player.source), ['file:///clips/b.mp4', 'file:///clips/c.mp4']);
  await act(() => renderer.unmount());
});

test('changing the asset aborts a pending resolution and releases the previous clip', async () => {
  const { env, client } = harness();
  const pending = [];
  env.resolveVideo = (item, options) => new Promise(resolve => pending.push({ item, options, resolve }));
  let renderer;
  await act(async () => { renderer = create(view(client, 'a')); }); await flush();
  await act(() => renderer.update(React.createElement(AssetlibVideo, { key: 'a', client, asset: asset('b'), fallback: 1 }))); await flush();
  assert.equal(pending[0].options.signal.aborted, true);
  await act(async () => pending[0].resolve(verified('a'))); await flush();
  assert.equal(videos(renderer).length, 0, 'a stale result is ignored');
  await act(async () => pending[1].resolve(verified('b'))); await flush();
  assert.deepEqual(videos(renderer).map(node => node.props.player.source), ['file:///clips/b.mp4']);
  await act(() => renderer.update(React.createElement(AssetlibVideo, { key: 'a', client, asset: asset('c'), fallback: 1 }))); await flush();
  assert.deepEqual(env.released, ['b']);
  await act(() => renderer.unmount());
});

test('the main entry never imports expo-video; only the video entry does', async () => {
  const seen = new Set(), external = new Set();
  const visit = async file => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = await readFile(file, 'utf8');
    for (const [, specifier] of text.matchAll(/from\s+'([^']+)'/g)) {
      if (!specifier.startsWith('.')) { external.add(specifier); continue; }
      const base = path.resolve(path.dirname(file), specifier);
      for (const candidate of ['.ts', '.tsx', '.native.ts', '.web.ts'].map(extension => base + extension)) if (existsSync(candidate)) await visit(candidate);
    }
  };
  await visit(path.join(root, 'src/index.tsx'));
  assert.ok(seen.has(path.join(root, 'src/platform.native.ts')) && seen.has(path.join(root, 'src/platform.web.ts')));
  assert.equal([...external].some(name => name.startsWith('expo-video')), false);
  assert.equal(seen.has(path.join(root, 'src/video.tsx')), false);
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.exports, { '.': './src/index.tsx', './video': './src/video.tsx' });
  assert.deepEqual(manifest.peerDependenciesMeta, { 'expo-video': { optional: true } });
  assert.equal(manifest.dependencies['expo-video'], undefined);
});
