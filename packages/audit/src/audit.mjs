import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { imageSize } from 'image-size';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const SOURCE_EXTENSIONS = new Set(['.swift', '.m', '.mm', '.h', '.kt', '.java', '.xml', '.dart', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.html', '.css', '.scss']);
const IGNORED_DIRECTORIES = new Set(['node_modules', 'vendor', 'Vendor', 'Pods', 'Carthage', 'build', 'Build', 'dist', 'out', 'coverage', 'DerivedData', 'target', 'graft']);
const DEFAULTS = Object.freeze({ longEdge: 2048, maxFiles: 2000, maxEntries: 20000, maxFileBytes: 32 * 1024 * 1024, maxBytes: 128 * 1024 * 1024, maxSourceFiles: 500, maxSourceBytes: 2 * 1024 * 1024, maxSourceFileBytes: 256 * 1024, maxHintsPerAsset: 10, maxDepth: 32 });
const CEILINGS = { longEdge: 100000, maxFiles: 10000, maxEntries: 100000, maxFileBytes: 128 * 1024 * 1024, maxBytes: 1024 * 1024 * 1024, maxSourceFiles: 2000, maxSourceBytes: 32 * 1024 * 1024, maxSourceFileBytes: 2 * 1024 * 1024, maxHintsPerAsset: 100, maxDepth: 64 };
const slash = value => value.split(path.sep).join('/');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const contained = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);

function configuration(options) {
  const config = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (options[key] !== undefined) config[key] = options[key];
    if (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > CEILINGS[key]) {
      throw new Error(`${key} must be an integer between 1 and ${CEILINGS[key]}.`);
    }
  }
  return config;
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
  return {
    schemaVersion: 1,
    scope: { root: '.', imageExtensions: [...IMAGE_EXTENSIONS], assetPaths: [...new Set(assetRoots.map(file => slash(path.relative(root, file)) || '.'))].sort(compare), sourceExtensions: [...SOURCE_EXTENSIONS], referencePaths: [...new Set(referenceRoots.map(file => slash(path.relative(root, file)) || '.'))].sort(compare), ignoredDirectories: [...IGNORED_DIRECTORIES].sort(compare), hiddenEntries: 'excluded', symlinks: 'excluded', limits: config },
    coverage,
    summary: { assets: assets.length, measuredBytes: coverage.imageBytesRead, duplicateGroups: duplicateGroups.length, duplicateExtraCopyBytes: duplicateGroups.reduce((total, group) => total + group.extraCopyBytes, 0), dimensionCandidates: assets.filter(asset => asset.dimensionCandidate).length },
    assets,
    duplicateGroups,
    interpretation: [
      'A dimension candidate exceeds the configured long-edge threshold. This does not establish wasted bytes or an appropriate replacement size.',
      'Exact duplicate bytes do not establish safe deletion or achievable app-download savings.',
      'Reference hints are quoted filename, basename, or relative-path matches, including comments and unrelated strings. They are not usage or rendering evidence.',
      'No literal reference found does not mean unused. Generated identifiers, dynamic references, asset-catalog names, remote configuration, and older app versions require separate investigation.',
      'Dimensions come from image headers; successful parsing is not full image validation. Width and height are encoded pixel dimensions, before EXIF orientation.',
      'Only the declared scope was examined. This report does not modify, upload, optimize, or delete any file.'
    ]
  };
}

export function formatReport(report) {
  const { summary, coverage } = report;
  const lines = ['Assetlib local asset audit', '', `Coverage: ${coverage.status.replaceAll('_', ' ')}`, `${summary.assets} images · ${summary.measuredBytes.toLocaleString('en-US')} measured bytes`, `${summary.duplicateGroups} exact duplicate groups · ${summary.dimensionCandidates} dimension candidates`, `Source files examined: ${coverage.sourceFilesRead}; literal hints only.`, ''];
  for (const asset of report.assets.slice(0, 20)) {
    lines.push(`${asset.path} — ${asset.dimensions ? `${asset.dimensions.width}×${asset.dimensions.height}` : 'dimensions unavailable'} — ${asset.bytes} bytes${asset.dimensionCandidate ? ' — dimension candidate' : ''}`);
    if (asset.references.status === 'literal_reference_hint_found') {
      lines.push(`  Literal hints: ${asset.references.hints.slice(0, 3).map(hint => `${hint.path}:${hint.line}`).join(', ')}${asset.references.hints.length > 3 || asset.references.truncated ? ' (more hints; see JSON)' : ''}`);
    } else if (asset.references.status === 'no_literal_reference_found') lines.push('  No literal reference found in the examined source scope; usage unknown.');
  }
  if (report.assets.length > 20) lines.push(`… ${report.assets.length - 20} additional images; use --json for the complete bounded report.`);
  if (report.duplicateGroups.length) {
    lines.push('', 'Exact duplicate groups (review dependencies before changing files):');
    for (const group of report.duplicateGroups.slice(0, 20)) lines.push(`  ${group.paths.join(' = ')}`);
  }
  if (coverage.issues.length) {
    lines.push('', `Partial coverage: ${coverage.issues.length} issue(s).`);
    for (const issue of coverage.issues.slice(0, 20)) lines.push(`  ${issue.path}: ${issue.reason}`);
  }
  lines.push('', ...report.interpretation);
  return lines.join('\n') + '\n';
}
