import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { imageSize } from 'image-size';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const SOURCE_EXTENSIONS = new Set(['.swift', '.m', '.mm', '.h', '.kt', '.java', '.xml', '.dart', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.html', '.css', '.scss']);
const IGNORED_DIRECTORIES = new Set(['node_modules', 'vendor', 'Vendor', 'Pods', 'Carthage', 'build', 'Build', 'dist', 'out', 'coverage', 'DerivedData', 'target', 'graft']);
const DEFAULTS = Object.freeze({ longEdge: 2048, maxFiles: 2000, maxEntries: 20000, maxFileBytes: 32 * 1024 * 1024, maxBytes: 128 * 1024 * 1024, maxSourceFiles: 500, maxSourceBytes: 2 * 1024 * 1024, maxSourceFileBytes: 256 * 1024, maxHintsPerAsset: 10, maxDepth: 32 });
const CEILINGS = { longEdge: 100000, maxFiles: 10000, maxEntries: 100000, maxFileBytes: 128 * 1024 * 1024, maxBytes: 1024 * 1024 * 1024, maxSourceFiles: 2000, maxSourceBytes: 32 * 1024 * 1024, maxSourceFileBytes: 2 * 1024 * 1024, maxHintsPerAsset: 100, maxDepth: 64 };
const HISTORY_DEFAULTS = Object.freeze({ historyDays: 365, maxHistoryCommits: 20000, maxHistoryBytes: 64 * 1024 * 1024 });
const HISTORY_CEILINGS = { historyDays: 3650, maxHistoryCommits: 200000, maxHistoryBytes: 512 * 1024 * 1024 };
const DAY_SECONDS = 86400;
const MAX_DATE_SECONDS = 8.64e12;
const slash = value => value.split(path.sep).join('/');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const contained = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);
const utcDate = seconds => new Date(seconds * 1000).toISOString().slice(0, 10);

function configuration(options, defaults = DEFAULTS, ceilings = CEILINGS) {
  const config = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (options[key] !== undefined) config[key] = options[key];
    if (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > ceilings[key]) {
      throw new Error(`${key} must be an integer between 1 and ${ceilings[key]}.`);
    }
  }
  return config;
}

// Git is resolved from absolute PATH entries outside the audited checkout and outside any node_modules (npx and npm
// exec put a project's node_modules/.bin on PATH), so a git binary shipped by the audited code is never run.
// Returns null when no git is installed.
function gitExecutable(root) {
  const names = process.platform === 'win32' ? ['git.com', 'git.exe'] : ['git'];
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    let real;
    try { real = realpathSync(directory); } catch { continue; }
    if (contained(root, real) || real.split(path.sep).includes('node_modules')) continue;
    for (const name of names) {
      const candidate = path.join(real, name);
      try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate; } } catch {}
    }
  }
  return null;
}

