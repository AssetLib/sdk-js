import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.mjs';
import { checkPublicConfig } from '../src/init.mjs';

const org = '11111111-1111-4111-8111-111111111111', app = '22222222-2222-4222-8222-222222222222';
const config = (overrides = {}) => ({ schemaVersion: 1, orgId: org, appId: app, environment: 'production', manifestUrl: `https://console.example.com/api/delivery/${org}/${app}/environments/production/manifest`, pinnedPublicKey: '-----BEGIN PUBLIC KEY-----\nTEST_ONLY\n-----END PUBLIC KEY-----\n', ...overrides });
function png(width = 1200, height = 900) {
  const bytes = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(bytes);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); bytes[24] = 8; bytes[25] = 2;
  return bytes;
}
async function project(t, { pkg = { name: 'demo', version: '1.0.0', dependencies: { expo: '~54.0.0' } }, source } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'assetlib-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(name, content) { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); return file; }
  await put('package.json', JSON.stringify(pkg));
  await put('app.json', JSON.stringify({ expo: { name: 'Demo', version: '1.2.0' } }));
  await put('assets/coast-hero.png', png());
  await put('assets/ridge.png', png(800, 600));
  await put('assets/app-icon.png', png());
  await put('src/Home.tsx', source ?? `import { Image } from 'react-native';\nexport const Home = () => <>\n  <Image source={require('../assets/coast-hero.png')} />\n  <Image source={require('../assets/ridge.png')} />\n  <Image source={require('../assets/app-icon.png')} />\n</>;\n`);
  const configFile = path.join(root, '..', `${path.basename(root)}-config.json`);
  await writeFile(configFile, JSON.stringify(config(), null, 2) + '\n');
  t.after(() => rm(configFile, { force: true }));
  async function run(options = [], json = true) {
    let stdout = '', stderr = '';
    const code = await main(['init', '--project', root, ...options, ...(json ? ['--json'] : [])], {}, { stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
    return { code, stdout, stderr, ...(json && stdout ? { report: JSON.parse(stdout) } : {}) };
  }
  async function files() {
    const found = [];
    async function walk(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else found.push(path.relative(root, file).split(path.sep).join('/')); } }
    await walk(root);
    return found.filter(file => !file.startsWith('assets/')).sort();
  }
  return { root, put, run, files, configFile, get: name => readFile(path.join(root, name), 'utf8') };
}
const original = ['app.json', 'package.json', 'src/Home.tsx'];

test('init is a dry run by default and plans the catalog, client, config and workflow', async t => {
  const p = await project(t);
  const { code, report } = await p.run(['--config', p.configFile]);
  assert.equal(code, 0);
  assert.equal(report.mode, 'dry-run');
  assert.deepEqual(report.adoption.candidates.map(item => item.key), ['home.coast-hero', 'home.ridge']);
  assert.deepEqual(report.adoption.skipped.map(item => item.reason), ['essential']);
  assert.deepEqual(report.files.map(file => file.path).sort(), ['.github/workflows/assetlib-sync.yml', 'assetlib.catalog.json', 'assetlib.public.json', 'src/Home.tsx', 'src/assetlib/client.ts', 'src/assets.generated.ts']);
  assert.equal(report.files.find(file => file.path === 'assetlib.catalog.json').created, true);
  assert.equal(report.next.length, 4);
  assert.deepEqual(await p.files(), original, 'a dry run writes nothing');
  const text = await p.run(['--config', p.configFile], false);
  assert.match(text.stdout, /2 placements; 2 call sites; 6 files would be written\./);
  assert.match(text.stdout, /Rerun with --apply/);
});

test('init --apply writes the plan once and then refuses to run again', async t => {
  const p = await project(t);
  assert.equal((await p.run(['--config', p.configFile, '--apply'])).code, 0);
  assert.deepEqual(await p.files(), ['.github/workflows/assetlib-sync.yml', 'app.json', 'assetlib.catalog.json', 'assetlib.public.json', 'package.json', 'src/Home.tsx', 'src/assetlib/client.ts', 'src/assets.generated.ts']);
  const catalog = JSON.parse(await p.get('assetlib.catalog.json'));
  assert.deepEqual(catalog.placements.map(item => [item.key, item.width, item.height]), [['home.coast-hero', 1200, 900], ['home.ridge', 800, 600]]);
  assert.equal(await p.get('assetlib.public.json'), await readFile(p.configFile, 'utf8'), 'the public config is copied byte for byte');
  const home = await p.get('src/Home.tsx');
  assert.match(home, /asset=\{AppAssets\.Home\.coastHero\} fallback=\{require\('\.\.\/assets\/coast-hero\.png'\)\}/);
  assert.match(home, /<Image source=\{require\('\.\.\/assets\/app-icon\.png'\)\} \/>/, 'essential images stay untouched');
  const workflow = await p.get('.github/workflows/assetlib-sync.yml');
  assert.match(workflow, /ASSETLIB_TOKEN: \$\{\{ secrets\.ASSETLIB_TOKEN \}\}/);
  assert.match(workflow, new RegExp(`ASSETLIB_CONSOLE: https://console\\.example\\.com\\n\\s+ASSETLIB_ORG: ${org}\\n\\s+ASSETLIB_APP: ${app}`));
  assert.match(workflow, /node \.\/node_modules\/@assetlib\/cli\/bin\/assetlib\.mjs sync --catalog assetlib\.catalog\.json --platform expo/);
  assert.match(workflow, /--app-version "\$\(node -p "require\('\.\/app\.json'\)\.expo\.version"\)" --build-number "\$\{\{ github\.run_number \}\}" --references "src"/);
  assert.doesNotMatch(workflow, /npx|npm install|PUBLIC KEY/, 'the CLI runs from the installed package and no key is copied into CI');
  const again = await p.run([], false);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /assetlib\.catalog\.json already exists\. Use assetlib adopt/);
});

