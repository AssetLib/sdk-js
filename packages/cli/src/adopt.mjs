import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { imageSize } from 'image-size';
import { generateCatalog } from './codegen.mjs';
import { formatCatalog } from './catalog.mjs';

// Match the local audit's conservative source and image budgets.
const LIMITS = { entries: 20000, files: 500, fileBytes: 256 * 1024, totalBytes: 2 * 1024 * 1024, depth: 32, imageBytes: 32 * 1024 * 1024, totalImageBytes: 128 * 1024 * 1024 };
const IGNORED = new Set(['node_modules', 'vendor', 'Pods', 'Carthage', 'build', 'Build', 'dist', 'out', 'coverage', 'DerivedData', 'target', 'graft']);
const EXTENSIONS = new Set(['.tsx', '.jsx', '.ts', '.js']);
const IMAGE = /\.(?:png|jpe?g|webp)$/i;
const slash = value => value.split(path.sep).join('/');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const contained = (root, file) => file === root || file.startsWith(root + path.sep);
const quote = value => JSON.stringify(value);
const relativeImport = (file, target) => {
  const value = slash(path.relative(path.dirname(file), target)).replace(/\.(?:tsx?|jsx?|mjs|cjs)$/, '');
  return value.startsWith('.') ? value : './' + value;
};

async function readBounded(root, file, limit) {
  if (!contained(root, file) || await realpath(file) !== file) throw new Error('symlink-or-outside-root');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) throw new Error('unreadable-or-byte-limit');
    const buffer = Buffer.alloc(before.size);
    let position = 0;
    while (position < buffer.length) {
      const { bytesRead } = await handle.read(buffer, position, buffer.length - position, position);
      if (!bytesRead) break;
      position += bytesRead;
    }
    const after = await handle.stat();
    if (position !== buffer.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('file-changed-during-scan');
    return buffer;
  } finally { await handle.close(); }
}

async function safeDestination(root, file) {
  if (!contained(root, file)) throw new Error('Adopt output paths must stay inside the catalog directory.');
  let ancestor = file;
  while (true) {
    try {
      const stat = await lstat(ancestor);
      if (stat.isSymbolicLink() || await realpath(ancestor) !== ancestor) throw new Error('Adopt does not follow symlinks.');
      if (ancestor === file && !stat.isFile() || ancestor !== file && !stat.isDirectory()) throw new Error('Adopt output must be a regular file.');
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = path.dirname(ancestor);
    }
  }
}

async function sourceFiles(root, selected, generated, report) {
  const files = new Set(), visited = new Set();
  let entries = 0, stopped = false;
  const issue = (file, reason) => report.issues.push({ path: slash(path.relative(root, file)), line: 1, reason });
  async function walk(directory, depth) {
    if (stopped || visited.has(directory)) return;
    visited.add(directory);
    if (depth > LIMITS.depth) { issue(directory, 'depth-limit'); return; }
    let children;
    try {
      if (await realpath(directory) !== directory) { issue(directory, 'symlink-directory'); return; }
      children = (await readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name));
    } catch { issue(directory, 'directory-unreadable'); return; }
    for (const entry of children) {
      if (stopped) break;
      if (++entries > LIMITS.entries) { issue(directory, 'entry-limit'); stopped = true; break; }
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (!IGNORED.has(entry.name)) await walk(file, depth + 1);
      } else if (entry.isFile() && EXTENSIONS.has(path.extname(file).toLowerCase()) && !/\.generated\./i.test(entry.name) && file !== generated) {
        if (files.size < LIMITS.files) files.add(file);
        else issue(file, 'source-file-limit');
      }
    }
  }
  for (const directory of selected.sort(compare)) {
    if (!contained(root, directory)) throw new Error('--src must be inside the catalog directory.');
    if (path.relative(root, directory).split(path.sep).some(part => part.startsWith('.') || IGNORED.has(part))) throw new Error('--src is excluded by the default scan scope.');
    if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new Error('--src must be a real directory without symlinks.');
    await walk(directory, 0);
  }
  return [...files].sort(compare);
}

