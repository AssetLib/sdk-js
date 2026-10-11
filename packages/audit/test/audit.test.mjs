import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditAssets, formatReport } from '../src/audit.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const body = Buffer.concat([Buffer.from(type), bytes]);
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}
// Generated test artwork, not user assets. Full PNG chunks include valid CRCs.
function png(width = 2, height = 3) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'assetlib-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root, file, data) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), data);
}
const cli = fileURLToPath(new URL('../bin/assetlib-audit.mjs', import.meta.url));

test('measures generated PNG dimensions and exact duplicate evidence without mutating files', async t => {
  const root = await fixture(t);
  const data = png();
  await put(root, 'assets/hero.png', data);
  await put(root, 'assets/copy.png', data);
  await put(root, 'assets/tall.png', png(1, 3000));
  const beforeNames = await readdir(root, { recursive: true });
  const before = await Promise.all(['hero', 'copy', 'tall'].map(name => readFile(path.join(root, `assets/${name}.png`))));
  const report = await auditAssets(root);
  assert.equal(report.coverage.status, 'complete_within_scope');
  assert.equal(report.summary.assets, 3);
  assert.equal(report.summary.dimensionCandidates, 1);
  const hero = report.assets.find(asset => asset.path === 'assets/hero.png');
  assert.deepEqual(hero.dimensions, { width: 2, height: 3 });
  assert.equal(hero.bytes, data.length);
  assert.equal(hero.sha256, createHash('sha256').update(data).digest('hex'));
  assert.equal(hero.references.status, 'not_scanned');
  assert.deepEqual(report.duplicateGroups[0].paths, ['assets/copy.png', 'assets/hero.png']);
  assert.equal(report.duplicateGroups[0].extraCopyBytes, data.length);
  assert.deepEqual(await readdir(root, { recursive: true }), beforeNames);
  assert.deepEqual(await Promise.all(['hero', 'copy', 'tall'].map(name => readFile(path.join(root, `assets/${name}.png`)))), before);
});

test('reference hints expose only locations; absent hints never classify an image as unused', async t => {
  const root = await fixture(t);
  await put(root, 'assets/hero.png', png());
  await put(root, 'assets/quiet.png', png(3, 3));
  await put(root, 'src/Screen.swift', 'Image("hero")\nlet privateContent = "DO_NOT_EXPOSE_SOURCE"\nImage("other")\n');
  const report = await auditAssets(root, { references: ['src'] });
  const hero = report.assets.find(asset => asset.path === 'assets/hero.png');
  const quiet = report.assets.find(asset => asset.path === 'assets/quiet.png');
  assert.deepEqual(hero.references, { status: 'literal_reference_hint_found', hints: [{ path: 'src/Screen.swift', line: 1 }], truncated: false });
  assert.equal(quiet.references.status, 'no_literal_reference_found');
  assert.equal(JSON.stringify(report).includes('DO_NOT_EXPOSE_SOURCE'), false);
  assert.equal(report.interpretation.some(text => text.includes('does not mean unused')), true);
  assert.equal(report.coverage.sourceFilesRead, 1);
});

test('skips symlinks, hidden entries, dependencies, and build directories', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await put(root, 'assets/hero.png', png());
  await put(outside, 'secret.png', png());
  await symlink(path.join(outside, 'secret.png'), path.join(root, 'linked.png'));
  await symlink(outside, path.join(root, 'linked-directory'));
  for (const dir of ['node_modules', 'build', '.data']) await put(root, `${dir}/ignored.png`, png());
  const report = await auditAssets(root);
  assert.deepEqual(report.assets.map(asset => asset.path), ['assets/hero.png']);
  assert.equal(report.coverage.skippedSymlinks, 2);
  assert.equal(report.coverage.ignoredDirectories, 2);
  assert.equal(report.coverage.ignoredHiddenEntries, 1);
  await assert.rejects(auditAssets(root, { references: ['../'] }), /inside the audit root/);
  await assert.rejects(auditAssets(root, { references: ['linked-directory'] }), /symlinks/);
  await assert.rejects(auditAssets(path.join(root, 'linked-directory')), /real directory/);
});

test('skips Vendor by exact name and reports it, while scanning first-party folders that differ only in case', async t => {
  const root = await fixture(t);
  await put(root, 'Vendor/ignored.png', png());
  await put(root, 'Coverage/claim.png', png());
  await put(root, 'Target/goal.png', png());
  const report = await auditAssets(root);
  assert.deepEqual(report.assets.map(asset => asset.path), ['Coverage/claim.png', 'Target/goal.png']);
  assert.equal(report.coverage.ignoredDirectories, 1);
  assert.equal(report.coverage.status, 'complete_within_scope');
  assert.deepEqual(report.scope.ignoredDirectories, ['Build', 'Carthage', 'DerivedData', 'Pods', 'Vendor', 'build', 'coverage', 'dist', 'graft', 'node_modules', 'out', 'target', 'vendor']);
  await assert.rejects(auditAssets(root, { references: ['Vendor'] }), /excluded/);
});

