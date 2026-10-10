import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanReferences } from '../src/references.mjs';

const catalog = { schemaVersion: 1, placements: [
  { key: 'travel.coast', symbol: ['Travel', 'coast'], width: 1200, height: 900 },
  { key: 'tasks.garden', symbol: ['Tasks', 'garden'], width: 600, height: 400 },
] };
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'assetlib-cli-references-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root, file, contents) {
  const destination = path.join(root, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, contents);
  return destination;
}
function scan(root, references = [root], options = {}) {
  return scanReferences({ catalog, references, catalogPath: path.join(root, 'catalog.json'), ...options });
}

test('finds literal keys and prefixed symbols while excluding dynamic and generated references', async t => {
  const root = await fixture(t);
  await put(root, 'src/Screen.tsx', [
    'const first = "travel.coast";',
    'const second = AppAssets.Travel.coast;',
    'const third = AssetCatalog.Tasks.garden;',
    'const fourth = artwork.Travel.coast;',
    "const dynamic = 'travel.' + kind;",
    'const computed = AppAssets.Travel[kind];',
    'const template = `travel.${kind}`;',
    'const unrelated = OtherAppAssets.Travel.coast;',
    'const suffix = AppAssets.Travel.coastExtra;',
    'const repeated = ["travel.coast", "travel.coast", artwork.Travel.coast];',
    'const privateContent = "DO_NOT_SEND_SOURCE";',
  ].join('\n'));
  for (const file of ['assets.generated.ts', 'Artwork.generated.swift', 'AppAssets.kt', 'src/custom.generated.jsx']) {
    await put(root, file, '"tasks.garden"');
  }
  const result = await scan(root);
  assert.deepEqual(result, { codeReferences: [
    { key: 'travel.coast', path: 'src/Screen.tsx', line: 1 },
    { key: 'travel.coast', path: 'src/Screen.tsx', line: 2 },
    { key: 'tasks.garden', path: 'src/Screen.tsx', line: 3 },
    { key: 'travel.coast', path: 'src/Screen.tsx', line: 4 },
    { key: 'travel.coast', path: 'src/Screen.tsx', line: 10 },
  ], partial: false, issues: [] });
  assert.equal(JSON.stringify(result).includes('DO_NOT_SEND_SOURCE'), false);
});

test('finds Swift AppArtwork accessors and artwork methods, and Kotlin AppAssets symbols', async t => {
  const root = await fixture(t);
  await put(root, 'ios/ElsewhereApp.swift', [
    'let hero = session.artwork.travel.coast',
    'let described = artwork.travel.coastArtwork(locale: locale, requireDescription: true)',
    'let row = session.artwork.tasks.garden.resizable()',
    'let longer = artwork.travel.coastline',
    'let suffixed = artwork.travel.coastArtworks',
    'let upperMethod = artwork.Travel.coastArtwork(locale: locale)',
    'let lowerCatalog = AssetCatalog.travel.coast',
    'let lowerAssets = AppAssets.travel.coast',
    'let other = myartwork.travel.coast',
  ].join('\n'));
  await put(root, 'android/TravelModel.kt', 'val coast = image(AppAssets.Travel.coast)');
  assert.deepEqual((await scan(root)).codeReferences, [
    { key: 'travel.coast', path: 'android/TravelModel.kt', line: 1 },
    { key: 'travel.coast', path: 'ios/ElsewhereApp.swift', line: 1 },
    { key: 'travel.coast', path: 'ios/ElsewhereApp.swift', line: 2 },
    { key: 'tasks.garden', path: 'ios/ElsewhereApp.swift', line: 3 },
  ]);
});

test('uses globally sorted POSIX paths and deduplicates overlapping references', async t => {
  const root = await fixture(t);
  for (const file of ['a/z.ts', 'a.ts', 'a!next.ts', 'Z.swift', 'last.kt']) await put(root, file, '"travel.coast"');
  const result = await scan(root, [path.join(root, 'last.kt'), path.join(root, 'a'), root, path.join(root, 'a.ts'), root]);
  assert.deepEqual(result.codeReferences.map(reference => reference.path), ['Z.swift', 'a!next.ts', 'a.ts', 'a/z.ts', 'last.kt']);
  assert.equal(result.partial, false);
});

test('skips audit exclusions, unsupported extensions, and symlinks without following them', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  for (const directory of ['node_modules', 'vendor', 'Pods', 'Carthage', 'build', 'Build', 'dist', 'out', 'coverage', 'DerivedData', 'target', 'graft', '.git', '.private']) {
    await put(root, `${directory}/hidden.ts`, '"travel.coast"');
  }
  await put(root, '.hidden.ts', '"travel.coast"');
  await put(root, 'unsupported.txt', '"travel.coast"');
  const secret = await put(outside, 'secret.ts', '"travel.coast"');
  await symlink(secret, path.join(root, 'linked.ts'));
  await symlink(outside, path.join(root, 'linked-directory'));
  await put(root, 'visible.swift', '"tasks.garden"');
  assert.deepEqual((await scan(root)).codeReferences, [{ key: 'tasks.garden', path: 'visible.swift', line: 1 }]);
  await assert.rejects(scan(root, [path.join(root, 'linked-directory')]), /symlinks/);
  await assert.rejects(scan(root, [path.join(root, 'linked-directory', 'secret.ts')]), /symlinks/);
  await assert.rejects(scan(root, [path.join(root, 'node_modules')]), /excluded/);
});

