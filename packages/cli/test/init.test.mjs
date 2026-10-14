import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.mjs';
import { checkPublicConfig, syncWorkflow } from '../src/init.mjs';

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
  assert.deepEqual(report.files.map(file => file.path).sort(), ['.github/workflows/assetlib-sync.yml', 'AGENTS.md', 'assetlib.catalog.json', 'assetlib.public.json', 'src/Home.tsx', 'src/assetlib/client.ts', 'src/assets.generated.ts']);
  assert.equal(report.files.find(file => file.path === 'assetlib.catalog.json').created, true);
  assert.equal(report.next.length, 4);
  assert.deepEqual(await p.files(), original, 'a dry run writes nothing');
  const text = await p.run(['--config', p.configFile], false);
  assert.match(text.stdout, /2 placements; 2 call sites; 7 files would be written\./);
  assert.match(text.stdout, /Rerun with --apply/);
});

test('init --apply writes the plan once and then refuses to run again', async t => {
  const p = await project(t);
  assert.equal((await p.run(['--config', p.configFile, '--apply'])).code, 0);
  assert.deepEqual(await p.files(), ['.github/workflows/assetlib-sync.yml', 'AGENTS.md', 'app.json', 'assetlib.catalog.json', 'assetlib.public.json', 'package.json', 'src/Home.tsx', 'src/assetlib/client.ts', 'src/assets.generated.ts']);
  const catalog = JSON.parse(await p.get('assetlib.catalog.json'));
  assert.deepEqual(catalog.placements.map(item => [item.key, item.width, item.height]), [['home.coast-hero', 1200, 900], ['home.ridge', 800, 600]]);
  assert.equal(await p.get('assetlib.public.json'), await readFile(p.configFile, 'utf8'), 'the public config is copied byte for byte');
  const home = await p.get('src/Home.tsx');
  assert.match(home, /asset=\{AppAssets\.Home\.coastHero\} fallback=\{require\('\.\.\/assets\/coast-hero\.png'\)\}/);
  assert.match(home, /<Image source=\{require\('\.\.\/assets\/app-icon\.png'\)\} \/>/, 'essential images stay untouched');
  const workflow = await p.get('.github/workflows/assetlib-sync.yml');
  assert.match(workflow, /ASSETLIB_TOKEN: \$\{\{ secrets\.ASSETLIB_TOKEN \}\}/);
  assert.match(workflow, new RegExp(`ASSETLIB_CONSOLE: 'https://console\\.example\\.com'\\n\\s+ASSETLIB_ORG: '${org}'\\n\\s+ASSETLIB_APP: '${app}'`));
  assert.match(workflow, /node \.\/node_modules\/@assetlib\/cli\/bin\/assetlib\.mjs sync --catalog assetlib\.catalog\.json --platform expo/);
  assert.match(workflow, /--app-version "\$APP_VERSION" --build-number "\$BUILD_NUMBER" --references 'src'/);
  assert.match(workflow, /APP_VERSION="\$\(node -p "require\('\.\/app\.json'\)\.expo\.version"\)"/);
  assert.match(workflow, /run: \|\n {10}if \[ "\$GITHUB_REF" = 'refs\/heads\/main' \]; then echo 'allowed=true' >> "\$GITHUB_OUTPUT"; fi\n/, 'the branch is compared in a shell, which is case-sensitive');
  assert.match(workflow, / {2}sync:\n {4}# .*\n {4}needs: branch_gate\n {4}if: needs\.branch_gate\.outputs\.allowed == 'true'\n {4}environment: assetlib-sync\n/);
  assert.doesNotMatch(workflow, /github\.ref|steps\.app/, 'no case-insensitive expression decides the branch');
  assert.equal((workflow.match(/GITHUB_OUTPUT/g) ?? []).length, 1, 'only the constant gate output is written to $GITHUB_OUTPUT');
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
  assert.match(fromFile.report.files.find(file => file.path === '.github/workflows/assetlib-sync.yml').diff, new RegExp(`ASSETLIB_ORG: '${org}'`), 'an existing config fills in the workflow');
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

test('the workflow keeps the token to one step: pinned actions, no stored credentials, no install scripts, no expressions in scripts', async t => {
  const p = await project(t);
  const workflow = (await p.run(['--config', p.configFile])).report.files.find(file => file.path === '.github/workflows/assetlib-sync.yml').diff.split('\n').map(line => line.slice(1)).join('\n');
  assert.match(workflow, /uses: actions\/checkout@[0-9a-f]{40} # v\d/);
  assert.match(workflow, /uses: actions\/setup-node@[0-9a-f]{40} # v\d/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /run: npm ci --ignore-scripts/);
  assert.equal((workflow.match(/secrets\.ASSETLIB_TOKEN/g) ?? []).length, 1, 'only the sync step sees the token');
  const scripts = [...workflow.matchAll(/run: \|\n((?: {10}.*\n?)+)|run: (.*)/g)].map(match => match[1] ?? match[2]);
  assert.ok(scripts.length >= 2);
  for (const script of scripts) assert.doesNotMatch(script, /\$\{\{/, 'no GitHub expression is expanded inside a shell script');
});

test('the branch gate lets only refs/heads/main through, compared with case', async t => {
  const workflow = syncWorkflow({ console: 'https://console.example.com', orgId: org, appId: app, srcDirectories: ['src'], appVersionFile: 'app.json' });
  const gate = workflow.match(/\n {2}branch_gate:\n[^]*?run: \|\n {10}(.*)\n {2}sync:\n/)[1];
  const dir = await mkdtemp(path.join(tmpdir(), 'assetlib-gate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'output');
  for (const [ref, allowed] of [['refs/heads/main', true], ['refs/heads/Main', false], ['refs/heads/MAIN', false], ['refs/heads/main-2', false], ['refs/heads/feature/main', false], ['refs/tags/main', false], ['refs/pull/1/merge', false]]) {
    await writeFile(output, '');
    execFileSync('bash', ['--noprofile', '--norc', '-e', '-c', gate], { env: { GITHUB_REF: ref, GITHUB_OUTPUT: output } });
    assert.equal(await readFile(output, 'utf8'), allowed ? 'allowed=true\n' : '', ref);
  }
});

test('init refuses source folders it cannot quote safely and never writes through a symlink', async t => {
  const p = await project(t);
  await mkdir(path.join(p.root, 'src $(touch pwned)'), { recursive: true });
  const unsafe = await p.run(['--src', path.join(p.root, 'src $(touch pwned)'), '--apply'], false);
  assert.equal(unsafe.code, 1);
  assert.match(unsafe.stderr, /cannot be written into the workflow/);
  const outside = await mkdtemp(path.join(tmpdir(), 'assetlib-init-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(p.root, '.github'));
  const linked = await p.run(['--config', p.configFile, '--apply'], false);
  assert.equal(linked.code, 1);
  assert.match(linked.stderr, /will not write \.github\/workflows\/assetlib-sync\.yml through a symlink/);
  assert.deepEqual(await readdir(outside), [], 'nothing is written outside the project');
  assert.ok(!(await p.files()).includes('assetlib.catalog.json'), 'a refused init writes nothing');
});

test('a loopback public config is never written into CI', async t => {
  const p = await project(t);
  await writeFile(p.configFile, JSON.stringify(config({ manifestUrl: `http://127.0.0.1:3100/api/delivery/${org}/${app}/environments/production/manifest` })));
  const { report } = await p.run(['--config', p.configFile]);
  const workflow = report.files.find(file => file.path === '.github/workflows/assetlib-sync.yml').diff;
  assert.match(workflow, /ASSETLIB_CONSOLE: \$\{\{ vars\.ASSETLIB_CONSOLE \}\}/);
  assert.doesNotMatch(workflow, /127\.0\.0\.1/);
  assert.ok(report.notes.some(note => note.includes('not on an HTTPS console')));
});

test('syncWorkflow rejects values that could escape their quotes', () => {
  const ok = { console: 'https://console.example.com', orgId: org, appId: app, srcDirectories: ['src'], appVersionFile: 'app.json' };
  assert.match(syncWorkflow(ok), /--references 'src'/);
  for (const [change, message] of [
    [{ console: "https://x.example'; curl evil" }, /HTTPS origin/],
    [{ orgId: "1' || true" }, /UUIDs/],
    [{ srcDirectories: ["src'"] }, /cannot be written/],
    [{ srcDirectories: ['../outside'] }, /cannot be written/],
    [{ srcDirectories: ['src\nrun: evil'] }, /cannot be written/],
    [{ appVersionFile: 'app.config.js' }, /app\.json or package\.json/],
  ]) assert.throws(() => syncWorkflow({ ...ok, ...change }), message);
  assert.match(syncWorkflow({ ...ok, srcDirectories: ['.', 'app/screens'] }), /--references '\.' --references 'app\/screens'/);
});

const expo57 = { name: 'demo', version: '1.0.0', dependencies: { expo: '~57.0.28' } };
// The parts of the Expo SDK 57 template's AppDelegate.swift that the plugin changes.
const TEMPLATE_APP_DELEGATE = `internal import Expo
import React

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let factory = ExpoReactNativeFactory(delegate: delegate)

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;
function loadScenePlugin(source) {
  const module = { exports: {} }, calls = [];
  const configPlugins = {
    withAppDelegate: (config, mod) => { config.appDelegate = mod({ modResults: { language: 'swift', contents: TEMPLATE_APP_DELEGATE } }).modResults.contents; return config; },
    withInfoPlist: (config, mod) => { config.infoPlist = mod({ modResults: {} }).modResults; return config; },
    IOSConfig: { XcodeProjectFile: { withBuildSourceFile: (config, options) => { calls.push(options); return config; } } },
  };
  new Function('require', 'module', 'exports', source)(name => { assert.equal(name, 'expo/config-plugins'); return configPlugins; }, module, module.exports);
  return { plugin: module.exports, calls };
}

test('on Expo SDK 57, init writes the scene life cycle plugin and registers it in app.json', async t => {
  const p = await project(t, { pkg: expo57 });
  await p.put('app.json', JSON.stringify({ expo: { name: 'Demo', version: '1.2.0', plugins: ['expo-image'] } }, null, 2) + '\n');
  const dry = await p.run(['--config', p.configFile]);
  assert.equal(dry.report.files.find(file => file.path === 'app.json').created, false);
  assert.match(dry.report.files.find(file => file.path === 'app.json').diff, /^--- a\/app\.json\n\+\+\+ b\/app\.json\n[^]*^- {6}"expo-image"\n\+ {6}"expo-image",\n\+ {6}"\.\/plugins\/with-ios-scene-lifecycle"\n/m);
  assert.ok(dry.report.notes.some(note => note.includes('UIScene life cycle')));
  assert.equal(JSON.parse(await p.get('app.json')).expo.plugins.length, 1, 'a dry run writes nothing');
  assert.equal((await p.run(['--config', p.configFile, '--apply'])).code, 0);
  assert.deepEqual(JSON.parse(await p.get('app.json')), { expo: { name: 'Demo', version: '1.2.0', plugins: ['expo-image', './plugins/with-ios-scene-lifecycle'] } });
  assert.ok((await p.get('app.json')).endsWith('}\n'));
  const { plugin, calls } = loadScenePlugin(await p.get('plugins/with-ios-scene-lifecycle.js'));
  const config = plugin({ sdkVersion: '57.0.0' });
  assert.match(config.appDelegate, /class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider \{/);
  assert.doesNotMatch(config.appDelegate, /UIWindow\(frame:|startReactNative/);
  assert.equal(plugin.adoptSceneAppDelegate(config.appDelegate), config.appDelegate, 'applying it twice changes nothing');
  assert.equal(config.infoPlist.UIApplicationSceneManifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication[0].UISceneDelegateClassName, '$(PRODUCT_MODULE_NAME).SceneDelegate');
  assert.deepEqual(calls.map(call => [call.filePath, call.overwrite]), [['SceneDelegate.swift', false]]);
  assert.match(calls[0].contents, /^internal import Expo\n\n@objc\(SceneDelegate\)\nclass SceneDelegate: ExpoAppSceneDelegate \{\n/);
  assert.deepEqual(plugin({ sdkVersion: '58.0.0' }), { sdkVersion: '58.0.0' }, 'SDK 58 templates already adopt scenes');
  assert.throws(() => plugin.adoptSceneAppDelegate('class AppDelegate: UIResponder {'), /not the Expo SDK 57 template's/);
});

test('the scene plugin is skipped before SDK 57, noted for a dynamic config, and left alone when present', async t => {
  const older = await project(t);
  assert.ok(!(await older.run(['--config', older.configFile])).report.files.some(file => file.path.startsWith('plugins/') || file.path === 'app.json'));
  const dynamic = await project(t, { pkg: expo57 });
  await dynamic.put('app.config.ts', 'export default ({ config }) => config;\n');
  await dynamic.put('ios/Podfile', '');
  const { report } = await dynamic.run(['--config', dynamic.configFile]);
  assert.ok(report.files.some(file => file.path === 'plugins/with-ios-scene-lifecycle.js'));
  assert.ok(!report.files.some(file => file.path === 'app.json'), 'app.json is not edited when app.config.ts decides the config');
  assert.ok(report.notes.includes("Add './plugins/with-ios-scene-lifecycle' to the plugins in app.config.ts if it is not there yet."));
  assert.ok(report.notes.some(note => note.includes('npx expo prebuild --clean --platform ios')));
  const present = await project(t, { pkg: expo57 });
  await present.put('plugins/with-ios-scene-lifecycle.js', '// mine\n');
  await present.put('app.json', JSON.stringify({ expo: { version: '1.2.0', plugins: ['./plugins/with-ios-scene-lifecycle'] } }));
  const kept = (await present.run(['--config', present.configFile])).report;
  assert.ok(!kept.files.some(file => file.path === 'app.json' || file.path.startsWith('plugins/')));
  assert.ok(kept.notes.includes('plugins/with-ios-scene-lifecycle.js already exists and was left unchanged.'));
  const scenes = await project(t, { pkg: expo57 });
  await scenes.put('app.json', JSON.stringify({ expo: { version: '1.2.0', ios: { infoPlist: { UIApplicationSceneManifest: {} } } } }));
  const adopted = (await scenes.run(['--config', scenes.configFile])).report;
  assert.ok(!adopted.files.some(file => file.path === 'app.json' || file.path.startsWith('plugins/')));
  assert.ok(!adopted.notes.some(note => note.includes('UIScene')));
});

test('the scene plugin follows the config file Expo reads and matches plugin entries exactly', async t => {
  for (const range of ['57', '~57', '^57', '57.0.28']) {
    const p = await project(t, { pkg: { ...expo57, dependencies: { expo: range } } });
    assert.ok((await p.run(['--config', p.configFile])).report.files.some(file => file.path === 'plugins/with-ios-scene-lifecycle.js'), `expo ${range}`);
  }
  for (const range of ['~54.0.0', '^55.0.0', '56']) {
    const p = await project(t, { pkg: { ...expo57, dependencies: { expo: range } } });
    const { report } = await p.run(['--config', p.configFile]);
    assert.ok(!report.files.some(file => file.path.startsWith('plugins/') || file.path === 'app.json'), `expo ${range}`);
    assert.ok(report.notes.some(note => note.startsWith('Expo SDK 54 to 56 iOS templates do not adopt the UIScene life cycle')), `expo ${range}`);
  }
  const flat = await project(t, { pkg: expo57 });
  await flat.put('app.json', JSON.stringify({ name: 'Demo', version: '1.2.0', plugins: ['./plugins/with-ios-scene-lifecycle-old'] }));
  assert.equal((await flat.run(['--config', flat.configFile, '--apply'])).code, 0);
  assert.deepEqual(JSON.parse(await flat.get('app.json')).plugins, ['./plugins/with-ios-scene-lifecycle-old', './plugins/with-ios-scene-lifecycle'], 'a flat app.json gets the plugin at its root; a similar name is not a match');
  const tuple = await project(t, { pkg: expo57 });
  await tuple.put('app.json', JSON.stringify({ expo: { version: '1.2.0', plugins: [['./plugins/with-ios-scene-lifecycle.js', {}]] } }));
  assert.ok(!(await tuple.run(['--config', tuple.configFile])).report.files.some(file => file.path === 'app.json'), 'a registered plugin with options is left alone');
  const json = await project(t, { pkg: expo57 });
  await json.put('app.config.json', JSON.stringify({ expo: { name: 'Demo' } }, null, '\t') + '\n');
  assert.equal((await json.run(['--config', json.configFile, '--apply'])).code, 0);
  assert.equal(await json.get('app.config.json'), JSON.stringify({ expo: { name: 'Demo', plugins: ['./plugins/with-ios-scene-lifecycle'] } }, null, '\t') + '\n', 'app.config.json, which Expo reads before app.json, keeps its tab indentation');
  assert.deepEqual(JSON.parse(await json.get('app.json')), { expo: { name: 'Demo', version: '1.2.0' } }, 'app.json is not the config Expo reads');
  const mts = await project(t, { pkg: expo57 });
  await mts.put('app.config.mts', 'export default { plugins: [] };\n');
  const { report } = await mts.run(['--config', mts.configFile]);
  assert.ok(!report.files.some(file => file.path === 'app.json'));
  assert.ok(report.notes.includes("Add './plugins/with-ios-scene-lifecycle' to the plugins in app.config.mts if it is not there yet."));
});