test('init writes nothing and exits 3 when no image can be adopted', async t => {
  const p = await project(t, { source: `import { Image } from 'react-native';\nexport const Icon = () => <Image source={require('../assets/app-icon.png')} />;\n` });
  const { code, report } = await p.run(['--config', p.configFile, '--apply']);
  assert.equal(code, 3);
  assert.deepEqual(report.files, []);
  assert.deepEqual(await p.files(), original);
  assert.match((await p.run([], false)).stdout, /Nothing to set up: no bundled image call site could be adopted/);
});

test('--image adopts only the chosen images and names any it could not find', async t => {
  const p = await project(t);
  const { report } = await p.run(['--image', path.join(p.root, 'assets/ridge.png'), '--image', path.join(p.root, 'assets/missing.png')]);
  assert.deepEqual(report.adoption.candidates.map(item => item.key), ['home.ridge']);
  assert.ok(report.adoption.notes.some(note => note.includes('No adoptable call site uses --image') && note.includes('missing.png')));
});

test('init needs an Expo app and an existing --src directory', async t => {
  const native = await project(t, { pkg: { name: 'web', dependencies: { react: '19.0.0' } } });
  const result = await native.run([], false);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /sets up Expo apps/);
  const p = await project(t);
  assert.match((await p.run(['--src', path.join(p.root, 'app')], false)).stderr, /--src directory not found/);
});

test('init rejects a public config that does not match its app or pins no key, before writing anything', async t => {
  const p = await project(t);
  for (const [bad, message] of [
    [config({ manifestUrl: `https://console.example.com/api/delivery/${org}/${org}/environments/production/manifest` }), /does not match/],
    [config({ manifestUrl: `http://console.example.com/api/delivery/${org}/${app}/environments/production/manifest` }), /must use HTTPS/],
    [config({ pinnedPublicKey: undefined }), /must pin a public key/],
    [config({ environment: 'preview' }), /staging or production/],
    [{ ...config(), schemaVersion: 2 }, /schemaVersion 1/],
  ]) {
    await writeFile(p.configFile, JSON.stringify(bad));
    const result = await p.run(['--config', p.configFile, '--apply'], false);
    assert.equal(result.code, 1); assert.match(result.stderr, message);
  }
  await writeFile(p.configFile, 'x'.repeat(4097));
  assert.match((await p.run(['--config', p.configFile], false)).stderr, /exceeds 4096 bytes/);
  assert.deepEqual(await p.files(), original);
});

test('an existing public config is kept: a matching copy is not rewritten and a different one stops init', async t => {
  const p = await project(t);
  await p.put('assetlib.public.json', await readFile(p.configFile, 'utf8'));
  const same = await p.run(['--config', p.configFile]);
  assert.equal(same.code, 0);
  assert.ok(!same.report.files.some(file => file.path === 'assetlib.public.json'));
  await p.put('assetlib.public.json', JSON.stringify(config({ environment: 'staging', manifestUrl: `https://console.example.com/api/delivery/${org}/${app}/environments/staging/manifest` })));
  assert.match((await p.run(['--config', p.configFile], false)).stderr, /already exists with different contents/);
  const fromFile = await p.run([]);
  assert.match(fromFile.report.files.find(file => file.path === '.github/workflows/assetlib-sync.yml').diff, new RegExp(`ASSETLIB_ORG: ${org}`), 'an existing config fills in the workflow');
});

test('--ci none skips the workflow; an existing workflow is left alone; no config falls back to repository variables', async t => {
  const p = await project(t);
  assert.ok(!(await p.run(['--ci', 'none'])).report.files.some(file => file.path.startsWith('.github/')));
  assert.match((await p.run(['--ci', 'gitlab'], false)).stderr, /--ci must be github or none/);
  const bare = await p.run([]);
  const workflow = bare.report.files.find(file => file.path === '.github/workflows/assetlib-sync.yml').diff;
  assert.match(workflow, /ASSETLIB_CONSOLE: \$\{\{ vars\.ASSETLIB_CONSOLE \}\}/);
  assert.ok(bare.report.notes.some(note => note.includes('No public config')));
  await p.put('.github/workflows/assetlib-sync.yml', 'name: mine\n');
  const kept = await p.run(['--config', p.configFile, '--apply']);
  assert.equal(kept.code, 0);
  assert.equal(await p.get('.github/workflows/assetlib-sync.yml'), 'name: mine\n');
  assert.ok(kept.report.notes.some(note => note.includes('already exists and was left unchanged')));
});

test('checkPublicConfig accepts the legacy production route and a pinned key set', () => {
  assert.deepEqual(checkPublicConfig(config({ manifestUrl: `https://console.example.com/api/delivery/${org}/${app}/manifest` })), { origin: 'https://console.example.com', orgId: org, appId: app, environment: 'production' });
  assert.equal(checkPublicConfig(config({ pinnedPublicKey: undefined, pinnedPublicKeys: ['a', 'b'] })).appId, app);
  assert.throws(() => checkPublicConfig(config({ environment: 'staging', manifestUrl: `https://console.example.com/api/delivery/${org}/${app}/manifest` })), /does not match/);
  assert.equal(checkPublicConfig(config({ manifestUrl: `http://127.0.0.1:3100/api/delivery/${org}/${app}/environments/production/manifest` })).origin, 'http://127.0.0.1:3100');
});
