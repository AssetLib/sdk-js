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
