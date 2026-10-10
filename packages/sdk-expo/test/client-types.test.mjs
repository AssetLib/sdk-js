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
  await writeFile(source, `import { AssetlibImage, AssetlibStateImage, type AssetClient, type AssetRef, type StateSetRef } from '@assetlib/sdk-expo';
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
