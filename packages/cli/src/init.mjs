import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { adopt } from './adopt.mjs';

const UUID = /^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$/;
const slash = value => value.split(path.sep).join('/');
const CONFIG_FILE = 'assetlib.public.json';
const WORKFLOW_FILE = '.github/workflows/assetlib-sync.yml';

async function exists(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function readJson(file, limit, label) {
  const text = await readFile(file, 'utf8').catch(error => { throw new Error(error.code === 'ENOENT' ? `${label} not found: ${file}` : `${label} could not be read.`); });
  if (Buffer.byteLength(text) > limit) throw new Error(`${label} exceeds ${limit} bytes.`);
  try { return { text, value: JSON.parse(text) }; } catch { throw new Error(`${label} is not valid JSON.`); }
}

/** The shape the SDKs require (sdk-core parsePublicConfig). Keys are checked fully by the SDK when the app loads it. */
export function checkPublicConfig(config) {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(config) || config.schemaVersion !== 1) throw new Error('--config is not an Assetlib public configuration (schemaVersion 1).');
  if (config.environment !== 'staging' && config.environment !== 'production') throw new Error('--config environment must be staging or production.');
  if (!UUID.test(config.orgId ?? '') || !UUID.test(config.appId ?? '')) throw new Error('--config orgId and appId must be UUIDs.');
  let url;
  try { url = new URL(config.manifestUrl); } catch { throw new Error('--config manifestUrl must be a URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('--config manifestUrl must use HTTPS.');
  const base = `/api/delivery/${config.orgId}/${config.appId}`;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== `${base}/environments/${config.environment}/manifest` && !(config.environment === 'production' && url.pathname === `${base}/manifest`))) throw new Error('--config manifestUrl does not match its orgId, appId and environment.');
  const single = typeof config.pinnedPublicKey === 'string' && config.pinnedPublicKey.length > 0;
  const set = Array.isArray(config.pinnedPublicKeys) && config.pinnedPublicKeys.length > 0 && config.pinnedPublicKeys.every(key => typeof key === 'string' && key.length > 0);
  if (!single && !set) throw new Error('--config must pin a public key (pinnedPublicKey or pinnedPublicKeys).');
  return { origin: url.origin, orgId: config.orgId, appId: config.appId, environment: config.environment };
}

/* The workflow pins nothing it cannot read from the repository: the token stays a GitHub secret, the console and IDs
   come from the public config when one was given, and the CLI runs from the installed @assetlib/cli package, never by
   a bare npm name. */
export function syncWorkflow({ console: origin, orgId, appId, srcDirectories, appVersion }) {
  const value = (known, variable) => known ?? `\${{ vars.${variable} }}`;
  const references = srcDirectories.map(dir => ` --references ${JSON.stringify(dir)}`).join('');
  return `# Registers assetlib.catalog.json with Assetlib on every push to main (written by assetlib init).
# Add the ASSETLIB_TOKEN repository secret: a token with the Declare scope from Settings > Tokens in the console.
name: Assetlib sync
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - name: Register placements
        env:
          ASSETLIB_TOKEN: \${{ secrets.ASSETLIB_TOKEN }}
          ASSETLIB_CONSOLE: ${value(origin, 'ASSETLIB_CONSOLE')}
          ASSETLIB_ORG: ${value(orgId, 'ASSETLIB_ORG')}
          ASSETLIB_APP: ${value(appId, 'ASSETLIB_APP')}
        run: |
          node ./node_modules/@assetlib/cli/bin/assetlib.mjs sync --catalog assetlib.catalog.json --platform expo \\
            --app-version "${appVersion}" --build-number "\${{ github.run_number }}"${references}
`;
}

/** Set up an Expo app: adopt its bundled images into a new catalog, save the public config, and add a sync workflow.
    A dry run unless `apply`; writes nothing if no image can be adopted. Never calls Git or the network. */