// Local, read-only git. --no-lazy-fetch (git 2.44+) stops partial clones from fetching missing objects; a git without
// it fails instead. Inherited GIT_* variables are dropped so the audit root decides the repository, and signatures,
// pagers, external diffs, and fsmonitor are off so repository configuration cannot run programs.
function git(executable, root, args, maxBuffer) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' });
  const command = ['--no-lazy-fetch', '-C', root, '-c', 'protocol.allow=never', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'i18n.logOutputEncoding=UTF-8', '--no-pager', ...args];
  return new Promise((resolve, reject) => {
    execFile(executable, command, { env, maxBuffer, timeout: 120000, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

// History counts PNG/JPEG/WebP, SVG, asset-catalog PDF, and Lottie files. The density and appearance copies of one
// image (an asset-catalog set, Android resource qualifiers, @2x/@3x, Flutter 2.0x/3.0x) count as one image.
const IMAGE_SET = /\.(imageset|appiconset|iconset|icon|launchimage|brandassets|imagestack|symbolset|dataset)$/i;
const IMAGE_KINDS = ['artwork', 'iconsAndLogos', 'appIconsLaunchAndStore'];
// Paths here are relative to the repository, so asset-catalog folders above the audit root still count.
function artFormat(file) {
  const extension = path.posix.extname(file).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return 'raster';
  if (extension === '.svg' || (extension === '.pdf' && /\.imageset\//i.test(file))) return 'vector';
  if (extension === '.lottie' || (extension === '.json' && path.posix.basename(file) !== 'Contents.json' && /(^|\/|[-_.])(lottie|animations?|anims?)([-_./]|$)/i.test(file))) return 'animation';
  return null;
}
function logicalImage(file) {
  const segments = file.split('/');
  const set = segments.findIndex(segment => IMAGE_SET.test(segment));
  if (set >= 0) return segments.slice(0, set + 1).join('/');
  const name = path.posix.basename(file, path.posix.extname(file));
  const resource = segments.findIndex((segment, index) => index < segments.length - 1 && /^(drawable|mipmap)(-[^/]+)?$/.test(segment));
  if (resource >= 0) return [...segments.slice(0, resource), segments[resource].split('-')[0], name].join('/');
  return [...segments.slice(0, -1).filter(segment => !/^\d+(\.\d+)?x$/.test(segment)), name.replace(/@\d+(\.\d+)?x/i, '').replace(/~(ipad|iphone|car|mac|watch)$/i, '')].join('/');
}
// Path conventions only: an icon named for what it shows (box, gear) still counts as artwork.
function imageKind(image) {
  const segments = image.toLowerCase().split('/');
  const directories = segments.slice(0, -1);
  const last = segments[segments.length - 1];
  const name = last.replace(IMAGE_SET, '');
  const appIconSet = /\.(appiconset|iconset|icon|launchimage|brandassets)$/;
  if (appIconSet.test(last) || /^(ic_launcher|app[-_]?icon|adaptive[-_]?icon|launch[-_]?(screen|image|logo|background|icon))|splash|favicon/.test(name) || name === 'icon'
    || directories.some(directory => appIconSet.test(directory) || directory === 'mipmap' || /^(alternate[-_ ]?)?app[-_ ]?icons?\b|^launch[-_ ]?screen|^(screenshots?|fastlane|packaging|store[-_]?(assets|listing)?)$|(^|[-_])screenshots?$/.test(directory))) return 'appIconsLaunchAndStore';
  if (last.endsWith('.symbolset') || /^ic_|(^|[-_])icons?([-_]|$)|icon$|logo|wordmark/.test(name)
    || directories.some(directory => /^(icons?|glyphs?|symbols?|emojis?|flags?|logos?|badges?)$|(^|[-_.])(icons?|glyphs?|symbols?|logos?|emojis?)([-_.]|$)/.test(directory))) return 'iconsAndLogos';
  return 'artwork';
}

// Counts first-parent changes to in-scope images whose commit date falls in the window ending at HEAD's commit date.
// Reads only commit times, changed paths, and submodule paths: no messages, authors, hashes, or file contents.
async function imageHistory(root, assetPaths, config) {
  const history = { status: 'complete', reasons: [], basis: 'first_parent_of_checked_out_commit', window: null, changesUnderRoot: null, imageChanges: null, imageOnlyChanges: null, artwork: null, iconsAndLogos: null, appIconsLaunchAndStore: null, fileChangesByFormat: null, mostChangedArtwork: null, limits: config };
  const flag = (status, reason) => { if (history.status !== 'unavailable') history.status = status; history.reasons.push(reason); };
  const failure = error => error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'byte_limit' : error.killed ? 'timeout' : 'git_log_failed';
  const unavailable = reason => { flag('unavailable', reason); return { history, perPath: null }; };
  const executable = gitExecutable(root);
  if (!executable) return unavailable('git_unavailable');
  const run = (args, maxBuffer = 4096) => git(executable, root, args, maxBuffer);
  // A git older than 2.44 rejects --no-lazy-fetch with a usage error (exit 129).
  try { await run(['version']); } catch (error) { return unavailable(error.code === 129 && /unknown option/i.test(String(error.message)) ? 'git_too_old' : 'git_unavailable'); }
  let prefix;
  try {
    if ((await run(['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') return unavailable('not_a_git_work_tree');
    prefix = (await run(['rev-parse', '--show-prefix'])).replace(/\n$/, '');
  } catch { return unavailable('not_a_git_work_tree'); }
  let end;
  try { end = Number((await run(['log', '-1', '--format=%ct', 'HEAD', '--'])).trim()); }
  catch { return unavailable('no_commits'); }
  if (!Number.isSafeInteger(end)) return unavailable('no_commits');
  const start = end - config.historyDays * DAY_SECONDS;
  if (Math.abs(end) > MAX_DATE_SECONDS || Math.abs(start) > MAX_DATE_SECONDS) return unavailable('invalid_commit_date');
  history.window = { days: config.historyDays, start: utcDate(start), end: utcDate(end) };
  // Git paths and on-disk names are compared the way this checkout's git compares them.
  const setting = async name => { try { return (await run(['config', '--bool', '--get', name])).trim() === 'true'; } catch { return false; } };
  const precompose = await setting('core.precomposeunicode');
  const ignoreCase = await setting('core.ignorecase');
  const key = value => { const form = precompose ? value.normalize('NFC') : value; return ignoreCase ? form.toLowerCase() : form; };
  // A shallow clone's cut-off commits have no parents. If one is inside the window, older changes are missing, and the
  // cut-off commit itself is left out because git would report its whole tree as added.
  let cutOff = false;
  try {
    if ((await run(['rev-parse', '--is-shallow-repository'])).trim() !== 'false'
      && (await run(['log', '--first-parent', '--max-parents=0', '--format=%ct', 'HEAD', '--'], config.maxHistoryBytes)).trim().split('\n').some(time => Number(time) >= start)) { cutOff = true; flag('partial', 'shallow_clone'); }
  } catch { flag('partial', 'shallow_check_failed'); }
  let output;
  try {
    // --since-as-filter checks every first-parent commit's date instead of stopping at the first older one. The
    // pathspec keeps commits that changed nothing under the audit root out of the commit and byte limits.
    output = await run(['log', '-z', `--since-as-filter=@${Math.max(0, start)}`, `--max-count=${config.maxHistoryCommits + 1}`, '--first-parent', '--diff-merges=first-parent', cutOff ? '--min-parents=1' : '--root', '--no-renames', '--relative', '--name-status', '--no-ext-diff', '--no-textconv', '--no-color', '--no-show-signature', '--format=%x1e%ct', 'HEAD', '--', '.'], config.maxHistoryBytes);
  } catch (error) { flag('partial', failure(error)); return { history, perPath: null }; }
  // A header is read only where a status letter is expected, so a path containing U+001E cannot start a commit.
  const tokens = output.split('\0');
  const commits = [];
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index].replace(/^\n/, '');
    if (/^\x1e\d+$/.test(token)) { commits.push({ seconds: Number(token.slice(1)), files: [] }); index++; }
    else if (commits.length && /^[A-Z]\d*$/.test(token) && index + 1 < tokens.length) { commits[commits.length - 1].files.push(tokens[index + 1]); index += 2; }
    else index++;
  }
  if (!commits.length && output.trim()) { flag('partial', 'git_log_failed'); return { history, perPath: null }; }
  if (commits.length > config.maxHistoryCommits) { commits.length = config.maxHistoryCommits; flag('partial', 'commit_limit'); }
  const bases = assetPaths.map(key);
  const inScope = file => {
    const segments = file.split('/');
    if (segments.some(segment => segment.startsWith('.') || IGNORED_DIRECTORIES.has(segment))) return false;
    const name = key(file);
    return bases.some(base => base === '.' || name === base || name.startsWith(base + '/'));
  };
  // Changes inside a submodule belong to its own repository and are not counted here. Only directory and submodule
  // paths are listed, without object IDs. null means the check failed and no image can be ruled out.
  let submodules = [];
  try {
    submodules = (await run(['ls-tree', '-r', '-d', '-z', '--format=%(objectmode)%x09%(path)', 'HEAD'], config.maxHistoryBytes)).split('\0').filter(entry => entry.startsWith('160000\t')).map(entry => key(entry.slice(7)));
  } catch { flag('partial', 'submodule_check_failed'); submodules = null; }
  if (submodules?.some(submodule => inScope(submodule) || bases.some(base => base.startsWith(submodule + '/')))) flag('partial', 'submodules_not_counted');
  const kindSummary = () => ({ changes: 0, imageOnlyChanges: 0, images: 0, fileChanges: 0, maxImagesInOneChange: 0, monthsWithChanges: 0, changesByMonth: {} });
  Object.assign(history, { changesUnderRoot: 0, imageChanges: 0, imageOnlyChanges: 0, artwork: kindSummary(), iconsAndLogos: kindSummary(), appIconsLaunchAndStore: kindSummary(), fileChangesByFormat: { raster: 0, vector: 0, animation: 0 } });
  const perPath = new Map();
  const images = new Map();
  for (const { seconds, files: changed } of commits) {
    if (seconds < start || seconds > end || !changed.length) continue;
    history.changesUnderRoot++;
    const date = utcDate(seconds);
    const touched = Object.fromEntries(IMAGE_KINDS.map(kind => [kind, new Set()]));
    let files = 0, others = 0;
    for (const file of changed) {
      const repositoryPath = prefix + file;
      const format = inScope(file) ? artFormat(repositoryPath) : null;
      if (format) {
        files++;
        history.fileChangesByFormat[format]++;
        const logical = logicalImage(repositoryPath);
        const image = logical.startsWith(prefix) ? logical.slice(prefix.length) : logical;
        const kind = imageKind(logical);
        touched[kind].add(image);
        history[kind].fileChanges++;
        if (format === 'raster') {
          const entry = perPath.get(key(file)) ?? { changes: 0, lastChanged: null };
          entry.changes++;
          if (!entry.lastChanged || date > entry.lastChanged) entry.lastChanged = date;
          perPath.set(key(file), entry);
        }
      } else if (!(path.posix.basename(file) === 'Contents.json' && repositoryPath.split('/').some(segment => segment.endsWith('.xcassets')))) others++;
    }
    if (!files) continue;
    history.imageChanges++;
    if (!others) history.imageOnlyChanges++;
    for (const kind of IMAGE_KINDS) {
      if (!touched[kind].size) continue;
      const summary = history[kind];
      summary.changes++;
      if (!others) summary.imageOnlyChanges++;
      summary.maxImagesInOneChange = Math.max(summary.maxImagesInOneChange, touched[kind].size);
      summary.changesByMonth[date.slice(0, 7)] = (summary.changesByMonth[date.slice(0, 7)] ?? 0) + 1;
      for (const image of touched[kind]) {
        const entry = images.get(image) ?? { image, kind, changes: 0, lastChanged: null };
        entry.changes++;
        if (!entry.lastChanged || date > entry.lastChanged) entry.lastChanged = date;
        images.set(image, entry);
      }
    }
  }
  for (const kind of IMAGE_KINDS) {
    const summary = history[kind];
    summary.images = [...images.values()].filter(entry => entry.kind === kind).length;
    summary.changesByMonth = Object.fromEntries(Object.entries(summary.changesByMonth).sort(([a], [b]) => compare(a, b)));
    summary.monthsWithChanges = Object.keys(summary.changesByMonth).length;
  }
  history.mostChangedArtwork = [...images.values()].filter(entry => entry.kind === 'artwork').sort((a, b) => b.changes - a.changes || compare(a.image, b.image)).slice(0, 20).map(({ image, changes, lastChanged }) => ({ image, changes, lastChanged }));
  return { history, perPath, submodules, key };
}

// O_NOFOLLOW protects the leaf; realpath also rejects pre-existing symlinked ancestors.
// Run against a trusted, quiescent local checkout, not an adversarial shared filesystem.
async function readBounded(root, file, limit) {
  if (await realpath(file) !== file || !contained(root, file)) throw new Error('symlink_or_outside_root');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('not_regular_file');
    if (before.size > limit) throw new Error('byte_limit');
    const buffer = Buffer.alloc(before.size);
    let position = 0;
    while (position < buffer.length) {
      const { bytesRead } = await handle.read(buffer, position, buffer.length - position, position);
      if (!bytesRead) break;
      position += bytesRead;
    }
    const after = await handle.stat();
    if (position !== buffer.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('file_changed_during_scan');
    return buffer;
  } finally {
    await handle.close();
  }
}

/** Read-only, local audit. All returned paths are relative to root. */
export async function auditAssets(rootPath, options = {}) {
  const config = configuration(options);
  if (options.history !== undefined && typeof options.history !== 'boolean') throw new Error('history must be true or false.');
  const historyConfig = options.history ? configuration(options, HISTORY_DEFAULTS, HISTORY_CEILINGS) : null;
  const requestedRoot = path.resolve(rootPath);
  if (!(await lstat(requestedRoot)).isDirectory()) throw new Error('Root must be a real directory, not a symlink.');
  const root = await realpath(requestedRoot);
  async function selectedPaths(values, label, extensions) {
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value)) throw new Error(`${label} must be an array of nonempty paths.`);
    const result = [];
    for (const value of values) {
      const absolute = path.resolve(root, value);
      if (!contained(root, absolute)) throw new Error(`${label} paths must be inside the audit root.`);
      if (await realpath(absolute) !== absolute) throw new Error(`${label} paths must not contain symlinks.`);
      const segments = path.relative(root, absolute).split(path.sep).filter(Boolean);
      if (segments.some(segment => segment.startsWith('.') || IGNORED_DIRECTORIES.has(segment))) throw new Error(`${label} path is excluded by the default scan scope.`);
      const stat = await lstat(absolute);
      if (!stat.isDirectory() && (!stat.isFile() || !extensions.has(path.extname(absolute).toLowerCase()))) throw new Error(`${label} path must be a directory or supported regular file.`);
      result.push(absolute);
    }
    return result;
  }
  const referenceRoots = await selectedPaths(options.references ?? [], 'Reference', SOURCE_EXTENSIONS);
  const assetRoots = await selectedPaths(options.assets ?? ['.'], 'Asset', IMAGE_EXTENSIONS);
  if (!assetRoots.length) throw new Error('Choose at least one asset path.');
  const scanRoots = [...assetRoots, ...referenceRoots];
  const coverage = { status: 'complete_within_scope', entriesVisited: 0, imagesDiscovered: 0, imagesRead: 0, imageBytesRead: 0, sourceFilesDiscovered: 0, sourceFilesRead: 0, sourceBytesRead: 0, ignoredDirectories: 0, ignoredHiddenEntries: 0, excludedByPathSelection: 0, skippedSymlinks: 0, skippedNonRegularFiles: 0, issues: [] };
  const images = [];
  const sources = [];
  let traversalStopped = false;
  function issue(file, reason) {
    coverage.status = 'partial';
    coverage.issues.push({ path: slash(path.relative(root, file)) || '.', reason });
  }
  async function walk(directory, depth) {
    if (traversalStopped) return;
    if (depth > config.maxDepth) { issue(directory, 'depth_limit'); return; }
    let entries;
    try {
      if (await realpath(directory) !== directory) { issue(directory, 'symlink_directory_skipped'); return; }
      entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name));
    } catch { issue(directory, 'directory_unreadable'); return; }
    for (const entry of entries) {
      if (traversalStopped) break;
      const file = path.join(directory, entry.name);
      if (coverage.entriesVisited >= config.maxEntries) {
        issue(directory, 'entry_limit'); traversalStopped = true; break;
      }
      coverage.entriesVisited++;
      if (entry.isSymbolicLink()) { coverage.skippedSymlinks++; continue; }
      if (entry.name.startsWith('.')) { coverage.ignoredHiddenEntries++; continue; }
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) { coverage.ignoredDirectories++; continue; }
        if (!scanRoots.some(base => contained(base, file) || contained(file, base))) { coverage.excludedByPathSelection++; continue; }
        await walk(file, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (IMAGE_EXTENSIONS.has(ext) && assetRoots.some(base => contained(base, file))) {
          coverage.imagesDiscovered++;
          if (images.length < config.maxFiles) images.push(file);
          else issue(file, 'image_file_limit');
        }
        if (SOURCE_EXTENSIONS.has(ext) && referenceRoots.some(base => contained(base, file))) {
          coverage.sourceFilesDiscovered++;
          if (sources.length < config.maxSourceFiles) sources.push(file);
          else issue(file, 'source_file_limit');
        }
      } else coverage.skippedNonRegularFiles++;
    }
  }
  await walk(root, 0);
  const assets = [];
  for (const file of images.sort(compare)) {
    let buffer;
    try { buffer = await readBounded(root, file, Math.min(config.maxFileBytes, config.maxBytes - coverage.imageBytesRead)); }
    catch (error) { issue(file, error.message === 'byte_limit' ? 'image_byte_limit' : ['symlink_or_outside_root', 'file_changed_during_scan', 'not_regular_file'].includes(error.message) ? error.message : 'image_unreadable'); continue; }
    coverage.imagesRead++;
    coverage.imageBytesRead += buffer.length;
    let dimensions = null;
    let format = null;
    try {
      const result = imageSize(buffer);
      if (!['png', 'jpg', 'webp'].includes(result.type) || !result.width || !result.height) throw new Error();
      dimensions = { width: result.width, height: result.height };
      format = result.type === 'jpg' ? 'jpeg' : result.type;
    } catch { issue(file, 'dimensions_unavailable_or_unsupported_content'); }
    assets.push({ path: slash(path.relative(root, file)), bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), format, dimensions, dimensionCandidate: dimensions ? Math.max(dimensions.width, dimensions.height) > config.longEdge : false, references: { status: referenceRoots.length ? 'no_literal_reference_found' : 'not_scanned', hints: [], truncated: false } });
  }

  const tokenAssets = new Map();
  for (const asset of assets) {
    const basename = path.posix.basename(asset.path);
    for (const token of new Set([asset.path, basename, basename.slice(0, -path.posix.extname(basename).length)])) {
      if (!tokenAssets.has(token)) tokenAssets.set(token, []);
      tokenAssets.get(token).push(asset);
    }
  }
  for (const file of sources.sort(compare)) {
    let buffer;
    try { buffer = await readBounded(root, file, Math.min(config.maxSourceFileBytes, config.maxSourceBytes - coverage.sourceBytesRead)); }
    catch { issue(file, 'source_unreadable_or_byte_limit'); continue; }
    coverage.sourceFilesRead++;
    coverage.sourceBytesRead += buffer.length;
    // Literal hints only: no code execution, AST interpretation, or source text in output.
    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const found = new Set();
      for (const match of lines[index].matchAll(/(["'`])([^"'`\r\n\\]{1,512})\1/g)) {
        const token = match[2].replace(/^(\.\/|\/)/, '');
        for (const key of new Set([token, path.posix.basename(token)])) {
          for (const asset of tokenAssets.get(key) ?? []) found.add(asset);
        }
      }
      for (const asset of found) {
        asset.references.status = 'literal_reference_hint_found';
        if (asset.references.hints.length < config.maxHintsPerAsset) asset.references.hints.push({ path: slash(path.relative(root, file)), line: index + 1 });
        else asset.references.truncated = true;
      }
    }
  }
  const hashes = new Map();
  for (const asset of assets) {
    if (!hashes.has(asset.sha256)) hashes.set(asset.sha256, []);
    hashes.get(asset.sha256).push(asset);
  }
  const duplicateGroups = [...hashes.entries()].filter(([, items]) => items.length > 1).map(([sha256, items]) => ({ sha256, bytesPerCopy: items[0].bytes, extraCopyBytes: items[0].bytes * (items.length - 1), paths: items.map(item => item.path) }));
  const assetPaths = [...new Set(assetRoots.map(file => slash(path.relative(root, file)) || '.'))].sort(compare);
  let history = null;
  if (historyConfig) {
    const result = await imageHistory(root, assetPaths, historyConfig);
    history = result.history;
    for (const asset of assets) {
      const name = result.perPath ? result.key(asset.path) : null;
      const inSubmodule = !result.submodules || result.submodules.some(submodule => name.startsWith(submodule + '/'));
      asset.history = !result.perPath || inSubmodule ? null : result.perPath.get(name) ?? { changes: 0, lastChanged: null };
    }
    for (const reason of history.reasons) issue(root, `history_${reason}`);
  }
  return {
    schemaVersion: 1,
    scope: { root: '.', imageExtensions: [...IMAGE_EXTENSIONS], assetPaths, sourceExtensions: [...SOURCE_EXTENSIONS], referencePaths: [...new Set(referenceRoots.map(file => slash(path.relative(root, file)) || '.'))].sort(compare), ignoredDirectories: [...IGNORED_DIRECTORIES].sort(compare), hiddenEntries: 'excluded', symlinks: 'excluded', limits: config },
    coverage,
    summary: { assets: assets.length, measuredBytes: coverage.imageBytesRead, duplicateGroups: duplicateGroups.length, duplicateExtraCopyBytes: duplicateGroups.reduce((total, group) => total + group.extraCopyBytes, 0), dimensionCandidates: assets.filter(asset => asset.dimensionCandidate).length },
    assets,
    duplicateGroups,
    ...(history ? { history } : {}),
    interpretation: [
      'A dimension candidate exceeds the configured long-edge threshold. This does not establish wasted bytes or an appropriate replacement size.',
      'Exact duplicate bytes do not establish safe deletion or achievable app-download savings.',
      'Reference hints are quoted filename, basename, or relative-path matches, including comments and unrelated strings. They are not usage or rendering evidence.',
      'No literal reference found does not mean unused. Generated identifiers, dynamic references, asset-catalog names, remote configuration, and older app versions require separate investigation.',
      'Dimensions come from image headers; successful parsing is not full image validation. Width and height are encoded pixel dimensions, before EXIF orientation.',
      ...(history ? [
        'History counts changes on the first-parent line of the checked-out commit (a merge commit counts once with everything it brought in; a rebased or fast-forwarded pull request counts once per commit) that added, modified, or deleted an in-scope PNG, JPEG, WebP, SVG, asset-catalog PDF, or Lottie file during a window ending at that commit\'s date. Density and dark-mode copies of one image count once. It measures artwork churn in source control, not what users saw or whether a change could have shipped without an app release.',
        'Artwork, icons and logos, and app icons with launch and store art are told apart by path conventions only. An icon named for what it shows (such as box or gear) counts as artwork, and artwork with logo or icon in its name counts as icons and logos.',
        'An image-only change edited no other file under the audit root except asset-catalog Contents.json files. Changes that also edited code can still be artwork swaps, and image-only changes can still be cleanup.',
        'History reads commit times, changed paths, and submodule paths only: no commit messages, authors, hashes, or file contents.'
      ] : []),
      'Only the declared scope was examined. This report does not modify, upload, optimize, or delete any file.'
    ]
  };
}

// Paths come from the checkout; control characters are escaped so a file name cannot drive the terminal.
const printable = value => value.replace(/[\x00-\x1f\x7f-\x9f]/g, character => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`);

export function formatReport(report) {
  const { summary, coverage } = report;
  const lines = ['Assetlib local asset audit', '', `Coverage: ${coverage.status.replaceAll('_', ' ')}`, `${summary.assets} images · ${summary.measuredBytes.toLocaleString('en-US')} measured bytes`, `${summary.duplicateGroups} exact duplicate groups · ${summary.dimensionCandidates} dimension candidates`, `Source files examined: ${coverage.sourceFilesRead}; literal hints only.`, ''];
  for (const asset of report.assets.slice(0, 20)) {
    lines.push(`${printable(asset.path)} — ${asset.dimensions ? `${asset.dimensions.width}×${asset.dimensions.height}` : 'dimensions unavailable'} — ${asset.bytes} bytes${asset.dimensionCandidate ? ' — dimension candidate' : ''}`);
    if (asset.references.status === 'literal_reference_hint_found') {
      lines.push(`  Literal hints: ${asset.references.hints.slice(0, 3).map(hint => `${printable(hint.path)}:${hint.line}`).join(', ')}${asset.references.hints.length > 3 || asset.references.truncated ? ' (more hints; see JSON)' : ''}`);
    } else if (asset.references.status === 'no_literal_reference_found') lines.push('  No literal reference found in the examined source scope; usage unknown.');
  }
  if (report.assets.length > 20) lines.push(`… ${report.assets.length - 20} additional images; use --json for the complete bounded report.`);
  if (report.duplicateGroups.length) {
    lines.push('', 'Exact duplicate groups (review dependencies before changing files):');
    for (const group of report.duplicateGroups.slice(0, 20)) lines.push(`  ${group.paths.map(printable).join(' = ')}`);
  }
  const { history } = report;
  if (history && !history.artwork) lines.push('', `History not measured: ${history.reasons.join(', ').replaceAll('_', ' ')}.`);
  else if (history) {
    const { artwork, iconsAndLogos, appIconsLaunchAndStore, fileChangesByFormat: formats } = history;
    lines.push('', `History, ${history.window.days} days to ${history.window.end} (first-parent; density and dark-mode copies count once):`,
      `  Artwork: ${artwork.changes} of ${history.changesUnderRoot} changes under the root, ${artwork.imageOnlyChanges} of them image-only; ${artwork.images} image(s) in ${artwork.monthsWithChanges} month(s); the largest change touched ${artwork.maxImagesInOneChange}.`,
      `  Icons and logos: ${iconsAndLogos.changes} change(s), ${iconsAndLogos.images} image(s). App icons, launch and store art: ${appIconsLaunchAndStore.changes} change(s), ${appIconsLaunchAndStore.images} image(s).`,
      `  Files changed: ${formats.raster} PNG/JPEG/WebP, ${formats.vector} SVG/PDF, ${formats.animation} Lottie.`);
    if (history.mostChangedArtwork.length) {
      lines.push('Most changed artwork:');
      for (const entry of history.mostChangedArtwork.slice(0, 10)) lines.push(`  ${printable(entry.image)} — ${entry.changes} change(s), last ${entry.lastChanged}`);
    }
  }
  if (coverage.issues.length) {
    lines.push('', `Partial coverage: ${coverage.issues.length} issue(s).`);
    for (const issue of coverage.issues.slice(0, 20)) lines.push(`  ${printable(issue.path)}: ${issue.reason}`);
  }
  lines.push('', ...report.interpretation);
  return lines.join('\n') + '\n';
}
