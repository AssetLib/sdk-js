import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { IGNORED_DIRECTORIES, readBounded, scanReferences } from './references.mjs';

// The route walk and the parse share the reference scan's budgets; hops bounds the import chain followed from a route file.
export const LIMITS = Object.freeze({ entries: 20000, files: 500, fileBytes: 256 * 1024, totalBytes: 2 * 1024 * 1024, depth: 32, hops: 3 });
const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];
const PLATFORM = /\.(?:ios|android|native|web)$/;
// Expo Router ignores +html, +native-intent, +api and +middleware files; every other `+` file except +not-found is invalid there too.
const NOT_ROUTES = /^\+(?!not-found$)/;
const NAVIGATORS = new Set(['Stack', 'Tabs', 'Drawer']);
const METHODS = new Set(['push', 'replace', 'navigate']);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const slash = value => value.split(path.sep).join('/');
const contained = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
const isGroup = segment => /^\(.*\)$/.test(segment);
const isDynamic = segment => /^\[.*\]$/.test(segment);
const fromExpoRouter = binding => binding.module === 'expo-router' || binding.module.startsWith('expo-router/');
// A link to another app or site is not navigation inside this one, and its text never enters the report.
const literal = (value, conditional) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value) ? { kind: 'external', conditional } : value.length > 300 ? { kind: 'dynamic', conditional } : { kind: 'literal', value, conditional };

/** `(tabs)/trip/[id]` -> /trip/[id]; `_layout` is the layout of its directory; `index` is the directory's own route. */
export function routeOf(name) {
  const segments = name.split('/');
  const leaf = segments.pop();
  const kind = leaf === '_layout' ? 'layout' : 'route';
  const visible = segments.filter(segment => !isGroup(segment));
  if (kind === 'route' && leaf !== 'index') visible.push(leaf);
  return { kind, route: '/' + visible.join('/'), groups: segments.filter(isGroup).map(segment => segment.slice(1, -1)) };
}

/** Expo Router semantics: an href starting with `.` resolves against the current route like a URL; anything else is absolute. */
export function normalizeTarget(value, fromRoute) {
  let target = value.replace(/[?#][^]*$/, '');
  target = target.startsWith('.') ? path.posix.resolve(path.posix.dirname(fromRoute), target) : '/' + target.replace(/^\/+/, '');
  return '/' + path.posix.normalize(target).split('/').filter(segment => segment && !isGroup(segment)).join('/');
}

/** The best route for a target: static segments beat dynamic ones; `[*]` (a template substitution) matches only a dynamic segment. */
export function matchRoute(target, nodes) {
  const wanted = target.split('/').filter(Boolean);
  let best = null, bestScore = -1;
  for (const node of nodes) {
    if (node.kind !== 'route' || node.route.endsWith('/+not-found')) continue;
    const have = node.route.split('/').filter(Boolean);
    let score = 0, ok = true, rest = false;
    for (let index = 0; index < have.length && ok; index++) {
      if (have[index].startsWith('[...')) { ok = wanted.length > index; rest = true; break; }
      if (index >= wanted.length) ok = false;
      else if (isDynamic(have[index])) score += 1;
      else if (have[index] === wanted[index] && wanted[index] !== '[*]') score += 2;
      else ok = false;
    }
    if (ok && !rest && wanted.length !== have.length) ok = false;
    if (ok && score > bestScore) { best = node; bestScore = score; }
  }
  return best;
}

// Literal targets of an href or router argument. A conditional contributes each branch; a template whose substitutions
// each fill a whole segment becomes `[*]` segments; everything else is dynamic and keeps only its location.
function targetsOf(node, conditional = false) {
  if (!node) return [{ kind: 'dynamic', conditional }];
  if (ts.isJsxExpression(node)) return targetsOf(node.expression, conditional);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) return targetsOf(node.expression, conditional);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [literal(node.text, conditional)];
  if (ts.isTemplateExpression(node)) {
    const text = (node.head.text + node.templateSpans.map(span => '\0' + span.literal.text).join('')).replace(/[?#][^]*$/, '');
    const whole = text.split('/').every(segment => !segment.includes('\0') || segment === '\0');
    return whole ? [literal(text.replaceAll('\0', '[*]'), conditional)] : [{ kind: 'dynamic', conditional }];
  }
  if (ts.isObjectLiteralExpression(node)) {
    const pathname = node.properties.find(property => ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === 'pathname');
    return pathname ? targetsOf(pathname.initializer, conditional) : [{ kind: 'dynamic', conditional }];
  }
  if (ts.isConditionalExpression(node)) return [...targetsOf(node.whenTrue, true), ...targetsOf(node.whenFalse, true)];
  if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) return [...targetsOf(node.left, true), ...targetsOf(node.right, true)];
  return [{ kind: 'dynamic', conditional }];
}

function bindingNames(name, out = []) {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const element of name.elements) if (ts.isBindingElement(element)) bindingNames(element.name, out);
  return out;
}

// An identifier that reads a value or type, not one that names something.
function isReference(id) {
  const parent = id.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isQualifiedName(parent) && parent.right === id) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false;
  if (ts.isJsxAttribute(parent) || ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  if ('name' in parent && parent.name === id && (ts.isParameter(parent) || ts.isVariableDeclaration(parent) || ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) || ts.isClassExpression(parent) ||
      ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent) || ts.isEnumMember(parent) || ts.isTypeParameterDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isEnumDeclaration(parent) || ts.isModuleDeclaration(parent))) return false;
  return true;
}
function referencesIn(node, out = new Set()) {
  if (ts.isIdentifier(node) && isReference(node)) out.add(node.text);
  ts.forEachChild(node, child => { referencesIn(child, out); });
  return out;
}
const isUseRouterCall = node => {
  while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) node = node.expression;
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useRouter';
};
const jsxAttribute = (element, wanted) => element.attributes.properties.find(property => ts.isJsxAttribute(property) && ts.isIdentifier(property.name) && property.name.text === wanted)?.initializer;