export async function init({ root: requestedRoot, src, images, config: configOption, generated, clientImport, minEdge = 64, ci = 'github', apply = false }) {
  if (!['github', 'none'].includes(ci)) throw new Error('--ci must be github or none.');
  const requested = path.resolve(requestedRoot), root = await realpath(requested);
  // Paths given under the project as typed (e.g. /var/... for /private/var/...) are mapped onto its real path.
  const inProject = file => { const relative = path.relative(requested, path.resolve(requested, file)); return relative.startsWith('..') || path.isAbsolute(relative) ? path.resolve(requested, file) : path.join(root, relative); };
  const catalogPath = path.join(root, 'assetlib.catalog.json');
  if (await exists(catalogPath)) throw new Error('assetlib.catalog.json already exists. Use assetlib adopt to add placements.');

  const { value: pkg } = await readJson(path.join(root, 'package.json'), 1024 * 1024, 'package.json');
  const dependencies = { ...pkg.devDependencies, ...pkg.dependencies };
  if (!dependencies.expo) throw new Error('assetlib init sets up Expo apps, and package.json has no expo dependency. Swift and Kotlin apps use their SDK READMEs.');
  const sourceDirs = (src?.length ? src : ['src']).map(inProject);
  for (const dir of sourceDirs) if (!(await exists(dir))) throw new Error(`--src directory not found: ${slash(path.relative(root, dir)) || '.'}`);

  const notes = [], extras = [];
  let target = null;
  if (configOption) {
    const { text, value } = await readJson(path.resolve(configOption), 4096, '--config');
    target = checkPublicConfig(value);
    const destination = path.join(root, CONFIG_FILE);
    if (path.resolve(configOption) !== destination) {
      if (await exists(destination)) {
        if ((await readFile(destination, 'utf8')) !== text) throw new Error(`${CONFIG_FILE} already exists with different contents.`);
      } else extras.push({ file: destination, text });
    }
    notes.push(`Public config: ${target.environment} for app ${target.appId} on ${target.origin}. It pins the signing key the app trusts, so take it only from your console's Settings › Connect.`);
  } else if (await exists(path.join(root, CONFIG_FILE))) {
    const { value } = await readJson(path.join(root, CONFIG_FILE), 4096, CONFIG_FILE);
    target = checkPublicConfig(value);
  } else notes.push(`No public config: download it from Settings › Connect in the console and save it as ${CONFIG_FILE}, or rerun with --config.`);

  if (ci === 'github') {
    const workflow = path.join(root, WORKFLOW_FILE);
    if (await exists(workflow)) notes.push(`${WORKFLOW_FILE} already exists and was left unchanged.`);
    else {
      let appVersion = '$(node -p "require(\'./package.json\').version")';
      try { if ((await readJson(path.join(root, 'app.json'), 1024 * 1024, 'app.json')).value?.expo?.version) appVersion = '$(node -p "require(\'./app.json\').expo.version")'; } catch { /* app.config.js or no app.json: package.json carries the version. */ }
      extras.push({ file: workflow, text: syncWorkflow({ console: target?.origin, orgId: target?.orgId, appId: target?.appId, srcDirectories: sourceDirs.map(dir => slash(path.relative(root, dir)) || '.'), appVersion }) });
      if (!target) notes.push(`The workflow reads ASSETLIB_CONSOLE, ASSETLIB_ORG and ASSETLIB_APP from repository variables until a public config is given.`);
    }
  }

  // Plan the adoption first: it decides whether there is anything to set up at all.
  const empty = { schemaVersion: 1, placements: [] };
  const options = { catalogPath, catalog: empty, src: sourceDirs, generated: generated && inProject(generated), clientImport, minEdge, images: images?.map(inProject), createCatalog: true };
  const preview = await adopt({ ...options, apply: false });
  const report = { mode: apply ? 'apply' : 'dry-run', adoption: preview, files: [...preview.files], notes };
  for (const item of extras) report.files.push({ path: slash(path.relative(root, item.file)), created: true, diff: `--- /dev/null\n+++ b/${slash(path.relative(root, item.file))}\n` + item.text.split('\n').filter((line, index, all) => index < all.length - 1 || line).map(line => '+' + line).join('\n') + '\n' });
  if (!preview.summary.candidates) { report.files = []; return report; }

  if (apply) {
    for (const item of extras) if (await exists(item.file)) throw new Error(`${slash(path.relative(root, item.file))} appeared during init; rerun the command.`);
    report.adoption = await adopt({ ...options, apply: true });
    for (const item of extras) { await mkdir(path.dirname(item.file), { recursive: true }); await writeFile(item.file, item.text, { flag: 'wx' }); }
  }
  report.next = [
    'Install @assetlib/sdk-core, @assetlib/sdk-expo and @assetlib/cli from the same GitHub release as this CLI (see the CLI README). They are not on npm: never install them by name.',
    ...(ci === 'github' ? ['Add the ASSETLIB_TOKEN repository secret: a token with the Declare scope from Settings › Tokens. The first push to main then registers the placements.'] : ['Run assetlib sync in CI on every build (see the CLI README).']),
    'Run a development build. Overview in the console ticks "Declare placements" after the first sync and "Connect your app" when the build first requests a manifest.',
    'Publish a change in the console and refresh the app: "Update an image without an app release" ticks when the app requests it.',
  ];
  return report;
}

export function formatInit(report) {
  const summary = report.adoption.summary;
  const lines = [`Assetlib init ${report.mode === 'apply' ? 'applied' : 'dry run'}`];
  if (!summary.candidates) {
    lines.push('Nothing to set up: no bundled image call site could be adopted, and a catalog needs at least one placement.');
    for (const item of report.adoption.skipped) lines.push(`  Skip ${item.path}:${item.line}: ${item.reason}`);
    lines.push(...report.adoption.notes.slice(1), ...report.notes);
    return lines.join('\n') + '\n';
  }
  const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  lines.push(`${count(summary.placementsAdded, 'placement')}; ${count(summary.candidates, 'call site')}; ${count(report.files.length, 'file')} ${report.mode === 'apply' ? 'written' : 'would be written'}.`);
  for (const item of report.adoption.candidates) lines.push(`  Adopt ${item.path}:${item.line} → ${item.key} (${item.width}×${item.height})`);
  for (const item of report.adoption.skipped) lines.push(`  Skip ${item.path}:${item.line}: ${item.reason}`);
  lines.push(...report.adoption.notes, ...report.notes);
  if (report.mode !== 'apply') lines.push('Rerun with --apply to write these files. Commit your work first so the changes are easy to review.');
  lines.push('', 'Next:', ...report.next.map((step, index) => `  ${index + 1}. ${step}`));
  for (const file of report.files) lines.push('', file.diff.trimEnd());
  return lines.join('\n') + '\n';
}