function parseSource(file, text) {
  // TSX also enables JSX for .ts and .js source files without loading a project or executing code.
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const host = {
    getSourceFile: name => name === file ? source : undefined,
    getDefaultLibFileName: () => '', writeFile() {}, getCurrentDirectory: () => path.dirname(file),
    getDirectories: () => [], fileExists: name => name === file, readFile: name => name === file ? text : undefined,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  };
  const program = ts.createProgram([file], { noLib: true, noResolve: true, allowJs: true, jsx: ts.JsxEmit.Preserve }, host);
  const checker = program.getTypeChecker(), identifiers = [], requires = [], imports = [];
  function visit(node) {
    if (ts.isIdentifier(node)) identifiers.push(node);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') requires.push(node);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause && !clause.isTypeOnly) {
        if (clause.name) imports.push({ module: node.moduleSpecifier.text, exported: 'default', name: clause.name, symbol: checker.getSymbolAtLocation(clause.name) });
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const item of clause.namedBindings.elements) {
          if (!item.isTypeOnly) imports.push({ module: node.moduleSpecifier.text, exported: item.propertyName?.text ?? item.name.text, name: item.name, symbol: checker.getSymbolAtLocation(item.name) });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { source, checker, identifiers, requires, imports };
}

function jsxAttribute(expression) {
  const jsx = expression.parent;
  return jsx && ts.isJsxExpression(jsx) && jsx.expression === expression && ts.isJsxAttribute(jsx.parent) ? jsx.parent : undefined;
}
function openingOf(attribute) {
  const opening = attribute?.parent?.parent;
  return opening && (ts.isJsxSelfClosingElement(opening) || ts.isJsxOpeningElement(opening)) ? opening : undefined;
}
function alreadyAdopted(expression, info) {
  const opening = openingOf(jsxAttribute(expression));
  if (!opening || !ts.isIdentifier(opening.tagName)) return false;
  return info.imports.some(item => item.module === '@assetlib/sdk-expo' && item.exported === 'AssetlibImage' && info.checker.getSymbolAtLocation(opening.tagName) === item.symbol) || opening.tagName.text === 'AssetlibImage';
}
function reasonFor(call) {
  for (let node = call.parent; node && !ts.isSourceFile(node); node = node.parent) {
    if (ts.isConditionalExpression(node)) return 'conditional-expression';
    if (ts.isObjectLiteralExpression(node)) return 'object-property';
    if (ts.isArrayLiteralExpression(node)) return 'array-element';
    if (ts.isCallExpression(node)) return 'non-jsx-call';
  }
  return 'unsupported-source';
}
function findCandidate(call, info) {
  const { checker, identifiers } = info;
  if (alreadyAdopted(call, info)) return { ignored: true };
  let expression = call;
  if (ts.isVariableDeclaration(call.parent) && call.parent.initializer === call) {
    const declaration = call.parent, list = declaration.parent, statement = list.parent;
    if (!ts.isIdentifier(declaration.name) || !ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const) || !ts.isVariableStatement(statement) || !ts.isSourceFile(statement.parent)) return { reason: 'non-module-const' };
    const symbol = checker.getSymbolAtLocation(declaration.name);
    const uses = identifiers.filter(node => {
      if (node === declaration.name) return false;
      const parent = node.parent;
      const target = ts.isShorthandPropertyAssignment(parent) && parent.name === node
        ? checker.getShorthandAssignmentValueSymbol(parent)
        : ts.isExportSpecifier(parent) && (parent.propertyName ?? parent.name) === node
          ? checker.getExportSpecifierLocalTargetSymbol(parent) : checker.getSymbolAtLocation(node);
      return target === symbol;
    });
    if (uses.length !== 1) return { reason: uses.length > 1 ? 'multiple-uses' : 'unused-identifier' };
    expression = uses[0];
    if (alreadyAdopted(expression, info)) return { ignored: true };
  }
  const attribute = jsxAttribute(expression), opening = openingOf(attribute);
  if (!attribute || attribute.name.text !== 'source' || !opening) return { reason: reasonFor(expression) };
  if (!ts.isIdentifier(opening.tagName) || opening.tagName.text !== 'Image' || !info.imports.some(item => ['react-native', 'expo-image'].includes(item.module) && item.exported === 'Image' && item.name.text === 'Image' && checker.getSymbolAtLocation(opening.tagName) === item.symbol)) return { reason: 'image-not-imported' };
  if (opening.attributes.properties.filter(item => ts.isJsxAttribute(item) && item.name.text === 'source').length !== 1 || opening.attributes.properties.some(item => ts.isJsxAttribute(item) && ['client', 'asset', 'fallback'].includes(item.name.text))) return { reason: 'attribute-conflict' };
  if (checker.getSymbolAtLocation(call.expression)) return { reason: 'shadowed-require' };
  return { attribute, opening, expression };
}