/** One file's declarations with their references, its imports and exports, navigation calls and screen registrations. */
export function parseSource(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lineOf = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const info = { imports: new Map(), reexports: [], exports: new Map(), declarations: [], byName: new Map(), navigators: [], registrations: [], loose: { navs: [], refs: [] } };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!ts.isStringLiteral(statement.moduleSpecifier) || !clause || clause.isTypeOnly) continue;
      const module = statement.moduleSpecifier.text;
      if (clause.name) info.imports.set(clause.name.text, { module, exported: 'default' });
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) info.imports.set(clause.namedBindings.name.text, { module, exported: '*' });
      else if (clause.namedBindings) for (const element of clause.namedBindings.elements) if (!element.isTypeOnly) info.imports.set(element.name.text, { module, exported: (element.propertyName ?? element.name).text });
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const module = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
      if (!statement.exportClause) { if (module) info.reexports.push({ exported: '*', module, imported: '*' }); continue; }
      if (ts.isNamespaceExport(statement.exportClause)) { if (module) info.reexports.push({ exported: statement.exportClause.name.text, module, imported: '*' }); continue; }
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        const local = (element.propertyName ?? element.name).text;
        if (module) info.reexports.push({ exported: element.name.text, module, imported: local });
        else info.exports.set(element.name.text, local);
      }
      continue;
    }
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) continue;
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
    const exported = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) || ts.isExportAssignment(statement);
    let names = [];
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) names = [statement.name?.text ?? (isDefault ? 'default' : null)].filter(name => name !== null);
    else if (ts.isVariableStatement(statement)) names = statement.declarationList.declarations.flatMap(declaration => bindingNames(declaration.name));
    else if (ts.isExportAssignment(statement) && !statement.isExportEquals) names = ['default'];
    const declaration = {
      names, start: statement.getStart(source), end: statement.end,
      startLine: lineOf(statement), endLine: source.getLineAndCharacterOfPosition(statement.end).line + 1,
      references: referencesIn(statement), navs: [], refs: [],
    };
    info.declarations.push(declaration);
    for (const name of names) info.byName.set(name, declaration);
    if (exported || ts.isExportAssignment(statement)) for (const name of names) info.exports.set(isDefault ? 'default' : name, name);
  }
  const owner = position => info.declarations.find(declaration => position >= declaration.start && position < declaration.end) ?? info.loose;
  // Link, Redirect, the navigators and `router` count by name unless the file imports that name from somewhere other than
  // expo-router or declares it at module scope itself.
  const component = name => {
    const binding = info.imports.get(name);
    if (binding) return fromExpoRouter(binding) ? binding.exported : null;
    return info.byName.has(name) ? null : name;
  };
  // Identifiers bound to useRouter(), and destructured push, replace and navigate, collected before the calls are read.
  const routers = new Set(), methods = new Map();
  for (const [local, binding] of info.imports) if (fromExpoRouter(binding) && binding.exported === 'router') routers.add(local);
  if (component('router') === 'router') routers.add('router');
  (function bindings(node) {
    if (ts.isVariableDeclaration(node) && node.initializer && isUseRouterCall(node.initializer)) {
      if (ts.isIdentifier(node.name)) routers.add(node.name.text);
      else if (ts.isObjectBindingPattern(node.name)) for (const element of node.name.elements) {
        const property = element.propertyName ?? element.name;
        if (ts.isIdentifier(property) && METHODS.has(property.text) && ts.isIdentifier(element.name)) methods.set(element.name.text, property.text);
      }
    }
    ts.forEachChild(node, bindings);
  })(source);
  const nav = (node, call, targets) => owner(node.getStart(source)).navs.push({ call, line: lineOf(node), pos: node.getStart(source), targets });
  (function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && METHODS.has(callee.name.text) && (ts.isIdentifier(callee.expression) && routers.has(callee.expression.text) || isUseRouterCall(callee.expression))) nav(node, `router.${callee.name.text}`, targetsOf(node.arguments[0]));
      else if (ts.isIdentifier(callee) && methods.has(callee.text)) nav(node, `router.${methods.get(callee.text)}`, targetsOf(node.arguments[0]));
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;
      if (ts.isIdentifier(tag)) {
        const name = component(tag.text);
        if (name === 'Link' || name === 'Redirect') nav(node, name, targetsOf(jsxAttribute(node, 'href')));
        if (NAVIGATORS.has(name) || name === 'Slot') info.navigators.push({ name, line: lineOf(node) });
      } else if (ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression) && tag.name.text === 'Screen') {
        info.registrations.push({ call: `${tag.expression.text}.Screen`, line: lineOf(node), targets: targetsOf(jsxAttribute(node, 'name')) });
      }
    }
    ts.forEachChild(node, visit);
  })(source);
  return info;
}

