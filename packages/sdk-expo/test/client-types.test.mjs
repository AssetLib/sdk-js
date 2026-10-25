import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('Expo client accepts the configurable decision timeout through its public TypeScript API', async t => {
  const temporary = await mkdtemp(fileURLToPath(new URL('./.client-types-', import.meta.url)));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'client.ts');
  await writeFile(source, `import { createExpoAssetClient, type AssetlibConfig } from '@assetlib/sdk-expo';
declare const config: AssetlibConfig;
createExpoAssetClient(config, { decisionTimeoutMs: 100, decide: () => 'control' });
createExpoAssetClient(config, { decisionTimeoutMs: 10_000 });
`);
  const program = ts.createProgram([source], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, jsx: ts.JsxEmit.ReactJSX, skipLibCheck: true, allowImportingTsExtensions: true, noEmit: true,
  });
  assert.ok(program.getSourceFiles().some(file => file.fileName.endsWith('/sdk-expo/src/index.tsx')), 'typecheck must load the actual Expo adapter');
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});

test('a template reference requires tintColor in TypeScript; other references do not', async t => {
  const temporary = await mkdtemp(fileURLToPath(new URL('./.client-types-', import.meta.url)));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'tint.tsx');
  await writeFile(source, `import { AssetlibImage, AssetlibPlacement, AssetlibStateImage, type AssetClient, type AssetRef, type StateSetRef } from '@assetlib/sdk-expo';
declare const client: AssetClient;
declare const widened: AssetRef;
declare const widenedStates: StateSetRef;
const AppAssets = {
  Tabs: { trips: { key: 'tab.trips', width: 24, height: 24, rendering: 'template' }, saved: { key: 'tab.saved', width: 24, height: 24, rendering: 'template', states: ['idle', 'active'] } },
  Travel: { coast: { key: 'travel.coast', width: 1200, height: 900 }, garden: { key: 'travel.garden', width: 600, height: 400, states: ['empty', 'grown'] } },
} as const;
export const views = [
  <AssetlibImage client={client} asset={AppAssets.Tabs.trips} fallback={1} tintColor="#1f1f1f" style={{ width: 24, height: 24 }} />,
  <AssetlibImage client={client} asset={AppAssets.Travel.coast} fallback={1} />,
  <AssetlibImage client={client} asset={widened} fallback={1} />,
  <AssetlibStateImage client={client} asset={AppAssets.Tabs.saved} state="idle" fallbacks={{ idle: 1, active: 2 }} tintColor="#1f1f1f" />,
  <AssetlibStateImage client={client} asset={AppAssets.Travel.garden} state="empty" fallbacks={{ empty: 1, grown: 2 }} />,
  <AssetlibStateImage client={client} asset={widenedStates} state="empty" fallbacks={{ empty: 1, grown: 2 }} />,
  // The callbacks a placement hands out fit an expo-image Image, whatever component the app renders.
  <AssetlibPlacement client={client} asset={AppAssets.Tabs.trips} fallback={1} tintColor="#1f1f1f" contentFit="contain">{placement => <AssetlibImage client={client} asset={AppAssets.Travel.coast} fallback={placement.source} tintColor={placement.tintColor} onLoad={placement.onLoad} onError={placement.onError} onLayout={placement.onLayout} {...placement.accessibility} />}</AssetlibPlacement>,
  <AssetlibPlacement client={client} asset={AppAssets.Travel.coast} fallback={1}>{() => null}</AssetlibPlacement>,
  // @ts-expect-error A template placement needs the app's tint color.
  <AssetlibPlacement client={client} asset={AppAssets.Tabs.trips} fallback={1}>{() => null}</AssetlibPlacement>,
  // @ts-expect-error A template reference needs the app's tint color.
  <AssetlibImage client={client} asset={AppAssets.Tabs.trips} fallback={1} />,
  // @ts-expect-error A template state set needs the app's tint color.
  <AssetlibStateImage client={client} asset={AppAssets.Tabs.saved} state="idle" fallbacks={{ idle: 1, active: 2 }} />,
];
`);
  const program = ts.createProgram([source], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, jsx: ts.JsxEmit.ReactJSX, skipLibCheck: true, allowImportingTsExtensions: true, noEmit: true,
  });
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});

test('the video entry types AssetlibVideo, and the main entry never loads expo-video', async t => {
  const temporary = await mkdtemp(fileURLToPath(new URL('./.client-types-', import.meta.url)));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const options = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, jsx: ts.JsxEmit.ReactJSX, skipLibCheck: true, allowImportingTsExtensions: true, noEmit: true,
  };
  const main = path.join(temporary, 'main.ts');
  await writeFile(main, `import { createExpoAssetClient, type AssetlibConfig, type ResolvedVideo } from '@assetlib/sdk-expo';
declare const config: AssetlibConfig;
const client = createExpoAssetClient(config, { videoTimeoutMs: 30_000 });
export const clip: Promise<ResolvedVideo> = client.resolveVideo({ key: 'cards.gold', width: 400, height: 300 }, { cachePolicy: 'disk' });
`);
  const mainProgram = ts.createProgram([main], options);
  assert.deepEqual(ts.getPreEmitDiagnostics(mainProgram).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
  assert.deepEqual(mainProgram.getSourceFiles().map(file => file.fileName).filter(name => name.includes('/expo-video/') || name.endsWith('/sdk-expo/src/video.tsx')), []);
  const video = path.join(temporary, 'video.tsx');
  await writeFile(video, `import { AssetlibVideo, type AssetlibVideoProps } from '@assetlib/sdk-expo/video';
import type { AssetClient } from '@assetlib/sdk-expo';
declare const client: AssetClient;
const Cards = { gold: { key: 'cards.gold', width: 400, height: 300 } } as const;
export const props: AssetlibVideoProps = { client, asset: Cards.gold, fallback: 1 };
export const views = [
  <AssetlibVideo client={client} asset={Cards.gold} fallback={1} contentFit="cover" style={{ width: 200, height: 150 }} />,
  <AssetlibVideo client={client} asset={Cards.gold} fallback={1} paused revision={2} cachePolicy="disk" accessibilityMode="description" onStatus={status => status.source} />,
  // @ts-expect-error The poster needs a bundled fallback.
  <AssetlibVideo client={client} asset={Cards.gold} />,
  // @ts-expect-error paused is a boolean.
  <AssetlibVideo client={client} asset={Cards.gold} fallback={1} paused="yes" />,
];
`);
  const videoProgram = ts.createProgram([video], options);
  assert.ok(videoProgram.getSourceFiles().some(file => file.fileName.endsWith('/sdk-expo/src/video.tsx')), 'the subpath export resolves to the video entry');
  assert.ok(videoProgram.getSourceFiles().some(file => file.fileName.includes('/expo-video/')), 'the video entry is typed against expo-video');
  assert.deepEqual(ts.getPreEmitDiagnostics(videoProgram).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});
