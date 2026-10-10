import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

// Keep these scopes and budgets aligned with packages/audit/src/audit.mjs.
const SOURCE_EXTENSIONS = new Set(['.swift', '.m', '.mm', '.h', '.kt', '.java', '.xml', '.dart', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.html', '.css', '.scss']);
const IGNORED_DIRECTORIES = new Set(['node_modules', 'vendor', 'Vendor', 'Pods', 'Carthage', 'build', 'Build', 'dist', 'out', 'coverage', 'DerivedData', 'target', 'graft']);
const LIMITS = Object.freeze({ entries: 20000, files: 500, fileBytes: 256 * 1024, totalBytes: 2 * 1024 * 1024, depth: 32, references: 200 });
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const slash = value => value.split(path.sep).join('/');
const contained = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
const generated = name => /\.generated\./i.test(name) || name === 'AppAssets.kt';
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'Podfile.lock', 'Package.resolved', 'composer.lock']);
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// As in the audit, do not follow links and reject files that change during a read.
// The checkout should be quiescent; this is not a sandbox for hostile filesystems.
async function readBounded(root, file, limit) {
  if (!contained(root, file) || await realpath(file) !== file) throw new Error('symlink_or_outside_root');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) throw new Error('source_unreadable_or_byte_limit');
    const buffer = Buffer.alloc(before.size);
    let position = 0;
    while (position < buffer.length) {
      const { bytesRead } = await handle.read(buffer, position, buffer.length - position, position);
      if (!bytesRead) break;
      position += bytesRead;
    }
    const after = await handle.stat();
    if (position !== buffer.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('file_changed_during_scan');
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

/** Location hints only: source contents are never returned or sent to the console. */
export async function scanReferences({ catalog, references = [], root: rootOption, catalogPath }) {
  const result = { codeReferences: [], partial: false, issues: [] };
  if (!references.length) return result;
  const requestedRoot = path.resolve(rootOption ?? path.dirname(path.resolve(catalogPath)));
  if (!(await lstat(requestedRoot)).isDirectory()) throw new Error('Reference root must be a real directory, not a symlink.');
  const root = await realpath(requestedRoot);
  const normalize = absolute => {
    if (contained(requestedRoot, absolute)) return path.resolve(root, path.relative(requestedRoot, absolute));
    if (contained(root, absolute)) return absolute;
    throw new Error('Catalog and reference paths must be inside the reference root; use --root to select a common parent directory.');
  };
  const catalogFile = normalize(path.resolve(catalogPath));
  const selected = [];
  for (const value of references) {
    const absolute = normalize(path.resolve(value));
    if (await realpath(absolute) !== absolute) throw new Error('Reference paths must not contain symlinks.');
    const segments = path.relative(root, absolute).split(path.sep).filter(Boolean);
    if (segments.some(segment => segment.startsWith('.') || IGNORED_DIRECTORIES.has(segment))) {
      throw new Error('Reference path is excluded by the default scan scope.');
    }
    const stat = await lstat(absolute);
    if (!stat.isDirectory() && (!stat.isFile() || !SOURCE_EXTENSIONS.has(path.extname(absolute).toLowerCase()))) {
      throw new Error('Reference path must be a directory or supported regular source file.');
    }
    selected.push(absolute);
  }
  const sources = [];
  let entriesVisited = 0;
  let traversalStopped = false;
  function issue(file, reason) {
    result.partial = true;
    result.issues.push({ path: slash(path.relative(root, file)) || '.', reason });
  }
  async function walk(directory, depth) {
    if (traversalStopped) return;
    if (depth > LIMITS.depth) { issue(directory, 'depth_limit'); return; }
    let entries;
    try {
      if (await realpath(directory) !== directory) { issue(directory, 'symlink_directory_skipped'); return; }
      // The slash matters: a.ts must sort before a/z.ts, even though a < a.ts.
      entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        compare(a.name + (a.isDirectory() ? '/' : ''), b.name + (b.isDirectory() ? '/' : '')));
    } catch { issue(directory, 'directory_unreadable'); return; }
    for (const entry of entries) {
      if (traversalStopped) break;
      if (entriesVisited >= LIMITS.entries) { issue(directory, 'entry_limit'); traversalStopped = true; break; }
      entriesVisited++;
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        if (!selected.some(base => contained(base, file) || contained(file, base))) continue;
        await walk(file, depth + 1);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !generated(entry.name)) {
        // The catalog declares keys; it is not a call site. Lockfiles are large and never reference placements.
        if (file === catalogFile || LOCKFILES.has(entry.name)) continue;
        if (!selected.some(base => contained(base, file))) continue;
        if (sources.length < LIMITS.files) sources.push(file);
        else issue(file, 'source_file_limit');
      }
    }
  }
  await walk(root, 0);

  const keys = new Set(catalog.placements.map(placement => placement.key));
  const forms = catalog.placements.map(({ symbol }) => {
    const canonical = ['AppAssets', 'AssetCatalog', 'artwork'].map(prefix => [prefix, ...symbol].join('.'));
    if (symbol.length !== 2) return { canonical, derived: [] };
    // The Swift generator takes two segments: AppArtwork lower-camels the group and adds a <member>Artwork method.
    const accessor = `artwork.${symbol[0][0].toLowerCase()}${symbol[0].slice(1)}.${symbol[1]}`;
    return { canonical, derived: [accessor, `${accessor}Artwork`] };
  });
  const producers = new Map();
  forms.forEach(({ canonical, derived }, index) => {
    for (const form of [...canonical, ...derived]) producers.set(form, (producers.get(form) ?? new Set()).add(index));
  });
  const symbols = catalog.placements.map(({ key }, index) => {
    // A derived form that another placement can also produce is ambiguous, so it is never credited.
    const accepted = new Set([...forms[index].canonical, ...forms[index].derived.filter(form => producers.get(form).size === 1)]);
    return { key, pattern: new RegExp(`(?<![A-Za-z0-9_$])(?:${[...accepted].map(escapeRegex).join('|')})(?![A-Za-z0-9_$])`) };
  });
  let bytesRead = 0;
  for (const file of sources.sort(compare)) {
    const relative = slash(path.relative(root, file));
    // POSIX paths cannot represent a literal backslash portably across checkouts.
    if (relative.length > 300 || relative.includes('\\') || relative.split('/').includes('..')) {
      issue(file, 'reference_path_limit');
      continue;
    }
    let buffer;
    try { buffer = await readBounded(root, file, Math.min(LIMITS.fileBytes, LIMITS.totalBytes - bytesRead)); }
    catch (error) {
      issue(file, ['symlink_or_outside_root', 'file_changed_during_scan'].includes(error.message) ? error.message : 'source_unreadable_or_byte_limit');
      continue;
    }
    bytesRead += buffer.length;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const found = new Set();
      for (const match of lines[index].matchAll(/(["'`])([^"'`\r\n\\]{1,512})\1/g)) {
        if (keys.has(match[2])) found.add(match[2]);
      }
      for (const symbol of symbols) if (symbol.pattern.test(lines[index])) found.add(symbol.key);
      for (const key of [...found].sort(compare)) {
        if (index + 1 > 1000000) { issue(file, 'reference_line_limit'); continue; }
        if (result.codeReferences.length === LIMITS.references) {
          issue(file, 'reference_limit');
          return result;
        }
        result.codeReferences.push({ key, path: relative, line: index + 1 });
      }
    }
  }
  return result;
}