/**
 * Expo Router routes as nodes, navigation edges, and the catalog's placements attributed to routes. Reads source only,
 * inside the root, within the reference scan's budgets; the report holds locations, never source contents.
 */
export async function map({ catalog, catalogPath, root: rootOption, app: appOption, src = [] }) {
  const requestedRoot = path.resolve(rootOption ?? path.dirname(path.resolve(catalogPath)));
  if (!(await lstat(requestedRoot)).isDirectory()) throw new Error('Root must be a real directory, not a symlink.');
  const root = await realpath(requestedRoot);
  const rel = file => slash(path.relative(root, file));
  const normalize = absolute => {
    if (contained(requestedRoot, absolute)) return path.resolve(root, path.relative(requestedRoot, absolute));
    if (contained(root, absolute)) return absolute;
    throw new Error('The app and source directories must be inside the root; use --root to select a common parent directory.');
  };
  const realDirectory = async directory => { try { return (await lstat(directory)).isDirectory() && await realpath(directory) === directory; } catch { return false; } };
  let appDir;
  if (appOption) {
    appDir = normalize(path.resolve(appOption));
    if (!(await realDirectory(appDir))) throw new Error('--app must be a real directory without symlinks.');
  } else {
    for (const candidate of ['src/app', 'app'].map(name => path.join(root, name))) if (await realDirectory(candidate)) { appDir = candidate; break; }
    if (!appDir) throw new Error('No Expo Router app directory (app or src/app) under the root; pass --app <dir>.');
  }
  const scope = [appDir, ...(src.length ? src.map(value => normalize(path.resolve(value))) : [path.dirname(appDir)])];
  const excluded = file => path.relative(root, file).split(path.sep).some(segment => segment.startsWith('.') || IGNORED_DIRECTORIES.has(segment));
  const report = { partial: false, issues: [] };
  const issue = (file, reason) => {
    report.partial = true;
    const entry = { path: rel(file) || '.', reason };
    if (!report.issues.some(item => item.path === entry.path && item.reason === entry.reason)) report.issues.push(entry);
  };

  // Route files, as Expo Router names them. The walk is bounded like the reference scan and never follows links.
  const found = [];
  let entries = 0, stopped = false;
  async function walk(directory, depth) {
    if (stopped) return;
    if (depth > LIMITS.depth) { issue(directory, 'depth_limit'); return; }
    let children;
    try {
      if (await realpath(directory) !== directory) { issue(directory, 'symlink_directory_skipped'); return; }
      children = (await readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name + (a.isDirectory() ? '/' : ''), b.name + (b.isDirectory() ? '/' : '')));
    } catch { issue(directory, 'directory_unreadable'); return; }
    for (const entry of children) {
      if (stopped) break;
      if (entries >= LIMITS.entries) { issue(directory, 'entry_limit'); stopped = true; break; }
      entries++;
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(file, depth + 1); continue; }
      if (!entry.isFile() || !EXTENSIONS.includes(path.extname(entry.name).toLowerCase()) || /\.d\.ts$/i.test(entry.name) || /\.generated\./i.test(entry.name)) continue;
      const name = slash(path.relative(appDir, file)).replace(/\.[^.]+$/, '');
      const base = path.posix.basename(name).replace(PLATFORM, '');
      if (NOT_ROUTES.test(base) || /\+api$/.test(base)) continue;
      if (found.length < LIMITS.files) found.push({ file, name });
      else issue(file, 'source_file_limit');
    }
  }
  await walk(appDir, 0);
  // index.ios.tsx and index.tsx are one route; the unsuffixed file stands for it when present.
  const byName = new Map();
  for (const { file, name } of found) {
    const key = name.replace(PLATFORM, '');
    if (!byName.has(key) || name === key) byName.set(key, file);
  }
  const nodes = [...byName].map(([name, file]) => ({ ...routeOf(name), name, file, rel: rel(file), directory: path.posix.dirname(name), layout: null, placements: [] })).sort((a, b) => compare(a.rel, b.rel));
  const layoutsByDirectory = new Map(nodes.filter(node => node.kind === 'layout').map(node => [node.directory, node]));
  for (const node of nodes) {
    // Routes are hoisted to the nearest _layout up the directory tree; a layout's parent is the next one above it.
    let directory = node.kind === 'layout' ? (node.directory === '.' ? null : path.posix.dirname(node.directory)) : node.directory;
    while (directory !== null) {
      if (layoutsByDirectory.has(directory)) { node.layout = layoutsByDirectory.get(directory); break; }
      directory = directory === '.' ? null : path.posix.dirname(directory);
    }
  }
  const nodesByName = new Map(nodes.map(node => [node.name, node]));

  // The CLI's own reference matcher. A generated symbol is a use; a quoted key is a mention and attributes nothing.
  const scan = await scanReferences({ catalog, catalogPath, root: requestedRoot, references: scope, withForms: true });
  if (scan.partial) for (const item of scan.issues) issue(path.join(root, ...item.path.split('/')), item.reason);
  const refsByFile = new Map();
  const mentions = [], symbols = [];
  for (const { form, path: file, ...reference } of scan.codeReferences) {
    if (form === 'literal') { mentions.push({ ...reference, file }); continue; }
    symbols.push({ ...reference, file });
    const absolute = path.join(root, ...file.split('/'));
    if (!refsByFile.has(absolute)) refsByFile.set(absolute, []);
    refsByFile.get(absolute).push(reference);
  }

  // Bounded, memoized reads and parses. A budget hit or an unreadable file is an issue, and that file contributes nothing.
  const parsed = new Map();
  let filesRead = 0, bytesRead = 0;
  async function load(file) {
    if (parsed.has(file)) return parsed.get(file);
    let info = null;
    if (filesRead >= LIMITS.files) issue(file, 'source_file_limit');
    else {
      try {
        const buffer = await readBounded(root, file, Math.min(LIMITS.fileBytes, LIMITS.totalBytes - bytesRead));
        filesRead++; bytesRead += buffer.length;
        info = parseSource(file, buffer.toString('utf8'));
        for (const reference of refsByFile.get(file) ?? []) {
          const declaration = info.declarations.find(item => reference.line >= item.startLine && reference.line <= item.endLine) ?? info.loose;
          declaration.refs.push({ key: reference.key, line: reference.line });
        }
      } catch (error) {
        issue(file, ['symlink_or_outside_root', 'file_changed_during_scan'].includes(error.message) ? error.message : 'source_unreadable_or_byte_limit');
      }
    }
    parsed.set(file, info);
    return info;
  }
  // Relative specifiers and the `@/` alias, inside the scanned directories only. The alias is `compilerOptions.paths["@/*"]`
  // of the root's tsconfig.json when it has one; otherwise `src` when the app directory is `src/app`, else the root.
  let aliases = null;
  async function aliasBases() {
    if (aliases) return aliases;
    aliases = [path.dirname(appDir)];
    try {
      const text = (await readBounded(root, path.join(root, 'tsconfig.json'), LIMITS.fileBytes)).toString('utf8');
      const paths = ts.parseConfigFileTextToJson('tsconfig.json', text).config?.compilerOptions?.paths?.['@/*'];
      if (Array.isArray(paths)) aliases = paths.filter(value => typeof value === 'string' && value.endsWith('/*')).map(value => path.resolve(root, value.slice(0, -2)));
    } catch { /* no tsconfig, or one the alias cannot be read from */ }
    return aliases;
  }
  const resolved = new Map();
  async function resolveImport(from, specifier) {
    let bases;
    if (/^\.\.?(?:\/|$)/.test(specifier)) bases = [path.resolve(path.dirname(from), specifier)];
    else if (specifier.startsWith('@/')) bases = (await aliasBases()).map(base => path.join(base, ...specifier.slice(2).split('/')));
    else return null;
    const key = bases.join('\0');
    if (resolved.has(key)) return resolved.get(key);
    let target = null;
    for (const candidate of bases.flatMap(base => [base, ...EXTENSIONS.map(extension => base + extension), ...EXTENSIONS.map(extension => path.join(base, 'index' + extension))])) {
      if (!EXTENSIONS.includes(path.extname(candidate).toLowerCase()) || /\.generated\./i.test(path.basename(candidate)) || !scope.some(directory => contained(directory, candidate)) || excluded(candidate)) continue;
      try { if ((await lstat(candidate)).isFile()) { target = candidate; break; } } catch { /* try the next form */ }
    }
    resolved.set(key, target);
    return target;
  }

  // What a node leads to: everything in its own file, then what the bindings it imports lead to, through at most
  // LIMITS.hops files. A call or reference inside an exported function or constant is credited to the files that import
  // that export (directly, through a re-export, or as part of a namespace), not to every file that imports the module.
  async function collect(node) {
    const navs = [], refs = [];
    const queue = [{ file: node.file, local: null, hops: LIMITS.hops, via: [] }];
    const seenFiles = new Map(), seenDeclarations = new Map();
    const fresh = (store, key, hops) => { if ((store.get(key) ?? -1) >= hops) return false; store.set(key, hops); return true; };
    while (queue.length) {
      const { file, hops, via } = queue[0];
      let { local, exported } = queue.shift();
      const info = await load(file);
      if (!info) continue;
      const follow = async (module, name) => {
        if (hops === 0) return;
        const target = await resolveImport(file, module);
        if (target) queue.push({ file: target, exported: name, hops: hops - 1, via: [...via, rel(target)] });
      };
      if (exported !== undefined) {
        if (exported === '*') local = null;
        else if (info.exports.has(exported)) local = info.exports.get(exported);
        else {
          for (const reexport of info.reexports) {
            if (reexport.exported === exported) await follow(reexport.module, reexport.imported);
            else if (reexport.exported === '*') await follow(reexport.module, exported);
          }
          continue;
        }
      }
      const emit = declaration => {
        for (const item of declaration.navs) navs.push({ ...item, file, via });
        for (const item of declaration.refs) refs.push({ ...item, file, via });
      };
      if (local === null) {
        if (!fresh(seenFiles, file, hops)) continue;
        for (const declaration of info.declarations) if (fresh(seenDeclarations, declaration, hops)) emit(declaration);
        emit(info.loose);
        for (const binding of info.imports.values()) await follow(binding.module, binding.exported);
        for (const reexport of info.reexports) await follow(reexport.module, reexport.imported);
        continue;
      }
      const declaration = info.byName.get(local);
      if (!declaration) { if (info.imports.has(local)) await follow(info.imports.get(local).module, info.imports.get(local).exported); continue; }
      if (!fresh(seenDeclarations, declaration, hops)) continue;
      emit(declaration);
      for (const name of declaration.references) {
        if (info.byName.has(name) && info.byName.get(name) !== declaration) queue.push({ file, local: name, hops, via });
        else if (info.imports.has(name)) await follow(info.imports.get(name).module, info.imports.get(name).exported);
      }
    }
    // The same call can be reached along several chains; keep the shortest.
    const shortest = (items, identity) => {
      const best = new Map();
      for (const item of items) { const key = identity(item); if (!best.has(key) || best.get(key).via.length > item.via.length) best.set(key, item); }
      return [...best.values()].sort((a, b) => compare(a.file, b.file) || a.line - b.line || compare(identity(a), identity(b)));
    };
    return { navs: shortest(navs, item => `${item.file}\0${item.pos}\0${item.call}`), refs: shortest(refs, item => `${item.file}\0${item.line}\0${item.key}`) };
  }

  const edges = [], edgeKeys = new Set();
  const edge = item => {
    const key = JSON.stringify([item.from, item.to, item.target, item.kind, item.call, item.file, item.line]);
    if (!edgeKeys.has(key)) { edgeKeys.add(key); edges.push(item); }
  };
  for (const node of nodes) {
    const { navs, refs } = await collect(node);
    node.placements = refs.map(item => ({ key: item.key, file: rel(item.file), line: item.line, via: item.via }));
    for (const nav of navs) for (const target of nav.targets) {
      const location = { call: nav.call, file: rel(nav.file), line: nav.line, via: nav.via };
      if (target.kind === 'external') continue;
      if (target.kind === 'dynamic') edge({ from: node.rel, to: null, target: null, kind: 'dynamic', ...location });
      else {
        const normalized = normalizeTarget(target.value, node.route);
        edge({ from: node.rel, to: matchRoute(normalized, nodes)?.rel ?? null, target: normalized, kind: target.conditional ? 'conditional' : 'literal', ...location });
      }
    }
    if (node.kind !== 'layout') continue;
    const info = parsed.get(node.file);
    if (!info) continue;
    // A registration names a file relative to the layout's directory: `index`, `(tabs)` (its layout), `trip/[id]`.
    const registered = new Set();
    for (const registration of info.registrations) for (const target of registration.targets) {
      if (target.kind !== 'literal') continue;
      const name = path.posix.normalize(path.posix.join(node.directory, target.value));
      const child = nodesByName.get(name) ?? nodesByName.get(`${name}/_layout`) ?? nodesByName.get(`${name}/index`) ?? null;
      if (child) registered.add(child);
      edge({ from: node.rel, to: child?.rel ?? null, target: child ? child.route : target.value, kind: 'screen', call: registration.call, file: node.rel, line: registration.line, via: [] });
    }
    // Tabs and Drawer show every route hoisted to them; a Stack opens on its index route. Slot enumerates nothing.
    const navigator = info.navigators.find(item => item.name === 'Tabs' || item.name === 'Drawer') ?? info.navigators.find(item => item.name === 'Stack');
    if (!navigator) continue;
    for (const child of nodes) {
      if (child.layout !== node || registered.has(child)) continue;
      if (navigator.name === 'Stack' && child.name !== path.posix.normalize(path.posix.join(node.directory, 'index'))) continue;
      edge({ from: node.rel, to: child.rel, target: child.route, kind: 'navigator', call: navigator.name, file: node.rel, line: navigator.line, via: [] });
    }
  }
  for (const node of nodes) {
    if (node.kind !== 'route') continue;
    node.entry = node.route === '/';
    node.unlinked = !node.entry && !node.route.endsWith('/+not-found') && !edges.some(item => item.to === node.rel && item.from !== node.rel);
  }

  const attributed = new Set(nodes.flatMap(node => node.placements.map(item => `${item.file}\0${item.line}\0${item.key}`)));
  const unattributed = symbols.filter(item => !attributed.has(`${item.file}\0${item.line}\0${item.key}`));
  const placements = catalog.placements.map(({ key }) => ({
    key,
    routes: [...new Set(nodes.filter(node => node.kind === 'route' && node.placements.some(item => item.key === key)).map(node => node.route))],
    layouts: nodes.filter(node => node.kind === 'layout' && node.placements.some(item => item.key === key)).map(node => node.rel),
  }));
  const routes = nodes.map(node => ({
    route: node.route, file: node.rel, kind: node.kind, groups: node.groups, layout: node.layout?.rel ?? null,
    ...(node.kind === 'route' ? { entry: node.entry, unlinked: node.unlinked } : { navigators: [...new Set((parsed.get(node.file)?.navigators ?? []).map(item => item.name))] }),
    placements: node.placements,
  }));
  return {
    schemaVersion: 1,
    app: rel(appDir) || '.',
    routes,
    edges,
    placements,
    mentions,
    unattributed,
    summary: {
      routes: routes.filter(node => node.kind === 'route').length,
      layouts: routes.filter(node => node.kind === 'layout').length,
      edges: edges.length,
      dynamicEdges: edges.filter(item => item.kind === 'dynamic').length,
      unlinkedRoutes: routes.filter(node => node.unlinked).length,
      references: symbols.length,
      mentions: mentions.length,
      unattributed: unattributed.length,
      unroutedPlacements: placements.filter(item => !item.routes.length && !item.layouts.length).length,
    },
    partial: report.partial,
    issues: report.issues,
  };
}