test('image count and byte limits explicitly report partial coverage', async t => {
  const root = await fixture(t);
  await put(root, 'a.png', png()); await put(root, 'b.png', png());
  const byCount = await auditAssets(root, { maxFiles: 1 });
  assert.equal(byCount.assets.length, 1);
  assert.equal(byCount.coverage.status, 'partial');
  assert.equal(byCount.coverage.imagesDiscovered, 2);
  assert.equal(byCount.coverage.issues[0].reason, 'image_file_limit');
  const byBytes = await auditAssets(root, { maxBytes: png().length });
  assert.equal(byBytes.assets.length, 1);
  assert.equal(byBytes.coverage.imageBytesRead, png().length);
  assert.equal(byBytes.coverage.issues[0].reason, 'image_byte_limit');
  assert.equal(formatReport(byBytes).includes('Partial coverage'), true);
});

test('entry, depth, source byte, and hint limits remain visible', async t => {
  const root = await fixture(t);
  await put(root, 'a.png', png());
  await put(root, 'src/screen.ts', 'const first = "a";\nconst second = "a";\n');
  await put(root, 'deep/folder/hidden.png', png());
  assert.equal((await auditAssets(root, { maxEntries: 1 })).coverage.issues.some(item => item.reason === 'entry_limit'), true);
  assert.equal((await auditAssets(root, { maxDepth: 1 })).coverage.issues.some(item => item.reason === 'depth_limit'), true);
  const limitedSource = await auditAssets(root, { references: ['src'], maxSourceBytes: 1 });
  assert.equal(limitedSource.coverage.status, 'partial');
  assert.equal(limitedSource.coverage.sourceFilesRead, 0);
  const hints = await auditAssets(root, { references: ['src'], maxHintsPerAsset: 1 });
  const first = hints.assets.find(item => item.path === 'a.png');
  assert.equal(first.references.hints.length, 1);
  assert.equal(first.references.truncated, true);
});

test('unparseable image content is retained as evidence but reports partial dimensions', async t => {
  const root = await fixture(t);
  await put(root, 'broken.png', 'not an image');
  const report = await auditAssets(root);
  assert.equal(report.assets.length, 1);
  assert.equal(report.assets[0].dimensions, null);
  assert.equal(report.assets[0].dimensionCandidate, false);
  assert.equal(report.coverage.status, 'partial');
  assert.equal(report.coverage.issues[0].reason, 'dimensions_unavailable_or_unsupported_content');
});

test('JSON is deterministic and does not disclose the absolute checkout location', async t => {
  const root = await fixture(t);
  await put(root, 'b.png', png(2, 2)); await put(root, 'a.png', png());
  const first = JSON.stringify(await auditAssets(root));
  assert.equal(first, JSON.stringify(await auditAssets(root)));
  assert.equal(first.includes(root), false);
  assert.equal(first.includes('timestamp'), false);
});

test('asset-path selection excludes QA screenshots while retaining app-root source references', async t => {
  const root = await fixture(t);
  await put(root, 'public/hero.png', png());
  await put(root, 'output/screenshot.png', png(1, 3000));
  await put(root, 'src/Screen.swift', 'Image("hero")\n');
  const report = await auditAssets(root, { assets: ['public'], references: ['src'] });
  assert.deepEqual(report.scope.assetPaths, ['public']);
  assert.deepEqual(report.assets.map(asset => asset.path), ['public/hero.png']);
  assert.equal(report.summary.dimensionCandidates, 0);
  assert.deepEqual(report.assets[0].references.hints, [{ path: 'src/Screen.swift', line: 1 }]);
  assert.equal(report.coverage.excludedByPathSelection, 1);
  const selectedFile = await auditAssets(root, { assets: ['public/hero.png'] });
  assert.equal(selectedFile.summary.assets, 1);
  await put(root, '.private/secret.swift', 'Image("hero")');
  await assert.rejects(auditAssets(root, { references: ['.private'] }), /excluded/);
  await assert.rejects(auditAssets(root, { assets: ['src/Screen.swift'] }), /supported regular file/);
});

test('CLI returns complete/partial/error codes with parseable JSON and no files written', async t => {
  const root = await fixture(t);
  await put(root, 'hero.png', png());
  const good = spawnSync(process.execPath, [cli, root, '--json'], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).summary.assets, 1);
  const partial = spawnSync(process.execPath, [cli, root, '--max-bytes', '1', '--json'], { encoding: 'utf8' });
  assert.equal(partial.status, 2);
  assert.equal(JSON.parse(partial.stdout).coverage.status, 'partial');
  const invalid = spawnSync(process.execPath, [cli, root, '--max-files', 'NaN'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /positive integer/);
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(help.status, 0); assert.ok(help.stdout.includes(`npx -y @assetlib/audit@${version} <app-root>`)); assert.doesNotMatch(help.stdout, /not published|next release/);
  assert.deepEqual(await readdir(root), ['hero.png']);
});