test('matches excluded directory names case-insensitively without excluding similar names', async t => {
  const root = await fixture(t);
  for (const directory of ['Vendor', 'NODE_MODULES', 'pods', 'deriveddata']) await put(root, `${directory}/hidden.swift`, '"travel.coast"');
  await put(root, 'Vendored/visible.swift', '"tasks.garden"');
  assert.deepEqual((await scan(root)).codeReferences, [{ key: 'tasks.garden', path: 'Vendored/visible.swift', line: 1 }]);
  await assert.rejects(scan(root, [path.join(root, 'Vendor')]), /excluded/);
});

test('requires a common root and resolves explicit root and reference paths from cwd', async t => {
  const root = await fixture(t);
  await put(root, 'catalogs/artwork.json', JSON.stringify(catalog));
  await put(root, 'src/Screen.ts', '"travel.coast"');
  const options = { catalogPath: path.join(root, 'catalogs/artwork.json') };
  await assert.rejects(scan(root, [path.join(root, 'src')], options), /use --root/);
  const result = await scan(root, [path.relative(process.cwd(), path.join(root, 'src'))], {
    ...options, root: path.relative(process.cwd(), root),
  });
  assert.deepEqual(result.codeReferences, [{ key: 'travel.coast', path: 'src/Screen.ts', line: 1 }]);
  await assert.rejects(scan(root, [root], { ...options, root: path.join(root, 'src') }), /use --root/);
});

test('caps at 200 references in sorted path order and reports actual truncation', async t => {
  const root = await fixture(t);
  await put(root, 'z.ts', '"travel.coast"');
  await put(root, 'a.ts', Array.from({ length: 200 }, () => '"tasks.garden"').join('\n'));
  const result = await scan(root, [path.join(root, 'z.ts'), path.join(root, 'a.ts')]);
  assert.equal(result.codeReferences.length, 200);
  assert.equal(result.codeReferences.every(reference => reference.path === 'a.ts'), true);
  assert.equal(result.codeReferences.at(-1).line, 200);
  assert.equal(result.partial, true);
  assert.deepEqual(result.issues, [{ path: 'z.ts', reason: 'reference_limit' }]);
  assert.equal((await scan(root, [path.join(root, 'a.ts')])).partial, false);
});

test('enforces the audit per-file, total-byte, and source-file budgets', async t => {
  const root = await fixture(t);
  await put(root, 'oversized/large.ts', 'x'.repeat(256 * 1024 + 1));
  const oversized = await scan(root, [path.join(root, 'oversized')]);
  assert.equal(oversized.partial, true);
  assert.equal(oversized.issues[0].reason, 'source_unreadable_or_byte_limit');

  const padded = '"travel.coast";\n'.padEnd(256 * 1024, ' ');
  for (let index = 0; index < 9; index++) await put(root, `bytes/${index}.ts`, padded);
  const totalBytes = await scan(root, [path.join(root, 'bytes')]);
  assert.equal(totalBytes.codeReferences.length, 8);
  assert.deepEqual(totalBytes.issues, [{ path: 'bytes/8.ts', reason: 'source_unreadable_or_byte_limit' }]);

  await mkdir(path.join(root, 'files'));
  await Promise.all(Array.from({ length: 501 }, (_, index) => writeFile(path.join(root, 'files', `${String(index).padStart(3, '0')}.ts`), index === 500 ? '"travel.coast"' : '')));
  const fileCount = await scan(root, [path.join(root, 'files')]);
  assert.deepEqual(fileCount.codeReferences, []);
  assert.deepEqual(fileCount.issues, [{ path: 'files/500.ts', reason: 'source_file_limit' }]);
});

test('reports depth and wire-path limits instead of sending invalid paths', async t => {
  const root = await fixture(t);
  const deep = Array.from({ length: 33 }, () => 'd').join('/');
  await put(root, `${deep}/screen.ts`, '"travel.coast"');
  const long = `${'a'.repeat(150)}/${'b'.repeat(150)}/screen.ts`;
  await put(root, long, '"travel.coast"');
  const result = await scan(root);
  assert.deepEqual(result.codeReferences, []);
  assert.equal(result.partial, true);
  assert.deepEqual(new Set(result.issues.map(issue => issue.reason)), new Set(['depth_limit', 'reference_path_limit']));
});

test('stops traversal at the audit 20,000-entry budget', async t => {
  const root = await fixture(t);
  // Hidden entries count toward the traversal budget, just as in the audit.
  // Hard links make a large real-directory fixture inexpensive to create.
  const { link } = await import('node:fs/promises');
  const seed = await put(root, '.00000', '');
  for (let batch = 0; batch < 20; batch++) {
    await Promise.all(Array.from({ length: 1000 }, (_, offset) => {
      const index = batch * 1000 + offset + 1;
      return link(seed, path.join(root, `.${String(index).padStart(5, '0')}`));
    }));
  }
  await put(root, 'screen.ts', '"travel.coast"');
  const result = await scan(root);
  assert.deepEqual(result.codeReferences, []);
  assert.deepEqual(result.issues, [{ path: '.', reason: 'entry_limit' }]);
  assert.equal(result.partial, true);
});

test('never reports the catalog file itself or lockfiles as call sites', async t => {
  const root = await fixture(t);
  await put(root, 'catalog.json', JSON.stringify(catalog));
  await put(root, 'package-lock.json', '{"name":"travel.coast"}');
  await put(root, 'ios/Podfile.lock', '"tasks.garden"');
  await put(root, 'src/Screen.tsx', 'const key = "travel.coast";');
  const result = await scan(root);
  assert.deepEqual(result.codeReferences, [{ key: 'travel.coast', path: 'src/Screen.tsx', line: 1 }]);
  assert.equal(result.partial, false);
  assert.deepEqual(result.issues, []);
});