function words(value) { return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').split(/[^A-Za-z0-9]+/).filter(Boolean).map(word => word.toLowerCase()); }
function names(file, image) {
  const screen = path.basename(file, path.extname(file)).replace(/Screen$/, '').toLowerCase();
  const parts = words(path.basename(image, path.extname(image)));
  return { screen, key: `${screen}.${parts.join('-')}`, symbol: [words(screen).map(word => word[0].toUpperCase() + word.slice(1)).join(''), parts.map((word, index) => index ? word[0].toUpperCase() + word.slice(1) : word).join('')] };
}
function symbolOverlap(a, b) { return a.slice(0, Math.min(a.length, b.length)).every((value, index) => value === b[index]); }

function editSource(info, candidates, generated, clientModule, clientExport) {
  const { source, identifiers, imports, checker } = info;
  const edits = [], additions = [], taken = new Set(identifiers.map(node => node.text));
  function addImport(module, exported, preferred) {
    const existing = imports.find(item => item.module === module && item.exported === exported && !identifiers.some(node => node.text === item.name.text && checker.getSymbolAtLocation(node) !== item.symbol));
    if (existing) return existing.name.text;
    let name = preferred, suffix = 2;
    while (taken.has(name)) name = preferred + suffix++;
    taken.add(name);
    additions.push(exported === 'default' ? `import ${name} from ${quote(module)};` : `import { ${exported}${name !== exported ? ' as ' + name : ''} } from ${quote(module)};`);
    return name;
  }
  const imageName = addImport('@assetlib/sdk-expo', 'AssetlibImage', 'AssetlibImage');
  const assetsName = addImport(relativeImport(source.fileName, generated), 'AppAssets', 'AppAssets');
  const clientName = addImport(clientModule, clientExport, clientExport === 'default' ? 'client' : clientExport);
  for (const candidate of candidates) {
    const { opening, attribute, expression, placement } = candidate;
    edits.push({ start: opening.tagName.getStart(source), end: opening.tagName.end, text: imageName });
    if (ts.isJsxOpeningElement(opening)) edits.push({ start: opening.parent.closingElement.tagName.getStart(source), end: opening.parent.closingElement.tagName.end, text: imageName });
    edits.push({ start: attribute.getStart(source), end: attribute.end, text: `client={${clientName}} asset={${assetsName}.${placement.symbol.join('.')}} fallback={${expression.getText(source)}}` });
  }
  if (additions.length) {
    const newline = source.text.includes('\r\n') ? '\r\n' : '\n';
    // Keep a shebang and directive prologue (such as "use client") in their original position.
    let position = source.text.startsWith('#!') ? source.text.indexOf('\n') + 1 : 0;
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) || ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) position = statement.end;
      else break;
    }
    edits.push({ start: position, end: position, text: (position && !source.text.slice(0, position).endsWith('\n') ? newline : '') + additions.join(newline) + newline });
  }
  let text = source.text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}

// One bounded unified hunk between the first and last changes; unchanged outer lines stay out of the report.
function diff(file, before, after) {
  const split = text => {
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.map((line, index) => ({ text: line, newline: index < lines.length - 1 || text.endsWith('\n') }));
  };
  const a = split(before ?? ''), b = split(after);
  const equal = (left, right) => left.text === right.text && left.newline === right.newline;
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && equal(a[prefix], b[prefix])) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && equal(a[a.length - 1 - suffix], b[b.length - 1 - suffix])) suffix++;
  const start = Math.max(0, prefix - 3), aEnd = Math.min(a.length, a.length - suffix + 3), bEnd = Math.min(b.length, b.length - suffix + 3);
  const lines = [`--- ${before === null ? '/dev/null' : 'a/' + file}`, `+++ b/${file}`, `@@ -${aEnd === start ? 0 : start + 1},${aEnd - start} +${bEnd === start ? 0 : start + 1},${bEnd - start} @@`];
  const add = (line, marker) => {
    lines.push(marker + line.text);
    if (!line.newline) lines.push('\\ No newline at end of file');
  };
  for (let i = start; i < prefix; i++) add(a[i], ' ', i, a, before);
  for (let i = prefix; i < a.length - suffix; i++) add(a[i], '-', i, a, before);
  for (let i = prefix; i < b.length - suffix; i++) add(b[i], '+', i, b, after);
  for (let i = a.length - suffix; i < aEnd; i++) add(a[i], ' ', i, a, before);
  return lines.join('\n') + '\n';
}