// History fixtures: real repositories with fixed commit dates; the checks never depend on the clock.
function git(cwd, args, date = '2026-06-15T12:00:00Z') {
  const result = spawnSync('git', ['-c', 'user.name=Audit Test', '-c', 'user.email=audit@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}
async function commit(root, date, message, files = {}, removed = []) {
  for (const [file, data] of Object.entries(files)) await put(root, file, data);
  for (const file of removed) git(root, ['rm', '-q', file]);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--allow-empty', '-m', message], date);
}
async function historyRepo(t) {
  const root = await fixture(t);
  git(root, ['init', '-q']);
  await commit(root, '2023-03-01T12:00:00Z', 'initial', { 'README.md': 'app\n' });
  await commit(root, '2024-01-10T12:00:00Z', 'old art outside the window', { 'assets/hero.png': png(), 'src/app.ts': 'export {};\n' });
  await commit(root, '2026-01-05T12:00:00Z', 'SECRET_COMMIT_MESSAGE swap hero art', { 'assets/hero.png': png(2, 4) });
  await commit(root, '2026-02-07T12:00:00Z', 'new screen with art', { 'assets/onboarding.png': png(3, 3), 'src/app.ts': 'export const screen = 1;\n' });
  await commit(root, '2026-03-09T12:00:00Z', 'asset catalog swap', { 'Art.xcassets/promo.imageset/promo.png': png(4, 4), 'Art.xcassets/promo.imageset/Contents.json': '{"images":[]}\n' });
  await commit(root, '2026-03-20T12:00:00Z', 'remove retired art', {}, ['assets/onboarding.png']);
  await commit(root, '2026-04-01T12:00:00Z', 'code only', { 'src/app.ts': 'export const screen = 2;\n' });
  await commit(root, '2026-04-02T12:00:00Z', 'ignored and hidden images', { 'node_modules/pkg/logo.png': png(), '.design/draft.png': png() });
  git(root, ['checkout', '-q', '-b', 'restyle'], '2026-05-01T12:00:00Z');
  await commit(root, '2026-05-01T12:00:00Z', 'restyle step one', { 'assets/hero.png': png(5, 5), 'assets/card.png': png(6, 6) });
  await commit(root, '2026-05-02T12:00:00Z', 'restyle step two', { 'assets/hero.png': png(7, 7) });
  git(root, ['checkout', '-q', 'main'], '2026-05-03T12:00:00Z');
  git(root, ['merge', '-q', '--no-ff', 'restyle', '-m', 'merge restyle'], '2026-05-03T12:00:00Z');
  return root;
}

test('history counts first-parent image changes in a window anchored on the checked-out commit', async t => {
  const root = await historyRepo(t);
  const report = await auditAssets(root, { history: true });
  const { history } = report;
  assert.equal(history.status, 'complete');
  assert.deepEqual(history.reasons, []);
  assert.deepEqual(history.window, { days: 365, start: '2025-05-03', end: '2026-05-03' });
  assert.equal(history.basis, 'first_parent_of_checked_out_commit');
  // The 2024 commit is outside the window; the merged branch counts once; ignored and hidden images do not count.
  assert.equal(history.changesUnderRoot, 7);
  assert.equal(history.imageChanges, 5);
  assert.equal(history.imageOnlyChanges, 4);
  assert.deepEqual(history.artwork, { changes: 5, imageOnlyChanges: 4, images: 4, fileChanges: 6, maxImagesInOneChange: 2, monthsWithChanges: 4, changesByMonth: { '2026-01': 1, '2026-02': 1, '2026-03': 2, '2026-05': 1 } });
  assert.equal(history.iconsAndLogos.changes, 0);
  assert.equal(history.appIconsLaunchAndStore.changes, 0);
  assert.deepEqual(history.fileChangesByFormat, { raster: 6, vector: 0, animation: 0 });
  assert.deepEqual(history.mostChangedArtwork, [
    { image: 'assets/hero', changes: 2, lastChanged: '2026-05-03' },
    { image: 'assets/onboarding', changes: 2, lastChanged: '2026-03-20' },
    { image: 'Art.xcassets/promo.imageset', changes: 1, lastChanged: '2026-03-09' },
    { image: 'assets/card', changes: 1, lastChanged: '2026-05-03' },
  ]);
  const byPath = Object.fromEntries(report.assets.map(asset => [asset.path, asset.history]));
  assert.deepEqual(byPath['assets/hero.png'], { changes: 2, lastChanged: '2026-05-03' });
  assert.deepEqual(byPath['assets/card.png'], { changes: 1, lastChanged: '2026-05-03' });
  assert.deepEqual(byPath['Art.xcassets/promo.imageset/promo.png'], { changes: 1, lastChanged: '2026-03-09' });
  assert.equal(report.coverage.status, 'complete_within_scope');
  const json = JSON.stringify(report);
  assert.equal(json.includes('SECRET_COMMIT_MESSAGE'), false);
  assert.equal(json.includes('Audit Test'), false);
  assert.equal(json.includes(git(root, ['rev-parse', 'HEAD']).trim().slice(0, 7)), false);
  assert.equal(json, JSON.stringify(await auditAssets(root, { history: true })));
  const text = formatReport(report);
  assert.match(text, /Artwork: 5 of 7 changes under the root, 4 of them image-only; 4 images in 4 months; the largest change touched \d+ images?\./);
  assert.match(text, /  assets\/hero — 2 changes, last 2026-05-03/);
  assert.match(text, /  assets\/card — 1 change, last 2026-05-03/);
  assert.doesNotMatch(text, /\(s\)/);
  const narrow = await auditAssets(root, { history: true, historyDays: 60 });
  assert.deepEqual(narrow.history.window, { days: 60, start: '2026-03-04', end: '2026-05-03' });
  assert.equal(narrow.history.imageChanges, 3);
  assert.equal('history' in await auditAssets(root), false);
});

test('history counts density and dark-mode copies once, separates icons and app icons, and counts SVG, PDF, and Lottie', async t => {
  const root = await fixture(t);
  git(root, ['init', '-q']);
  await commit(root, '2026-01-10T12:00:00Z', 'artwork in every platform layout', {
    'Assets.xcassets/Hero.imageset/hero@2x.png': png(2, 2), 'Assets.xcassets/Hero.imageset/hero@3x.png': png(3, 3), 'Assets.xcassets/Hero.imageset/Contents.json': '{}\n',
    'app/src/main/res/drawable-xhdpi/bg_welcome.webp': png(2, 2), 'app/src/main/res/drawable-xxhdpi/bg_welcome.webp': png(3, 3), 'app/src/main/res/drawable-night-xxhdpi/bg_welcome.webp': png(4, 4),
    'assets/promo@2x.png': png(2, 2), 'assets/promo@3x.png': png(3, 3),
    'assets/images/banner.png': png(1, 1), 'assets/images/2.0x/banner.png': png(2, 2), 'assets/images/3.0x/banner.png': png(3, 3),
  });
  await commit(root, '2026-02-10T12:00:00Z', 'icons and logos', {
    'app/src/main/res/drawable-xxhdpi/ic_share.png': png(), 'assets/images/tab-icons/home@2x.png': png(),
    'Assets.xcassets/PartnerLogo.imageset/partner.pdf': '%PDF-1.4\n', 'Assets.xcassets/gear.symbolset/gear.svg': '<svg/>\n',
  });
  await commit(root, '2026-03-10T12:00:00Z', 'app icons and launch art', {
    'Assets.xcassets/AppIcon.appiconset/icon-1024.png': png(), 'app/src/main/res/mipmap-xxhdpi/ic_launcher.png': png(), 'assets/splash.png': png(), 'assets/icon.png': png(),
  });
  await commit(root, '2026-04-10T12:00:00Z', 'vector and Lottie artwork with code', {
    'assets/illustrations/empty-state.svg': '<svg/>\n', 'assets/animations/confetti.json': '{"v":"5.7.0"}\n', 'assets/data/config.json': '{}\n', 'src/screen.ts': 'export {};\n',
  });
  await commit(root, '2026-05-10T12:00:00Z', 'swap the hero', { 'Assets.xcassets/Hero.imageset/hero@2x.png': png(5, 5), 'Assets.xcassets/Hero.imageset/hero@3x.png': png(6, 6) });
  const { history } = await auditAssets(root, { history: true });
  assert.equal(history.changesUnderRoot, 5);
  assert.equal(history.imageChanges, 5);
  assert.equal(history.imageOnlyChanges, 4);
  assert.deepEqual(history.artwork, { changes: 3, imageOnlyChanges: 2, images: 6, fileChanges: 14, maxImagesInOneChange: 4, monthsWithChanges: 3, changesByMonth: { '2026-01': 1, '2026-04': 1, '2026-05': 1 } });
  assert.deepEqual({ ...history.iconsAndLogos, changesByMonth: undefined }, { changes: 1, imageOnlyChanges: 1, images: 4, fileChanges: 4, maxImagesInOneChange: 4, monthsWithChanges: 1, changesByMonth: undefined });
  assert.deepEqual({ ...history.appIconsLaunchAndStore, changesByMonth: undefined }, { changes: 1, imageOnlyChanges: 1, images: 4, fileChanges: 4, maxImagesInOneChange: 4, monthsWithChanges: 1, changesByMonth: undefined });
  assert.deepEqual(history.fileChangesByFormat, { raster: 18, vector: 3, animation: 1 });
  assert.deepEqual(history.mostChangedArtwork, [
    { image: 'Assets.xcassets/Hero.imageset', changes: 2, lastChanged: '2026-05-10' },
    { image: 'app/src/main/res/drawable/bg_welcome', changes: 1, lastChanged: '2026-01-10' },
    { image: 'assets/animations/confetti', changes: 1, lastChanged: '2026-04-10' },
    { image: 'assets/illustrations/empty-state', changes: 1, lastChanged: '2026-04-10' },
    { image: 'assets/images/banner', changes: 1, lastChanged: '2026-01-10' },
    { image: 'assets/promo', changes: 1, lastChanged: '2026-01-10' },
  ]);
});

test('history respects asset selection and a subdirectory audit root', async t => {
  const root = await historyRepo(t);
  const selected = await auditAssets(root, { history: true, assets: ['Art.xcassets'] });
  assert.equal(selected.history.imageChanges, 1);
  assert.equal(selected.history.imageOnlyChanges, 1);
  assert.deepEqual(selected.assets.map(asset => asset.path), ['Art.xcassets/promo.imageset/promo.png']);
  await commit(root, '2026-05-10T12:00:00Z', 'server and app art together', { 'apps/mobile/art/hero.png': png(8, 8), 'server/api.ts': 'export {};\n' });
  const nested = await auditAssets(path.join(root, 'apps/mobile'), { history: true });
  assert.equal(nested.history.changesUnderRoot, 1);
  assert.equal(nested.history.imageOnlyChanges, 1);
  assert.deepEqual(nested.assets.map(asset => [asset.path, asset.history.changes]), [['art/hero.png', 1]]);
});

test('history limits, shallow clones, and missing repositories report partial coverage', async t => {
  const root = await historyRepo(t);
  const limited = await auditAssets(root, { history: true, maxHistoryCommits: 2 });
  assert.equal(limited.history.status, 'partial');
  assert.deepEqual(limited.history.reasons, ['commit_limit']);
  assert.equal(limited.history.changesUnderRoot, 2);
  assert.equal(limited.coverage.status, 'partial');
  assert.deepEqual(limited.coverage.issues, [{ path: '.', reason: 'history_commit_limit' }]);
  const bytes = await auditAssets(root, { history: true, maxHistoryBytes: 8 });
  assert.deepEqual(bytes.history.reasons, ['byte_limit']);
  assert.equal(bytes.history.imageChanges, null);
  assert.equal(bytes.assets[0].history, null);
  const parent = await fixture(t);
  const shallow = path.join(parent, 'shallow');
  git(parent, ['clone', '-q', '--depth', '1', `file://${root}`, shallow]);
  const shallowReport = await auditAssets(shallow, { history: true });
  assert.equal(shallowReport.history.status, 'partial');
  assert.deepEqual(shallowReport.history.reasons, ['shallow_clone']);
  // A shallow clone whose first-parent line reaches past the window start is complete for the window.
  const covering = path.join(parent, 'covering');
  git(parent, ['clone', '-q', '--shallow-since=2023-12-01', `file://${root}`, covering]);
  assert.equal(git(covering, ['rev-parse', '--is-shallow-repository']).trim(), 'true');
  const coveringReport = await auditAssets(covering, { history: true });
  assert.equal(coveringReport.history.status, 'complete');
  assert.equal(coveringReport.history.imageChanges, 5);
  const plain = await fixture(t);
  await put(plain, 'hero.png', png());
  const missing = await auditAssets(plain, { history: true });
  assert.equal(missing.history.status, 'unavailable');
  assert.deepEqual(missing.history.reasons, ['not_a_git_work_tree']);
  assert.equal(missing.history.artwork, null);
  assert.equal(missing.history.changesUnderRoot, null);
  assert.equal(missing.assets[0].history, null);
  assert.match(formatReport(missing), /History not measured: not a git work tree\./);
  const empty = await fixture(t);
  git(empty, ['init', '-q']);
  assert.deepEqual((await auditAssets(empty, { history: true })).history.reasons, ['no_commits']);
  await assert.rejects(auditAssets(plain, { history: 'yes' }), /history must be true or false/);
  await assert.rejects(auditAssets(plain, { history: true, historyDays: 0 }), /historyDays/);
});

test('history ignores inherited GIT_* variables and the repository\'s signature program', async t => {
  const root = await historyRepo(t);
  const marker = path.join(await fixture(t), 'ran');
  const program = path.join(await fixture(t), 'program.sh');
  await writeFile(program, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  git(root, ['config', 'log.showSignature', 'true']);
  git(root, ['config', 'gpg.program', program]);
  // A commit carrying a signature header makes git run gpg.program when log.showSignature is on.
  const head = git(root, ['cat-file', 'commit', 'HEAD']);
  const signed = head.replace(/\n\n/, '\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n -----END PGP SIGNATURE-----\n\n');
  const object = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: root, input: signed, encoding: 'utf8' }).stdout.trim();
  git(root, ['update-ref', 'HEAD', object]);
  spawnSync('git', ['log', '-1'], { cwd: root });
  assert.equal(await readFile(marker).then(() => true, () => false), true, 'control: the repository configuration alone makes git log run gpg.program');
  await rm(marker);
  const elsewhere = await fixture(t);
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(elsewhere, 'not-a-repo');
  try {
    const report = await auditAssets(root, { history: true });
    assert.equal(report.history.status, 'complete');
    assert.equal(report.history.imageChanges, 5);
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous;
  }
  assert.equal(await readFile(marker).then(() => true, () => false), false);
});

test('history never fetches missing objects in a partial clone', async t => {
  const source = await historyRepo(t);
  git(source, ['config', 'uploadpack.allowFilter', 'true']);
  const parent = await fixture(t);
  const inPack = clone => Number(/in-pack: (\d+)/.exec(git(clone, ['count-objects', '-v']))[1]);
  const control = path.join(parent, 'control');
  const treeless = path.join(parent, 'treeless');
  for (const clone of [control, treeless]) {
    git(parent, ['-c', 'protocol.file.allow=always', 'clone', '-q', '--filter=tree:0', '--no-local', '--no-checkout', `file://${source}`, clone]);
    git(clone, ['config', 'protocol.file.allow', 'always']);
  }
  const before = inPack(control);
  git(control, ['log', '--name-status', 'HEAD', '--']);
  assert.ok(inPack(control) > before, 'control: plain git log fetches the missing trees');
  const objects = inPack(treeless);
  const report = await auditAssets(treeless, { history: true });
  assert.equal(report.history.status, 'partial');
  assert.deepEqual(report.history.reasons, ['git_log_failed']);
  assert.equal(report.history.imageChanges, null);
  assert.equal(inPack(treeless), objects);
});

test('history reports git_unavailable without git on PATH and git_too_old for a git without --no-lazy-fetch', async t => {
  const root = await historyRepo(t);
  const fakeBin = await fixture(t);
  await writeFile(path.join(fakeBin, 'git'), '#!/bin/sh\necho "unknown option: --no-lazy-fetch" >&2\nexit 129\n', { mode: 0o755 });
  const previous = process.env.PATH;
  try {
    process.env.PATH = await fixture(t);
    assert.deepEqual((await auditAssets(root, { history: true })).history.reasons, ['git_unavailable']);
    process.env.PATH = fakeBin;
    const old = await auditAssets(root, { history: true });
    assert.equal(old.history.status, 'unavailable');
    assert.deepEqual(old.history.reasons, ['git_too_old']);
    // A git planted in the current directory is never run, even when PATH names the current directory.
    const planted = await fixture(t);
    const marker = path.join(planted, 'ran');
    await writeFile(path.join(planted, 'git'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    const cwd = process.cwd();
    process.chdir(planted);
    try {
      process.env.PATH = `.${path.delimiter}${path.delimiter}relative-bin`;
      assert.deepEqual((await auditAssets(root, { history: true })).history.reasons, ['git_unavailable']);
    } finally {
      process.chdir(cwd);
    }
    assert.equal(await readFile(marker).then(() => true, () => false), false);
  } finally {
    process.env.PATH = previous;
  }
});

test('history filters every commit by date, survives a HEAD path, keeps the root commit, and parses unusual paths', async t => {
  // A code-only commit with a wrong, old clock between in-window image changes must not hide them.
  const skewed = await fixture(t);
  git(skewed, ['init', '-q']);
  await commit(skewed, '2025-12-01T12:00:00Z', 'root', { 'assets/a.png': png(1, 1) });
  git(skewed, ['config', 'log.showRoot', 'false']);
  await commit(skewed, '2026-01-01T12:00:00Z', 'jan', { 'assets/a.png': png(2, 2) });
  await commit(skewed, '2026-02-01T12:00:00Z', 'feb', { 'assets/a.png': png(3, 3) });
  await commit(skewed, '2019-01-01T12:00:00Z', 'wrong clock', { 'src/app.ts': 'export {};\n' });
  await commit(skewed, '2026-03-01T12:00:00Z', 'mar', { 'assets/a.png': png(4, 4) });
  const report = await auditAssets(skewed, { history: true });
  assert.equal(report.history.status, 'complete');
  assert.equal(report.history.artwork.changes, 4);
  assert.deepEqual(report.assets[0].history, { changes: 4, lastChanged: '2026-03-01' });
  // Ancestors dated after HEAD fall outside a window that ends at HEAD's date.
  const future = await fixture(t);
  git(future, ['init', '-q']);
  await commit(future, '2025-12-01T12:00:00Z', 'dec', { 'assets/a.png': png(1, 1) });
  await commit(future, '2026-06-01T12:00:00Z', 'jun', { 'assets/a.png': png(2, 2) });
  await commit(future, '2026-01-01T12:00:00Z', 'head', { 'src/app.ts': 'export {};\n' });
  const futureReport = await auditAssets(future, { history: true });
  assert.equal(futureReport.history.window.end, '2026-01-01');
  assert.deepEqual(futureReport.history.artwork.changesByMonth, { '2025-12': 1 });
  // An entry named HEAD does not make the revision ambiguous.
  await mkdir(path.join(skewed, 'HEAD'));
  await writeFile(path.join(skewed, 'HEAD', 'notes.txt'), 'x\n');
  assert.equal((await auditAssets(skewed, { history: true, assets: ['assets'] })).history.artwork.changes, 4);
  // A path containing U+001E is read as a path, not as a commit header.
  const odd = await fixture(t);
  git(odd, ['init', '-q']);
  await commit(odd, '2026-01-01T12:00:00Z', 'odd', { 'assets/a\x1e1700000000.png': png(1, 1), 'assets/b.png': png(2, 2) });
  await commit(odd, '2026-02-01T12:00:00Z', 'odd again', { 'assets/a\x1e1700000000.png': png(3, 3) });
  const oddReport = await auditAssets(odd, { history: true });
  assert.equal(oddReport.history.changesUnderRoot, 2);
  assert.deepEqual(oddReport.assets.map(asset => asset.history.changes), [2, 1]);
});

test('Contents.json is exempt for a single selected file, and submodules are reported as not counted', async t => {
  const root = await fixture(t);
  git(root, ['init', '-q']);
  await commit(root, '2026-01-01T12:00:00Z', 'catalog', { 'Art.xcassets/promo.imageset/promo.png': png(), 'Art.xcassets/promo.imageset/Contents.json': '{}\n' });
  await commit(root, '2026-02-01T12:00:00Z', 'swap', { 'Art.xcassets/promo.imageset/promo.png': png(2, 2), 'Art.xcassets/promo.imageset/Contents.json': '{"v":2}\n' });
  const single = await auditAssets(root, { history: true, assets: ['Art.xcassets/promo.imageset/promo.png'] });
  assert.equal(single.history.imageOnlyChanges, 2);
  const art = await fixture(t);
  git(art, ['init', '-q']);
  await commit(art, '2026-01-15T12:00:00Z', 'art', { 'hero.png': png() });
  git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', art, 'design'], '2026-03-01T12:00:00Z');
  git(root, ['commit', '-q', '-m', 'add submodule'], '2026-03-01T12:00:00Z');
  const report = await auditAssets(root, { history: true });
  assert.equal(report.history.status, 'partial');
  assert.deepEqual(report.history.reasons, ['submodules_not_counted']);
  assert.equal(report.assets.find(asset => asset.path === 'design/hero.png').history, null);
  assert.deepEqual(report.assets.find(asset => asset.path === 'Art.xcassets/promo.imageset/promo.png').history, { changes: 2, lastChanged: '2026-02-01' });
});

test('a shallow clone does not count its cut-off commit, and the commit limit counts only changes under the root', async t => {
  const source = await fixture(t);
  git(source, ['init', '-q']);
  await commit(source, '2020-01-01T12:00:00Z', 'art long ago', { 'assets/images/hero.png': png(), 'assets/images/banner.png': png(2, 2), 'src/app.ts': 'export {};\n' });
  await commit(source, '2026-03-01T12:00:00Z', 'code', { 'src/app.ts': 'export const a = 1;\n' });
  await commit(source, '2026-04-01T12:00:00Z', 'code again', { 'src/app.ts': 'export const a = 2;\n' });
  const parent = await fixture(t);
  for (const depth of ['1', '2']) {
    const shallow = path.join(parent, `depth-${depth}`);
    git(parent, ['clone', '-q', '--depth', depth, `file://${source}`, shallow]);
    const report = await auditAssets(shallow, { history: true });
    assert.deepEqual(report.history.reasons, ['shallow_clone']);
    assert.equal(report.history.imageChanges, 0, `depth ${depth}`);
    assert.deepEqual(report.assets.map(asset => asset.history), [{ changes: 0, lastChanged: null }, { changes: 0, lastChanged: null }]);
  }
  const monorepo = await fixture(t);
  git(monorepo, ['init', '-q']);
  await commit(monorepo, '2026-01-10T12:00:00Z', 'mobile art', { 'apps/mobile/art/a.png': png() });
  await commit(monorepo, '2026-02-10T12:00:00Z', 'mobile art again', { 'apps/mobile/art/a.png': png(2, 2) });
  for (let day = 1; day <= 5; day++) await commit(monorepo, `2026-03-0${day}T12:00:00Z`, `server ${day}`, { 'server/api.ts': `export const v = ${day};\n` });
  const limited = await auditAssets(path.join(monorepo, 'apps/mobile'), { history: true, maxHistoryCommits: 2 });
  assert.equal(limited.history.status, 'complete');
  assert.equal(limited.history.changesUnderRoot, 2);
  assert.deepEqual(limited.assets[0].history, { changes: 2, lastChanged: '2026-02-10' });
});

test('history handles an audit root inside an asset catalog, NFD file names, log encodings, and out-of-range dates', async t => {
  const root = await fixture(t);
  git(root, ['init', '-q']);
  git(root, ['config', 'i18n.logOutputEncoding', 'UTF-16']);
  await commit(root, '2026-01-01T12:00:00Z', 'catalog', { 'Art.xcassets/promo.imageset/promo.png': png(), 'Art.xcassets/promo.imageset/Contents.json': '{}\n', 'Art.xcassets/promo.imageset/promo-dark.pdf': '%PDF-1.4\n' });
  await commit(root, '2026-02-01T12:00:00Z', 'swap', { 'Art.xcassets/promo.imageset/promo.png': png(2, 2), 'Art.xcassets/promo.imageset/Contents.json': '{"v":2}\n' });
  const inCatalog = await auditAssets(path.join(root, 'Art.xcassets'), { history: true });
  assert.equal(inCatalog.history.status, 'complete');
  assert.equal(inCatalog.history.imageOnlyChanges, 2);
  assert.deepEqual(inCatalog.history.fileChangesByFormat, { raster: 2, vector: 1, animation: 0 });
  assert.deepEqual(inCatalog.history.mostChangedArtwork, [{ image: 'promo.imageset', changes: 2, lastChanged: '2026-02-01' }]);
  // Decomposed (NFD) names on disk match the paths git reports.
  const nfd = await fixture(t);
  git(nfd, ['init', '-q']);
  await commit(nfd, '2026-01-01T12:00:00Z', 'nfd', { ['assets/café.png']: png() });
  assert.deepEqual((await auditAssets(nfd, { history: true })).assets[0].history, { changes: 1, lastChanged: '2026-01-01' });
  // A commit date JavaScript cannot represent makes history unavailable instead of crashing the audit.
  const future = await fixture(t);
  git(future, ['init', '-q']);
  await commit(future, '@9999999999999 +0000', 'far future', { 'hero.png': png() });
  const report = await auditAssets(future, { history: true });
  assert.equal(report.history.status, 'unavailable');
  assert.deepEqual(report.history.reasons, ['invalid_commit_date']);
});

test('history never runs a git shipped inside the audited checkout, and text output escapes control characters in paths', async t => {
  const root = await historyRepo(t);
  const marker = path.join(await fixture(t), 'ran');
  for (const directory of ['node_modules/.bin', 'tools/bin']) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, 'git'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  }
  const realGit = path.dirname(spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim());
  const previous = process.env.PATH;
  try {
    process.env.PATH = [path.join(root, 'node_modules/.bin'), path.join(root, 'tools/bin'), realGit].join(path.delimiter);
    const report = await auditAssets(root, { history: true, assets: ['assets', 'Art.xcassets'] });
    assert.equal(report.history.status, 'complete');
    assert.equal(report.history.imageChanges, 5);
    const elsewhere = await fixture(t);
    await mkdir(path.join(elsewhere, 'node_modules/.bin'), { recursive: true });
    await writeFile(path.join(elsewhere, 'node_modules/.bin/git'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    process.env.PATH = [path.join(elsewhere, 'node_modules/.bin'), realGit].join(path.delimiter);
    assert.equal((await auditAssets(root, { history: true, assets: ['assets'] })).history.status, 'complete');
    const broken = await fixture(t);
    await writeFile(path.join(broken, 'git'), '#!/bin/sh\necho "fatal: something else" >&2\nexit 1\n', { mode: 0o755 });
    process.env.PATH = broken;
    assert.deepEqual((await auditAssets(root, { history: true })).history.reasons, ['git_unavailable']);
  } finally {
    process.env.PATH = previous;
  }
  assert.equal(await readFile(marker).then(() => true, () => false), false);
  const escaped = await fixture(t);
  git(escaped, ['init', '-q']);
  await commit(escaped, '2026-01-01T12:00:00Z', 'escape', { 'assets/a\x1b[31mred.png': png() });
  const text = formatReport(await auditAssets(escaped, { history: true }));
  assert.equal(text.includes('\x1b'), false);
  assert.match(text, /assets\/a\\x1b\[31mred/);
});

test('CLI --history and --history-days produce history and validate input', async t => {
  const root = await historyRepo(t);
  const run = spawnSync(process.execPath, [cli, root, '--history-days', '60', '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).history.window.days, 60);
  const text = spawnSync(process.execPath, [cli, root, '--history'], { encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /History, 365 days to 2026-05-03 \(first-parent; density and dark-mode copies count once\)/);
  const plain = await fixture(t);
  await put(plain, 'hero.png', png());
  assert.equal(spawnSync(process.execPath, [cli, plain, '--history'], { encoding: 'utf8' }).status, 2);
  const invalid = spawnSync(process.execPath, [cli, root, '--history-days', 'soon'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /history-days must be a positive integer/);
});
