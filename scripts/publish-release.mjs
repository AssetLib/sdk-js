// Publishes the tarballs from `npm run pack:release` to npm and attaches the same files to the GitHub release.
// The release workflow runs it with npm trusted publishing; `--dry-run` reads npm and GitHub but changes neither.
// Node built-ins, npm and gh only: it runs in the job that can mint an npm token, where no dependency is installed.
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ORDER = ['@assetlib/sdk-core', '@assetlib/sdk-expo', '@assetlib/cli', '@assetlib/audit'];
const dryRun = process.argv.includes('--dry-run');
const directory = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? 'release');
const tag = process.env.RELEASE_TAG ?? '';
if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(tag)) throw new Error('Set RELEASE_TAG to the release tag, for example v0.6.0-preview.1.');

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const temp = () => mkdtemp(path.join(tmpdir(), 'assetlib-release-'));

// The npm metadata for name@version, or null when that version is not on npm.
function registry(name, version) {
  try { return JSON.parse(run('npm', ['view', `${name}@${version}`, 'dist', '--json'])); }
  catch (error) { if (/"code": "E404"/.test(String(error.stdout))) return null; throw error; }
}

// The files a tarball installs and their hashes. Tar headers and compression can differ between npm versions.
async function files(tarball) {
  const out = await temp();
  run('tar', ['-xzf', tarball, '-C', out]);
  const found = [];
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(`${digest('sha256', await readFile(full))}  ${path.relative(out, full)}`);
    }
  };
  await walk(out);
  await rm(out, { recursive: true, force: true });
  return found.sort().join('\n');
}

async function waitForRegistry(name, version, sha1) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const dist = registry(name, version);
    if (dist) {
      if (dist.shasum !== sha1) throw new Error(`${name}@${version} on npm has shasum ${dist.shasum}, not ${sha1}.`);
      return;
    }
    await sleep(10000);
  }
  throw new Error(`${name}@${version} was published but npm did not serve it within 10 minutes.`);
}

const tarballs = [];
for (const file of (await readdir(directory)).filter(name => name.endsWith('.tgz'))) {
  const full = path.join(directory, file);
  const { name, version } = JSON.parse(run('tar', ['-xzOf', full, 'package/package.json']));
  if (!ORDER.includes(name)) throw new Error(`${file} is not an Assetlib release package (${name}).`);
  tarballs.push({ file, full, name, version });
}
tarballs.sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));
for (const name of ORDER) if (!tarballs.some(item => item.name === name)) throw new Error(`${directory} has no ${name} tarball.`);
for (const item of tarballs.filter(item => item.name === '@assetlib/sdk-core' || item.name === '@assetlib/sdk-expo')) {
  if (`v${item.version}` !== tag) throw new Error(`${item.name} is ${item.version}, but the release tag is ${tag}.`);
}

for (const item of tarballs) {
  const dist = registry(item.name, item.version);
  if (dist) {
    // Already on npm: this release must carry the same files, and attaches npm's own tarball.
    const out = await temp();
    const [{ filename }] = JSON.parse(run('npm', ['pack', `${item.name}@${item.version}`, '--json', '--pack-destination', out]));
    if (await files(path.join(out, filename)) !== await files(item.full)) {
      throw new Error(`${item.name}@${item.version} is already on npm with different files. Bump its version.`);
    }
    await copyFile(path.join(out, filename), item.full);
    await rm(out, { recursive: true, force: true });
    console.log(`${item.name}@${item.version}: already on npm with the same files; attaching npm's tarball.`);
    continue;
  }
  // The audit is a stable package and gets `latest` only; every SDK and CLI version is a preview and gets both tags.
  const tags = item.name === '@assetlib/audit' ? ['latest'] : ['preview', 'latest'];
  if (dryRun) { console.log(`${item.name}@${item.version}: would publish ${item.file} with tags ${tags.join(', ')}.`); continue; }
  run('npm', ['publish', item.full, '--tag', tags[0], '--access', 'public']);
  await waitForRegistry(item.name, item.version, digest('sha1', await readFile(item.full)));
  for (const extra of tags.slice(1)) run('npm', ['dist-tag', 'add', `${item.name}@${item.version}`, extra]);
  console.log(`${item.name}@${item.version}: published with tags ${tags.join(', ')}.`);
}

const sums = [];
for (const item of tarballs) sums.push(`${digest('sha256', await readFile(item.full))}  ${item.file}`);
await writeFile(path.join(directory, 'SHA256SUMS'), sums.join('\n') + '\n');

// Attach to the GitHub release. A tarball already attached must be byte-identical; SHA256SUMS is rewritten.
let attached;
try { attached = JSON.parse(run('gh', ['release', 'view', tag, '--json', 'assets'])).assets.map(asset => asset.name); }
catch (error) {
  if (!dryRun || !/release not found/i.test(String(error.stderr))) throw error;
  console.log(`The ${tag} release does not exist yet.`);
  attached = [];
}
const upload = [];
for (const item of tarballs) {
  if (!attached.includes(item.file)) { upload.push(item.full); continue; }
  const out = await temp();
  run('gh', ['release', 'download', tag, '--pattern', item.file, '--dir', out]);
  const same = digest('sha256', await readFile(path.join(out, item.file))) === digest('sha256', await readFile(item.full));
  await rm(out, { recursive: true, force: true });
  if (!same) throw new Error(`${item.file} on the ${tag} release differs from the file on npm.`);
}
if (dryRun) console.log(`Would attach ${[...upload.map(file => path.basename(file)), 'SHA256SUMS'].join(', ')} to ${tag}.`);
else {
  if (upload.length) run('gh', ['release', 'upload', tag, ...upload]);
  run('gh', ['release', 'upload', tag, path.join(directory, 'SHA256SUMS'), '--clobber']);
  console.log(`Attached ${[...upload.map(file => path.basename(file)), 'SHA256SUMS'].join(', ')} to ${tag}.`);
}