/** Plan in memory first, then optionally write the fully validated plan. Never invokes Git or a network request. */
export async function adopt({ catalogPath, catalog, src, generated: generatedOption, clientImport = './src/assetlib/client#client', minEdge = 64, apply = false }) {
  if (!Number.isSafeInteger(minEdge) || minEdge < 1 || minEdge > 8192) throw new Error('--min-edge must be an integer from 1 to 8192.');
  if (!src?.length) throw new Error('At least one --src directory is required.');
  const requestedRoot = path.dirname(path.resolve(catalogPath)), root = await realpath(requestedRoot);
  const normalize = file => contained(requestedRoot, file) ? path.resolve(root, path.relative(requestedRoot, file)) : file;
  catalogPath = normalize(path.resolve(catalogPath));
  const generated = normalize(generatedOption ? path.resolve(generatedOption) : path.join(root, 'src/assets.generated.ts'));
  await safeDestination(root, catalogPath);
  await safeDestination(root, generated);
  if (generated === catalogPath) throw new Error('--generated must differ from --catalog.');
  const match = /^(.+)#([A-Za-z_$][\w$]*)$/.exec(clientImport);
  if (!match) throw new Error('--client-import must be <module>#<export>.');
  const [, clientSpecifier, clientExport] = match;
  if (clientExport !== 'default' && ts.createSourceFile('client.ts', `export const ${clientExport} = 1;`, ts.ScriptTarget.Latest).parseDiagnostics.length) throw new Error('--client-import export must be a valid binding name or default.');
  if (clientExport === 'await' || clientExport === 'yield') throw new Error('--client-import export must be a valid binding name or default.');
  const localClient = clientSpecifier.startsWith('.') || path.isAbsolute(clientSpecifier);
  const clientBase = localClient ? normalize(path.resolve(root, clientSpecifier)) : null;
  let clientFile = null, clientExists = false;
  if (localClient) {
    await safeDestination(root, path.extname(clientBase) ? clientBase : clientBase + '.ts');
    for (const candidate of [clientBase, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].map(ext => clientBase + ext), ...['.ts', '.tsx', '.js', '.jsx'].map(ext => path.join(clientBase, 'index' + ext))]) {
      try { if ((await lstat(candidate)).isFile()) { await safeDestination(root, candidate); clientFile = candidate; clientExists = true; break; } }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    clientFile ??= path.extname(clientBase) ? clientBase : clientBase + '.ts';
    if (clientFile === generated || clientFile === catalogPath) throw new Error('Catalog, generated output, and client module must be different files.');
  }
  const report = { mode: apply ? 'apply' : 'dry-run', summary: {}, candidates: [], skipped: [], collisions: [], issues: [], files: [], notes: ['Dimensions are encoded pixel sizes. Check @2x/@3x sources before accepting placement dimensions.'] };
  const files = await sourceFiles(root, src.map(value => normalize(path.resolve(value))), generated, report);
  const nextCatalog = structuredClone(catalog), originals = new Map(), sourcePlans = [], imageCache = new Map(), runKeys = new Map();
  let bytesRead = 0, imageBytesRead = 0, reused = 0;
  for (const file of files) {
    let text;
    try { const buffer = await readBounded(root, file, Math.min(LIMITS.fileBytes, LIMITS.totalBytes - bytesRead)); bytesRead += buffer.length; text = buffer.toString('utf8'); }
    catch (error) { report.issues.push({ path: slash(path.relative(root, file)), line: 1, reason: error.code === 'ENOENT' ? 'source-missing' : error.message }); continue; }
    const info = parseSource(file, text), selected = [];
    const location = node => ({ path: slash(path.relative(root, file)), line: info.source.getLineAndCharacterOfPosition(node.getStart(info.source)).line + 1 });
    if (info.source.parseDiagnostics.length) { report.issues.push({ path: slash(path.relative(root, file)), line: 1, reason: 'source-parse-error' }); continue; }
    for (const call of info.requires) {
      const argument = call.arguments[0];
      const skip = (reason, extra = {}) => report.skipped.push({ ...location(call), reason, ...extra });
      if (call.arguments.length !== 1 || !argument || !ts.isStringLiteral(argument)) {
        if (alreadyAdopted(call, info)) continue;
        skip(argument && (ts.isTemplateExpression(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) ? 'template-string' : 'dynamic-path'); continue;
      }
      if (!IMAGE.test(argument.text)) continue;
      const candidate = findCandidate(call, info);
      if (candidate.ignored) continue;
      if (candidate.reason) { skip(candidate.reason); continue; }
      if (!argument.text.startsWith('./') && !argument.text.startsWith('../')) { skip('non-relative-path'); continue; }
      const image = path.resolve(path.dirname(file), argument.text);
      if (!contained(root, image)) { skip('image-outside-root'); continue; }
      if (/icon|splash|adaptive-icon|mark|logo|brand/i.test(path.basename(image)) || path.relative(root, image).split(path.sep).slice(0, -1).some(part => part.toLowerCase() === 'icons')) { skip('essential'); continue; }
      let size = imageCache.get(image);
      if (!size) {
        try {
          const bytes = await readBounded(root, image, Math.min(LIMITS.imageBytes, LIMITS.totalImageBytes - imageBytesRead)); imageBytesRead += bytes.length;
          const measured = imageSize(bytes);
          if (!['png', 'jpg', 'webp'].includes(measured.type)) throw new Error('unsupported-content');
          size = { width: measured.width, height: measured.height }; imageCache.set(image, size);
        } catch (error) { skip(error.code === 'ENOENT' ? 'image-missing' : error.message === 'symlink-or-outside-root' || error.message === 'unreadable-or-byte-limit' || error.message === 'file-changed-during-scan' ? error.message : 'dimensions-unavailable'); continue; }
      }
      if (size.width < minEdge && size.height < minEdge) { skip('icon-sized'); continue; }
      const naming = names(file, image), base = { ...naming, ...size };
      let placement = catalog.placements.find(item => item.key === base.key);
      if (placement && (placement.width !== size.width || placement.height !== size.height)) { skip('catalog-dimension-conflict', { key: base.key }); continue; }
      if (placement) reused++;
      else {
        const runKey = base.key + '\0' + image;
        const previous = runKeys.get(runKey);
        if (previous) placement = previous;
        else {
          placement = { key: base.key, symbol: base.symbol, width: size.width, height: size.height, screen: base.screen };
          let suffix = 1;
          while (nextCatalog.placements.some(item => item.key === placement.key || symbolOverlap(item.symbol, placement.symbol))) {
            suffix++;
            placement = { ...placement, key: `${base.key}-${suffix}`, symbol: [base.symbol[0], base.symbol[1] + suffix] };
            // A pre-existing namespace leaf cannot be escaped by changing only the leaf name.
            if (nextCatalog.placements.some(item => item.symbol.length === 1 && item.symbol[0] === placement.symbol[0])) placement.symbol[0] += suffix;
          }
          if (suffix > 1) report.collisions.push({ ...location(call), originalKey: base.key, key: placement.key, symbol: placement.symbol });
          try { generateCatalog({ ...nextCatalog, placements: [...nextCatalog.placements, placement] }); }
          catch (error) { skip(nextCatalog.placements.length >= 100 ? 'placement-limit' : 'invalid-catalog-name-or-dimensions', { detail: error.message }); continue; }
          nextCatalog.placements.push(placement);
          runKeys.set(runKey, placement);
        }
      }
      selected.push({ ...candidate, placement });
      report.candidates.push({ ...location(call), image: slash(path.relative(root, image)), key: placement.key, symbol: placement.symbol, ...size, reused: catalog.placements.includes(placement) });
    }
    if (selected.length) { originals.set(file, text); sourcePlans.push({ file, info, selected }); }
  }
  const plans = [];
  async function plan(file, after) {
    await safeDestination(root, file);
    let before = originals.get(file);
    if (before === undefined) {
      try { before = (await readBounded(root, file, LIMITS.totalBytes)).toString('utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; before = null; }
    }
    if (before !== after) plans.push({ file, before, after });
  }
  if (report.candidates.length) {
    const originalCatalog = (await readBounded(root, catalogPath, 128 * 1024)).toString('utf8');
    if (JSON.stringify(JSON.parse(originalCatalog)) !== JSON.stringify(catalog)) throw new Error('Catalog changed during adoption; rerun the command.');
    originals.set(catalogPath, originalCatalog);
    const catalogText = formatCatalog(nextCatalog, originalCatalog);
    if (Buffer.byteLength(catalogText) > 128 * 1024) throw new Error('Updated catalog exceeds 128 KiB.');
    const generatedText = generateCatalog(nextCatalog);
    for (const source of sourcePlans) await plan(source.file, editSource(source.info, source.selected, generated, localClient ? relativeImport(source.file, clientBase) : clientSpecifier, clientExport));
    await plan(catalogPath, catalogText);
    await plan(generated, generatedText);
    if (localClient && !clientExists) {
      const configModule = relativeImport(clientFile, path.join(root, 'assetlib.public.json'));
      await plan(clientFile, `// Review this starter client before running the app.\n// Download the app's public SDK config to assetlib.public.json; never put API tokens here.\nimport { createExpoAssetClient } from '@assetlib/sdk-expo';\nimport { parsePublicConfig } from '@assetlib/sdk-core';\n\nconst config = parsePublicConfig(require(${quote(configModule)}));\n${clientExport === 'default' ? 'export default' : 'export const ' + clientExport + ' ='} createExpoAssetClient(config);\n`);
      report.notes.push(`${apply ? 'Created' : 'Would create'} client stub: ${slash(path.relative(root, clientFile))}. Review the public config before running the app.`);
    }
  }
  plans.sort((a, b) => compare(a.file, b.file));
  if (new Set(plans.map(item => item.file)).size !== plans.length) throw new Error('Adopt output paths overlap source edits.');
  if (apply) {
    // Recheck the entire plan before any mutation, avoiding stale-source overwrites.
    for (const item of plans) {
      await safeDestination(root, item.file);
      let current;
      try { current = (await readBounded(root, item.file, LIMITS.totalBytes)).toString('utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; current = null; }
      if (current !== item.before) throw new Error('A planned file changed during adoption; rerun the command.');
    }
    for (const item of plans) {
      await mkdir(path.dirname(item.file), { recursive: true });
      await writeFile(item.file, item.after, { flag: item.before === null ? 'wx' : 'w' });
    }
  }
  report.files = plans.map(item => ({ path: slash(path.relative(root, item.file)), created: item.before === null, diff: diff(slash(path.relative(root, item.file)), item.before, item.after) }));
  report.summary = { sourceFiles: files.length, candidates: report.candidates.length, placementsAdded: nextCatalog.placements.length - catalog.placements.length, placementsReused: reused, skipped: report.skipped.length, collisions: report.collisions.length, filesChanged: plans.length, scanIssues: report.issues.length };
  return report;
}

export function formatAdoption(report) {
  const summary = report.summary;
  const lines = [`Assetlib adopt ${report.mode === 'apply' ? 'applied' : 'dry run'}`, `${summary.candidates} candidates; ${summary.placementsAdded} placements added; ${summary.placementsReused} existing placements reused; ${summary.skipped} skipped; ${summary.filesChanged} files ${report.mode === 'apply' ? 'changed' : 'would change'}.`];
  for (const item of report.candidates) lines.push(`  Adopt ${item.path}:${item.line} → ${item.key} (${item.width}×${item.height})`);
  for (const item of report.skipped) lines.push(`  Skip ${item.path}:${item.line}: ${item.reason}${item.key ? ' (' + item.key + ')' : ''}`);
  for (const item of report.collisions) lines.push(`  Collision ${item.path}:${item.line}: ${item.originalKey} → ${item.key} (${item.symbol.join('.')})`);
  for (const item of report.issues) lines.push(`  Scan issue ${item.path}:${item.line}: ${item.reason}`);
  lines.push(...report.notes);
  for (const file of report.files) lines.push('', file.diff.trimEnd());
  return lines.join('\n') + '\n';
}
