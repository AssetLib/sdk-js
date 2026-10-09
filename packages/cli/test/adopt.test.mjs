import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { main } from '../src/cli.mjs';
import { generateCatalog } from '../src/codegen.mjs';

const execute = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/assetlib.mjs', import.meta.url));
const seed = { schemaVersion: 1, placements: [{ key: 'existing.art', symbol: ['Existing', 'art'], width: 100, height: 100, screen: 'Existing' }] };
function png(width = 1200, height = 900) {
  const bytes = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(bytes);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); bytes[24] = 8; bytes[25] = 2;
  return bytes;
}
async function fixture(t, catalog = seed) {
  const root = await mkdtemp(path.join(tmpdir(), 'assetlib-adopt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(name, text) { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); return file; }
  await put('assetlib.catalog.json', JSON.stringify(catalog, null, 2) + '\n');
  await put('assets/coast-hero.png', png());
  await mkdir(path.join(root, 'src'), { recursive: true });
  const get = name => readFile(path.join(root, name), 'utf8');
  const args = ['adopt', '--catalog', path.join(root, 'assetlib.catalog.json'), '--src', path.join(root, 'src')];
  async function run(options = [], json = true) {
    let stdout = '', stderr = '';
    const code = await main([...args, ...options, ...(json ? ['--json'] : [])], {}, { stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
    return { code, stdout, stderr, ...(json ? { report: JSON.parse(stdout) } : {}) };
  }
  return { root, put, get, args, run };
}
async function snapshot(root) {
  const result = {};
  async function walk(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await walk(file);
      else if (item.isFile()) result[path.relative(root, file)] = (await readFile(file)).toString('base64');
    }
  }
  await walk(root); return result;
}
function syntax(text) { assert.deepEqual(ts.createSourceFile('file.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX).parseDiagnostics, []); }

test('dry run plans both supported patterns, every changed file, and leaves the complete tree untouched', async t => {
  const f = await fixture(t);
  const source = `"use client";\nimport { Image, View } from 'react-native';\nconst coast = require('../assets/coast-hero.png');\n// Keep this comment and formatting.\nexport const Travel = () => <View>\n  <Image source={require('../assets/coast-hero.png')} style={{ width: 90 }} accessibilityLabel="Coast" />\n  <Image testID='hero' source={coast}><View /></Image>\n</View>;\n`;
  await f.put('src/TravelScreen.tsx', source);
  const before = await snapshot(f.root), result = await f.run();
  assert.equal(result.code, 0, result.stdout); assert.equal(result.stderr, '');
  assert.equal(result.report.summary.candidates, 2);
  assert.equal(result.report.summary.placementsAdded, 1);
  assert.deepEqual(result.report.files.map(item => item.path), ['assetlib.catalog.json', 'src/TravelScreen.tsx', 'src/assetlib/client.ts', 'src/assets.generated.ts']);
  for (const file of result.report.files) { assert.match(file.diff, /^--- /); assert.match(file.diff, /\n\+\+\+ b\//); assert.match(file.diff, /\n@@ -\d+,\d+ \+\d+,\d+ @@\n/); }
  assert.match(result.report.files.find(item => item.path === 'src/TravelScreen.tsx').diff, /fallback=\{coast\}/);
  assert.match(result.report.files.find(item => item.path === 'src/assetlib/client.ts').diff, /assetlib.public.json/);
  assert.match(result.report.notes.join('\n'), /@2x\/@3x/);
  assert.deepEqual(await snapshot(f.root), before);
  const human = await f.run([], false);
  assert.match(human.stdout, /Assetlib adopt dry run\n2 candidates/);
  for (const file of result.report.files) assert.ok(human.stdout.includes('+++ b/' + file.path));
});

test('apply preserves attributes, declarations, imports and directives, regenerates catalog, creates a usable stub, then is idempotent', async t => {
  const f = await fixture(t);
  await f.put('src/TravelScreen.tsx', `'use client';\nimport { Image } from 'expo-image';\nconst coast = require('../assets/coast-hero.png');\nexport const Screen = () => <Image\n  source={coast}\n  contentFit="cover" style={{ flex: 1 }}\n  accessibilityLabel='Coast'\n></Image>;\n`);
  await f.put('src/assets.generated.ts', '// stale output\n');
  const result = await f.run(['--apply']);
  assert.equal(result.code, 0, result.stdout); assert.equal(result.report.mode, 'apply');
  const source = await f.get('src/TravelScreen.tsx');
  assert.ok(source.startsWith("'use client';\nimport { Image } from 'expo-image';"));
  assert.match(source, /const coast = require\('\.\.\/assets\/coast-hero.png'\);/);
  assert.match(source, /<AssetlibImage\n  client=\{client\} asset=\{AppAssets.Travel.coastHero\} fallback=\{coast\}/);
  assert.match(source, /contentFit="cover" style=\{\{ flex: 1 \}\}\n  accessibilityLabel='Coast'\n><\/AssetlibImage>/);
  assert.match(source, /import \{ AppAssets \} from "\.\/assets.generated";/);
  assert.match(source, /import \{ client \} from "\.\/assetlib\/client";/);
  syntax(source);
  const catalog = JSON.parse(await f.get('assetlib.catalog.json'));
  assert.deepEqual(catalog.placements[0], seed.placements[0]);
  assert.deepEqual(catalog.placements[1], { key: 'travel.coast-hero', symbol: ['Travel', 'coastHero'], width: 1200, height: 900, screen: 'travel' });
  assert.equal(await f.get('src/assets.generated.ts'), generateCatalog(catalog));
  const client = await f.get('src/assetlib/client.ts');
  assert.match(client, /import \{ createExpoAssetClient \} from '@assetlib\/sdk-expo'/);
  assert.match(client, /import \{ parsePublicConfig \} from '@assetlib\/sdk-core'/);
  assert.match(client, /require\("\.\.\/\.\.\/assetlib.public.json"\)/);
  assert.match(client, /export const client = createExpoAssetClient\(config\);/); syntax(client);
  const before = await snapshot(f.root), second = await f.run(['--apply']);
  assert.equal(second.code, 3); assert.equal(second.report.summary.candidates, 0); assert.equal(second.report.files.length, 0);
  assert.deepEqual(await snapshot(f.root), before);
});

test('reports unsupported require expressions and ambiguous constants with exact path and line', async t => {
  const f = await fixture(t);
  const lines = [
    `import { Image } from 'react-native';`,
    `const object = { hero: require('../assets/coast-hero.png') };`,
    `const array = [require('../assets/coast-hero.png')];`,
    'const template = require(`../assets/coast-hero.png`);',
    `const conditional = ok ? require('../assets/coast-hero.png') : null;`,
    `consume(require('../assets/coast-hero.png'));`,
    `const multi = require('../assets/coast-hero.png');`,
    `const first = <Image source={multi} />;`,
    `const second = <Image source={multi} />;`,
    `const dynamic = require('../assets/' + name + '.png');`,
    `const unused = require('../assets/coast-hero.png');`,
    `let mutable = require('../assets/coast-hero.png');`,
    `const third = <Image source={mutable} />;`,
    `const nested = () => { const local = require('../assets/coast-hero.png'); return <Image source={local} />; };`,
    `const fourth = <Image source={mutable} />;`,
    `const wrong = <Something source={require('../assets/coast-hero.png')} />;`,
    `const absolute = <Image source={require('/tmp/coast-hero.png')} />;`,
    `const missing = <Image source={require('../assets/missing.png')} />;`,
    `const attrs = <Image fallback={42} source={require('../assets/coast-hero.png')} />;`,
  ];
  await f.put('src/Lab.tsx', lines.join('\n'));
  const result = await f.run(); assert.equal(result.code, 3, result.stdout);
  const reasons = Object.fromEntries(result.report.skipped.map(item => [item.reason, item]));
  for (const [reason, line] of Object.entries({ 'object-property': 2, 'array-element': 3, 'template-string': 4, 'conditional-expression': 5, 'non-jsx-call': 6, 'multiple-uses': 7, 'dynamic-path': 10, 'unused-identifier': 11, 'non-module-const': 14, 'image-not-imported': 16, 'non-relative-path': 17, 'image-missing': 18, 'attribute-conflict': 19 })) {
    assert.equal(reasons[reason]?.line, line, reason); assert.equal(reasons[reason].path, 'src/Lab.tsx');
  }
  assert.equal(result.report.files.length, 0);
});

test('filters icon-sized and essential files and honors both-edge min-edge semantics and density names', async t => {
  const f = await fixture(t);
  for (const [name, width, height] of [['small.png', 63, 63], ['wide.png', 64, 12], ['app-icon.png', 1200, 900], ['splash-art.png', 1200, 900], ['adaptive-icon.png', 1200, 900], ['icons/landscape.png', 1200, 900], ['art@2x.png', 600, 400]]) await f.put('assets/' + name, png(width, height));
  await f.put('src/Lab.jsx', `import { Image } from 'expo-image';\nexport const App = () => <>${['small.png', 'wide.png', 'app-icon.png', 'splash-art.png', 'adaptive-icon.png', 'icons/landscape.png', 'art@2x.png'].map(name => `<Image source={require('../assets/${name}')} />`).join('\n')}</>;`);
  const result = await f.run(); assert.equal(result.code, 0, result.stdout);
  assert.equal(result.report.summary.candidates, 2); assert.equal(result.report.skipped.filter(item => item.reason === 'essential').length, 4);
  assert.equal(result.report.skipped.filter(item => item.reason === 'icon-sized').length, 1);
  assert.deepEqual(result.report.candidates.map(item => [item.key, item.width, item.height]), [['lab.wide', 64, 12], ['lab.art-2x', 600, 400]]);
  const larger = await f.run(['--min-edge', '100']); assert.equal(larger.report.summary.candidates, 1);
});

test('suffixes distinct image key collisions, camelCase symbol collisions, and existing namespace overlaps deterministically', async t => {
  const f = await fixture(t, { ...seed, placements: [...seed.placements, { key: 'unrelated.leaf', symbol: ['Lab', 'coastHero'], width: 10, height: 10 }] });
  await f.put('assets/other/coast-hero.png', png());
  await f.put('assets/third/coast_hero.png', png());
  await f.put('src/Lab.tsx', `import { Image } from 'react-native';\nconst App = () => <><Image source={require('../assets/coast-hero.png')} /><Image source={require('../assets/other/coast-hero.png')} /><Image source={require('../assets/third/coast_hero.png')} /></>;`);
  const result = await f.run(['--apply']); assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.report.candidates.map(item => item.key), ['lab.coast-hero-2', 'lab.coast-hero-3', 'lab.coast-hero-4']);
  assert.deepEqual(result.report.candidates.map(item => item.symbol), [['Lab', 'coastHero2'], ['Lab', 'coastHero3'], ['Lab', 'coastHero4']]);
  assert.equal(result.report.collisions.length, 3);
  assert.equal((await f.run()).code, 3);
});

test('reuses matching catalog keys and original symbols while skipping dimension conflicts', async t => {
  const original = { ...seed, placements: [...seed.placements, { key: 'lab.coast-hero', symbol: ['Custom', 'saved'], width: 1200, height: 900, screen: 'Existing label', variants: { appearance: ['dark'] } }, { key: 'lab.other', symbol: ['Lab', 'other'], width: 300, height: 200 }] };
  const f = await fixture(t, original);
  await f.put('assets/other.png', png());
  await f.put('src/Lab.js', `import { Image } from 'react-native'; const App = () => <><Image source={require('../assets/coast-hero.png')} /><Image source={require('../assets/other.png')} /></>;`);
  const result = await f.run(['--apply']); assert.equal(result.code, 0, result.stdout);
  assert.equal(result.report.summary.placementsAdded, 0); assert.equal(result.report.summary.placementsReused, 1);
  assert.equal(result.report.skipped[0].reason, 'catalog-dimension-conflict');
  assert.deepEqual(JSON.parse(await f.get('assetlib.catalog.json')), original);
  assert.match(await f.get('src/Lab.js'), /asset=\{AppAssets.Custom.saved\}/);
});

test('supports JSX in ts and js, overlapping source roots, custom generated path, and existing client without rewriting it', async t => {
  const f = await fixture(t);
  await f.put('src/nested/Lab.ts', `import { Image } from 'expo-image'; export const App = () => <Image source={require('../../assets/coast-hero.png')} />;`);
  const client = `// keep my existing client\nexport const imageClient = makeClient();\n`;
  await f.put('src/custom/client.ts', client);
  const result = await f.run(['--apply', '--src', path.join(f.root, 'src/nested'), '--generated', path.join(f.root, 'generated/placements.ts'), '--client-import', './src/custom/client#imageClient']);
  assert.equal(result.code, 0, result.stdout); assert.equal(result.report.summary.candidates, 1);
  assert.equal(await f.get('src/custom/client.ts'), client);
  assert.ok(!result.report.files.some(item => item.path === 'src/custom/client.ts'));
  assert.match(await f.get('src/nested/Lab.ts'), /from "\.\.\/\.\.\/generated\/placements"/);
  assert.match(await f.get('src/nested/Lab.ts'), /from "\.\.\/custom\/client"/);
  assert.match(await f.get('src/nested/Lab.ts'), /client=\{imageClient\}/);
});

test('safe import aliases handle local name conflicts and lexical shadowing, with CRLF formatting preserved', async t => {
  const f = await fixture(t);
  const source = `import { Image } from 'react-native';\r\nconst AssetlibImage = 1, AppAssets = 2, client = 3;\r\nexport const App = () => <Image source={require('../assets/coast-hero.png')} style={{ width: 100 }} />;\r\nfunction Other(Image) { return <Image source={require('../assets/coast-hero.png')} />; }\r\nfunction Shadow(require) { return <Image source={require('../assets/coast-hero.png')} />; }\r\n`;
  await f.put('src/Lab.tsx', source);
  const result = await f.run(['--apply']); assert.equal(result.code, 0, result.stdout);
  assert.equal(result.report.summary.candidates, 1);
  assert.deepEqual(result.report.skipped.map(item => item.reason), ['image-not-imported', 'shadowed-require']);
  const changed = await f.get('src/Lab.tsx');
  assert.match(changed, /import \{ AssetlibImage as AssetlibImage2 \}/);
  assert.match(changed, /import \{ AppAssets as AppAssets2 \}/);
  assert.match(changed, /import \{ client as client2 \}/);
  assert.match(changed, /<AssetlibImage2 client=\{client2\} asset=\{AppAssets2.Lab.coastHero\}/);
  assert.ok(!changed.replaceAll('\r\n', '').includes('\n')); syntax(changed);
});

test('single-use binding analysis distinguishes shadowed identifiers and ignores existing AssetlibImage fallbacks', async t => {
  const f = await fixture(t);
  await f.put('src/Lab.tsx', `import { Image } from 'react-native';\nimport { AssetlibImage as Artwork } from '@assetlib/sdk-expo';\nconst hero = require('../assets/coast-hero.png');\nconst old = require('../assets/coast-hero.png');\nfunction Other(hero) { return <Image source={hero} />; }\nexport const App = () => <><Image source={hero} /><Artwork fallback={old} /><Artwork fallback={require('../assets/coast-hero.png')} /></>;\n`);
  const result = await f.run(['--apply']); assert.equal(result.code, 0, result.stdout);
  assert.equal(result.report.summary.candidates, 1); assert.equal(result.report.summary.skipped, 0);
  assert.match(await f.get('src/Lab.tsx'), /<Artwork client=\{client\}/);
  assert.equal((await f.run()).code, 3);
});

test('bare client modules create no stub and default exports receive valid imports', async t => {
  const f = await fixture(t);
  await f.put('src/Lab.tsx', `import { Image } from 'react-native'; const App = () => <Image source={require('../assets/coast-hero.png')} />;`);
  const result = await f.run(['--apply', '--client-import', '@example/client#default']);
  assert.equal(result.code, 0, result.stdout);
  assert.ok(!result.report.files.some(item => /client\.(ts|js)$/.test(item.path)));
  assert.match(await f.get('src/Lab.tsx'), /import client from "@example\/client";/);
});

test('does not follow links or scan generated, hidden, dependency, oversized or malformed sources', async t => {
  const f = await fixture(t);
  const source = `import { Image } from 'react-native'; const App = () => <Image source={require('../assets/coast-hero.png')} />;`;
  for (const file of ['src/skip.generated.tsx', 'src/.hidden.tsx', 'src/node_modules/Skip.tsx', 'src/dist/Skip.tsx']) await f.put(file, source);
  await f.put('src/Large.tsx', ' '.repeat(256 * 1024 + 1));
  await f.put('src/Broken.tsx', 'const App = () => <Image');
  await symlink(path.join(f.root, 'src/skip.generated.tsx'), path.join(f.root, 'src/Link.tsx'));
  const result = await f.run(); assert.equal(result.code, 3);
  assert.equal(result.report.summary.candidates, 0);
  assert.deepEqual(result.report.issues.map(item => item.reason).sort(), ['source-parse-error', 'unreadable-or-byte-limit']);
});

test('invalid image dimensions, content, catalog names, and symlink images are skipped without mutations', async t => {
  const f = await fixture(t);
  await f.put('assets/huge.png', png(8193, 800)); await f.put('assets/bad.png', 'invalid');
  await f.put('assets/123.png', png()); await symlink(path.join(f.root, 'assets/coast-hero.png'), path.join(f.root, 'assets/link.png'));
  await f.put('src/Lab.tsx', `import { Image } from 'react-native'; const App = () => <>${['huge.png', 'bad.png', '123.png', 'link.png'].map(name => `<Image source={require('../assets/${name}')} />`).join('')}</>;`);
  const before = await snapshot(f.root), result = await f.run(['--apply']);
  assert.equal(result.code, 3); assert.deepEqual(result.report.skipped.map(item => item.reason), ['invalid-catalog-name-or-dimensions', 'dimensions-unavailable', 'invalid-catalog-name-or-dimensions', 'symlink-or-outside-root']);
  assert.deepEqual(await snapshot(f.root), before);
});

test('command validation and real binary exit codes distinguish candidates, nothing to adopt, and errors', async t => {
  const f = await fixture(t);
  for (const options of [['--min-edge', '0'], ['--min-edge', '1.5'], ['--min-edge', 'no'], ['--client-import', 'broken'], ['--client-import', './src/client#class'], ['--client-import', './src/client#await'], ['--client-import', './src/client#yield'], ['--apply=true'], ['--src', path.dirname(f.root)], ['--generated', path.join(f.root, 'assetlib.catalog.json')]]) {
    const result = await f.run(options); assert.equal(result.code, 1, JSON.stringify(options)); assert.ok(result.report.error);
  }
  const noSrc = await execute(process.execPath, [bin, 'adopt', '--catalog', path.join(f.root, 'assetlib.catalog.json'), '--json']).catch(error => error);
  assert.equal(noSrc.code, 1); assert.match(noSrc.stdout, /--src/);
  const empty = await execute(process.execPath, [bin, ...f.args, '--json']).catch(error => error);
  assert.equal(empty.code, 3); assert.equal(JSON.parse(empty.stdout).summary.candidates, 0);
  await f.put('src/Lab.tsx', `import { Image } from 'react-native'; const App = () => <Image source={require('../assets/coast-hero.png')} />;`);
  const success = await execute(process.execPath, [bin, ...f.args, '--json']);
  assert.equal(JSON.parse(success.stdout).summary.candidates, 1); assert.equal(success.stderr, '');
});

function replayUnified(before, patch) {
  const originals = before?.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const lines = patch.trimEnd().split('\n'), header = lines[2].match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/);
  assert.ok(header);
  let index = Number(header[1]) === 0 ? 0 : Number(header[1]) - 1;
  const output = originals.slice(0, index);
  let removed = 0, added = 0;
  for (let i = 3; i < lines.length; i++) {
    const marker = lines[i][0];
    assert.ok([' ', '-', '+'].includes(marker), lines[i]);
    const noNewline = lines[i + 1] === '\\ No newline at end of file';
    const value = lines[i].slice(1) + (noNewline ? '' : '\n');
    if (noNewline) i++;
    if (marker !== '+') { assert.equal(originals[index++], value); removed++; }
    if (marker !== '-') { output.push(value); added++; }
  }
  assert.equal(removed, Number(header[2])); assert.equal(added, Number(header[4]));
  return output.concat(originals.slice(index)).join('');
}

test('every unified diff replays exactly, including newline-only catalog and generated changes', async t => {
  const catalog = { schemaVersion: 1, placements: [{ key: 'lab.coast-hero', symbol: ['Lab', 'coastHero'], width: 1200, height: 900 }] };
  const f = await fixture(t, catalog);
  await f.put('assetlib.catalog.json', JSON.stringify(catalog, null, 2));
  await f.put('src/assets.generated.ts', generateCatalog(catalog).trimEnd());
  await f.put('src/Lab.tsx', `import { Image } from 'react-native';\nexport const App = () => <Image source={require('../assets/coast-hero.png')} />;`);
  const before = await snapshot(f.root), result = await f.run(['--apply']);
  assert.equal(result.code, 0, result.stdout);
  for (const file of result.report.files) {
    const original = before[file.path] ? Buffer.from(before[file.path], 'base64').toString('utf8') : null;
    assert.equal(replayUnified(original, file.diff), await f.get(file.path), file.path);
  }
  assert.match(result.report.files.find(item => item.path === 'assetlib.catalog.json').diff, /\n-}\n\\ No newline at end of file\n\+}\n/);
});

test('reuses every same-run image after a basename collision', async t => {
  const f = await fixture(t);
  await f.put('assets/other/coast-hero.png', png());
  await f.put('src/Lab.tsx', `import { Image } from 'react-native';\nexport const App = () => <><Image source={require('../assets/coast-hero.png')} /><Image source={require('../assets/other/coast-hero.png')} /><Image source={require('../assets/other/coast-hero.png')} /></>;`);
  const result = await f.run(['--apply']);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.report.candidates.map(item => item.key), ['lab.coast-hero', 'lab.coast-hero-2', 'lab.coast-hero-2']);
  assert.equal(result.report.summary.placementsAdded, 2);
});

test('exported module constants with one use in the file remain exported after adoption', async t => {
  const f = await fixture(t);
  await f.put('src/Lab.tsx', `import { Image } from 'react-native';\nexport const hero = require('../assets/coast-hero.png');\nexport const App = () => <Image source={hero} />;`);
  const result = await f.run(['--apply']);
  assert.equal(result.code, 0, result.stdout); assert.equal(result.report.summary.candidates, 1);
  assert.match(await f.get('src/Lab.tsx'), /export const hero = require/);
  assert.match(await f.get('src/Lab.tsx'), /fallback=\{hero\}/);
});

test('shorthand and export references count as uses; unsupported single-use constants report their use context', async t => {
  const f = await fixture(t);
  await f.put('src/Lab.tsx', `import { Image } from 'react-native';\nconst hero = require('../assets/coast-hero.png');\nconst object = { hero };\nconst exported = require('../assets/coast-hero.png');\nexport { exported };\nconst conditional = require('../assets/coast-hero.png');\nconst source = ok ? conditional : null;\nconst singleObject = require('../assets/coast-hero.png');\nconst literal = { artwork: singleObject };\nexport const App = () => <><Image source={hero} /><Image source={exported} /></>;`);
  const result = await f.run();
  assert.equal(result.code, 3, result.stdout);
  assert.deepEqual(result.report.skipped.map(item => item.reason), ['multiple-uses', 'multiple-uses', 'conditional-expression', 'object-property']);
});

test('existing state-set keys reuse their top-level image fields without changing declarations', async t => {
  const catalog = { schemaVersion: 1, placements: [{ key: 'lab.coast-hero', symbol: ['Lab', 'coastHero'], width: 1200, height: 900, states: ['empty', 'full'], defaultState: 'empty' }] };
  const f = await fixture(t, catalog);
  await f.put('src/Lab.tsx', `import { Image } from 'react-native'; const App = () => <Image source={require('../assets/coast-hero.png')} />;`);
  const result = await f.run(['--apply']); assert.equal(result.code, 0, result.stdout);
  assert.equal(result.report.summary.placementsAdded, 0); assert.equal(result.report.summary.placementsReused, 1);
  assert.deepEqual(JSON.parse(await f.get('assetlib.catalog.json')), catalog);
});