/** The same report as a Mermaid flowchart: layouts, routes, placements, and the edges between them. */
export function formatMermaid(report) {
  const quote = text => `"${String(text).replaceAll('"', "'")}"`;
  const ids = new Map(report.routes.map((node, index) => [node.file, `n${index}`]));
  const lines = ['flowchart LR',
    '  classDef layout fill:#eef1ea,stroke:#9aa39b,color:#1f2a22',
    '  classDef route fill:#ffffff,stroke:#3b5b4a,color:#1f2a22',
    '  classDef placement fill:#f6f1e4,stroke:#8a6d3b,color:#1f2a22',
    '  classDef flagged stroke:#b04a3a,stroke-dasharray: 4 2'];
  for (const node of report.routes) {
    if (node.kind === 'layout') lines.push(`  ${ids.get(node.file)}[[${quote(`${node.route} layout`)}]]:::layout`);
    else lines.push(`  ${ids.get(node.file)}[${quote(node.route + (node.unlinked ? ' (unlinked)' : ''))}]:::${node.unlinked ? 'flagged' : 'route'}`);
  }
  report.placements.forEach((placement, index) => {
    const placed = placement.routes.length || placement.layouts.length;
    lines.push(`  p${index}(${quote(placement.key + (placed ? '' : ' (no route)'))}):::${placed ? 'placement' : 'flagged'}`);
  });
  let extra = 0;
  for (const edge of report.edges) {
    const from = ids.get(edge.from);
    const labels = [edge.file !== edge.from ? `via ${path.posix.basename(edge.file)}` : '', edge.kind === 'conditional' ? 'conditional' : ''].filter(Boolean);
    if (edge.kind === 'dynamic') { lines.push(`  ${from} -.->|${quote([...labels, 'dynamic'].join(', '))}| x${extra++}["?"]:::flagged`); continue; }
    const to = edge.to ? ids.get(edge.to) : `x${extra++}[${quote(`${edge.target} (no route)`)}]:::flagged`;
    const arrow = edge.kind === 'screen' || edge.kind === 'navigator' ? '---' : edge.kind === 'conditional' ? '-.->' : '-->';
    lines.push(`  ${from} ${arrow}${labels.length ? `|${quote(labels.join(', '))}|` : ''} ${to}`);
  }
  const linked = new Set();
  report.placements.forEach((placement, index) => {
    for (const node of report.routes) {
      if (!node.placements.some(item => item.key === placement.key) || linked.has(`${node.file}\0${index}`)) continue;
      linked.add(`${node.file}\0${index}`);
      lines.push(`  ${ids.get(node.file)} -.- p${index}`);
    }
  });
  return lines.join('\n') + '\n';
}
