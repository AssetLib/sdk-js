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
  assert.equal(help.status, 0); assert.match(help.stdout, /npx -y @assetlib\/audit@0\.1\.0 <app-root>/); assert.doesNotMatch(help.stdout, /not published/);
  assert.deepEqual(await readdir(root), ['hero.png']);
});
