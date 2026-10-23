import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { adopt, diff, safeDestination } from './adopt.mjs';
import { SCENE_PLUGIN, SCENE_PLUGIN_FILE, SCENE_PLUGIN_SOURCE } from './scene-plugin.mjs';

const UUID = /^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$/;
const slash = value => value.split(path.sep).join('/');
const CONFIG_FILE = 'assetlib.public.json';
const WORKFLOW_FILE = '.github/workflows/assetlib-sync.yml';
// Values written into the workflow are limited to characters that cannot end a quoted YAML or shell string.
const SAFE_DIRECTORY = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*|\.)(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const SAFE_ORIGIN = /^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$/;
// Pinned to the commits sdk-js's own CI uses; update them together.
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';
const SETUP_NODE = 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0';

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

/* The workflow keeps the token to one step: actions are pinned to commits, checkout keeps no credentials, install
   scripts stay off, and the CLI runs from the installed @assetlib/cli package's entry file, never by a bare npm name.
   No \${{ }} expression appears inside a shell script; values reach it as environment variables, and every literal is
   validated and single-quoted. */
export function syncWorkflow({ console: origin, orgId, appId, srcDirectories, appVersionFile }) {
  if (origin !== undefined && !SAFE_ORIGIN.test(origin)) throw new Error('The workflow console origin must be an HTTPS origin.');
  for (const id of [orgId, appId]) if (id !== undefined && !UUID.test(id)) throw new Error('The workflow IDs must be UUIDs.');
  for (const dir of srcDirectories) if (!SAFE_DIRECTORY.test(dir) || dir.split('/').includes('..')) throw new Error(`--src ${JSON.stringify(dir)} cannot be written into the workflow: use letters, digits, '.', '_', '-' and '/'.`);
  if (!['app.json', 'package.json'].includes(appVersionFile)) throw new Error('The app version comes from app.json or package.json.');
  const value = (known, variable) => known === undefined ? `\${{ vars.${variable} }}` : `'${known}'`;
  const references = srcDirectories.map(dir => ` --references '${dir}'`).join('');
  const version = appVersionFile === 'app.json' ? "require('./app.json').expo.version" : "require('./package.json').version";
  return `# Registers assetlib.catalog.json with Assetlib on every push to main (written by assetlib init).
# Store ASSETLIB_TOKEN, a token with the Declare scope from Settings > Tokens in the console, as a secret of the
# assetlib-sync environment with its deployment branches limited to main (GitHub Settings > Environments), not as a
# repository or organization secret, so no other branch can read it. A private repository on GitHub Free has no
# environments: use a repository secret there, which a branch whose workflow is edited to ask for it can read.
name: Assetlib sync
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
jobs:
  # GitHub compares expressions without regard to case, so the shell checks the exact ref.
  branch_gate:
    runs-on: ubuntu-latest
    outputs:
      allowed: \${{ steps.check.outputs.allowed }}
    steps:
      - id: check
        run: |
          if [ "$GITHUB_REF" = 'refs/heads/main' ]; then echo 'allowed=true' >> "$GITHUB_OUTPUT"; fi
  sync:
    # Only main runs this job: a manual run from any other branch is skipped.
    needs: branch_gate
    if: needs.branch_gate.outputs.allowed == 'true'
    environment: assetlib-sync
    runs-on: ubuntu-latest
    steps:
      - uses: ${CHECKOUT}
        with:
          persist-credentials: false
      - uses: ${SETUP_NODE}
        with:
          node-version: 22
      # Dependency install scripts stay off: this job needs none, and the next step holds the token.
      - run: npm ci --ignore-scripts
      - name: Register placements
        env:
          ASSETLIB_TOKEN: \${{ secrets.ASSETLIB_TOKEN }}
          ASSETLIB_CONSOLE: ${value(origin, 'ASSETLIB_CONSOLE')}
          ASSETLIB_ORG: ${value(orgId, 'ASSETLIB_ORG')}
          ASSETLIB_APP: ${value(appId, 'ASSETLIB_APP')}
          BUILD_NUMBER: \${{ github.run_number }}
        run: |
          APP_VERSION="$(node -p "${version}")"
          node ./node_modules/@assetlib/cli/bin/assetlib.mjs sync --catalog assetlib.catalog.json --platform expo \\
            --app-version "$APP_VERSION" --build-number "$BUILD_NUMBER"${references}
`;
}

/* Expo SDK 57's iOS template does not adopt the UIScene life cycle, which apps built with Xcode 27 need at launch.
   Plan the plugin that adopts it and its entry in the static app config; a dynamic app config gets a note instead. */
async function scenePlugin(root, writable, notes) {
  // Expo reads the first dynamic config in this order, else app.config.json, else app.json (with or without an expo key).
  let dynamic = null, staticName = null;
  for (const ext of ['ts', 'mts', 'cts', 'mjs', 'cjs', 'js']) if (await exists(path.join(root, `app.config.${ext}`))) { dynamic = `app.config.${ext}`; break; }
  for (const name of ['app.config.json', 'app.json']) if (await exists(path.join(root, name))) { staticName = name; break; }
  const staticFile = staticName && path.join(root, staticName);
  const app = staticFile ? await readJson(staticFile, 1024 * 1024, staticName).catch(() => null) : null;
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const expo = record(app?.value) ? (record(app.value.expo) ? app.value.expo : app.value) : null;
  if (expo?.ios?.infoPlist?.UIApplicationSceneManifest) return [];
  const items = [], file = path.join(root, SCENE_PLUGIN_FILE);
  await writable(file);
  if (await exists(file)) notes.push(`${SCENE_PLUGIN_FILE} already exists and was left unchanged.`);
  else items.push({ file, text: SCENE_PLUGIN_SOURCE });
  notes.push(`Expo SDK 57 apps built with Xcode 27 stop at launch on iOS 27 until they adopt the UIScene life cycle. ${SCENE_PLUGIN_FILE} applies the Expo SDK 58 template's scene setup when Expo generates ios/, and does nothing on SDK 58 or later.`);
  const registered = Array.isArray(expo?.plugins) && expo.plugins.some(entry => [SCENE_PLUGIN, `${SCENE_PLUGIN}.js`].includes(Array.isArray(entry) ? entry[0] : entry));
  const editable = !dynamic && expo && (expo.plugins === undefined || Array.isArray(expo.plugins)) && await writable(staticFile).then(() => true, () => false);
  if (dynamic) notes.push(`Add '${SCENE_PLUGIN}' to the plugins in ${dynamic} if it is not there yet.`);
  else if (registered) { /* Already registered. */ }
  else if (editable) {
    const next = structuredClone(app.value), target = record(next.expo) ? next.expo : next;
    target.plugins = [...(expo.plugins ?? []), SCENE_PLUGIN];
    items.push({ file: staticFile, before: app.text, text: JSON.stringify(next, null, /^[ \t]+(?=")/m.exec(app.text)?.[0] ?? 2) + (app.text.endsWith('\n') ? '\n' : '') });
  } else notes.push(`Add '${SCENE_PLUGIN}' to the plugins in ${staticName ?? 'your app config'}.`);
  if (await exists(path.join(root, 'ios'))) notes.push(`Expo applies config plugins only when it generates ios/. If this app's ios/ folder is generated, run npx expo prebuild --clean --platform ios before the next build; if you maintain it by hand, make the plugin's three changes there yourself.`);
  return items;
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

  // Notes about files init would write join the report only when something is set up.
  const notes = [], extras = [], planned = [];
  // Every file init writes itself must resolve inside the project without a symlink anywhere on its path.
  const writable = async file => { try { await safeDestination(root, file); } catch { throw new Error(`init will not write ${slash(path.relative(root, file))} through a symlink or onto a non-file.`); } };
  let target = null;
  if (configOption) {
    const { text, value } = await readJson(path.resolve(configOption), 4096, '--config');
    target = checkPublicConfig(value);
    const destination = path.join(root, CONFIG_FILE);
    await writable(destination);
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
    await writable(workflow);
    if (await exists(workflow)) notes.push(`${WORKFLOW_FILE} already exists and was left unchanged.`);
    else {
      let appVersionFile = 'package.json';
      try { if ((await readJson(path.join(root, 'app.json'), 1024 * 1024, 'app.json')).value?.expo?.version) appVersionFile = 'app.json'; } catch { /* app.config.js or no app.json: package.json carries the version. */ }
      // CI never sends the token to a non-HTTPS console; a loopback config leaves the console to a repository variable.
      const ciTarget = target?.origin.startsWith('https://') ? target : null;
      extras.push({ file: workflow, text: syncWorkflow({ console: ciTarget?.origin, orgId: ciTarget?.orgId, appId: ciTarget?.appId, srcDirectories: sourceDirs.map(dir => slash(path.relative(root, dir)) || '.'), appVersionFile }) });
      if (!ciTarget) planned.push(`The workflow reads ASSETLIB_CONSOLE, ASSETLIB_ORG and ASSETLIB_APP from repository variables${target ? ' because the public config is not on an HTTPS console' : ' until a public config is given'}.`);
    }
  }

  if (/^[\^~]?57(?:\.|$)/.test(dependencies.expo)) extras.push(...await scenePlugin(root, writable, planned));
  else if (/^[\^~]?5[4-6](?:\.|$)/.test(dependencies.expo)) planned.push('Expo SDK 54 to 56 iOS templates do not adopt the UIScene life cycle, which apps built with Xcode 27 need to launch on iOS 27, and expo before 57 has no ExpoAppSceneDelegate to adopt it with. Build iOS with Xcode 26, or move to Expo SDK 57, where init adds a plugin for it.');

  // Plan the adoption first: it decides whether there is anything to set up at all.
  const empty = { schemaVersion: 1, placements: [] };
  const options = { catalogPath, catalog: empty, src: sourceDirs, generated: generated && inProject(generated), clientImport, minEdge, images: images?.map(inProject), createCatalog: true };
  const preview = await adopt({ ...options, apply: false });
  const report = { mode: apply ? 'apply' : 'dry-run', adoption: preview, files: [...preview.files], notes };
  for (const item of extras) {
    const file = slash(path.relative(root, item.file));
    report.files.push(item.before === undefined
      ? { path: file, created: true, diff: `--- /dev/null\n+++ b/${file}\n` + item.text.split('\n').filter((line, index, all) => index < all.length - 1 || line).map(line => '+' + line).join('\n') + '\n' }
      : { path: file, created: false, diff: diff(file, item.before, item.text) });
  }
  if (!preview.summary.candidates) { report.files = []; return report; }
  notes.push(...planned);

  if (apply) {
    // A file init creates must still be missing, and one it edits (app.json) unchanged since the plan.
    const changed = async item => item.before === undefined ? exists(item.file) : (await readFile(item.file, 'utf8').catch(() => null)) !== item.before;
    for (const item of extras) { await writable(item.file); if (await changed(item)) throw new Error(`${slash(path.relative(root, item.file))} ${item.before === undefined ? 'appeared' : 'changed'} during init; rerun the command.`); }
    report.adoption = await adopt({ ...options, apply: true });
    for (const item of extras) {
      await mkdir(path.dirname(item.file), { recursive: true }); await writable(item.file);
      if (item.before === undefined) await writeFile(item.file, item.text, { flag: 'wx' });
      else { if (await changed(item)) throw new Error(`${slash(path.relative(root, item.file))} changed during init; review it and add the plugin by hand.`); await writeFile(item.file, item.text); }
    }
  }
  report.next = [
    'Install @assetlib/sdk-core and @assetlib/sdk-expo at one exact version, and @assetlib/cli, from npm or from the same GitHub release as this CLI (see the CLI README). Never install the unscoped assetlib package.',
    ...(ci === 'github' ? ['Store a token with the Declare scope from Settings › Tokens as the ASSETLIB_TOKEN secret of the assetlib-sync environment, with its deployment branches limited to main (GitHub Settings › Environments), or as a repository secret in a private repository on GitHub Free. The first push to main then registers the placements.'] : ['Run assetlib sync in CI on every build (see the CLI README).']),
    `Connect your coding agent to this workspace so it can see what each placement shows in draft, staging and production and prepare image changes as a draft: claude mcp add --transport http assetlib ${target ? target.origin : 'https://console.assetlib.dev'}/mcp (Codex: codex mcp add assetlib --url ${target ? target.origin : 'https://console.assetlib.dev'}/mcp, then codex mcp login assetlib), then sign in when it asks. Publishing stays in the console.`,
    'Run a development build. Overview in the console ticks "Register your placements" after the first sync and "Run your app" when the build first requests a manifest.',
    'Publish a change in the console, then reload the app or quit and reopen it. The starter client checks for a new release at launch and whenever the app returns to the foreground, and an image already on screen shows it the next time it mounts. "Publish an image change" ticks when the app requests the release.',
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
  for (const item of report.adoption.candidates) lines.push(`  Adopt ${item.path}:${item.line} → ${item.key} (${item.width}×${item.height}${item.measured === item.image ? '' : ' from ' + item.measured})`);
  for (const item of report.adoption.skipped) lines.push(`  Skip ${item.path}:${item.line}: ${item.reason}`);
  lines.push(...report.adoption.notes, ...report.notes);
  if (report.mode !== 'apply') lines.push('Rerun with --apply to write these files. Commit your work first so the changes are easy to review.');
  lines.push('', 'Next:', ...report.next.map((step, index) => `  ${index + 1}. ${step}`));
  for (const file of report.files) lines.push('', file.diff.trimEnd());
  return lines.join('\n') + '\n';
}
