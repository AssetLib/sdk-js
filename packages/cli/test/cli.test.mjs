import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogHash } from '../src/catalog.mjs';
import { generateCatalog } from '../src/codegen.mjs';
import { main } from '../src/cli.mjs';

const bin = fileURLToPath(new URL('../bin/assetlib.mjs', import.meta.url));
const catalog = { schemaVersion: 1, placements: [{ key: 'travel.coast', symbol: ['Travel', 'coast'], width: 1200, height: 900, screen: 'Explore' }] };
const org = '11111111-1111-4111-8111-111111111111';
const app = '22222222-2222-4222-8222-222222222222';
const token = 'alk_example_secret_never_print';
const registration = { buildId: '33333333-3333-4333-8333-333333333333', catalogHash: catalogHash(catalog), placements: { created: ['travel.coast'], existing: [], conflicting: [] } };
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ASSETLIB_|GITHUB_|CIRCLE)/.test(key)));

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'assetlib-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'catalog.json');
  await writeFile(file, JSON.stringify(catalog));
  const sync = ['sync', '--catalog', file, '--platform', 'ios', '--app-version', '1.6.0', '--build-number', '231'];
  return { dir, file, sync };
}

function run(args, env = {}, cwd = tmpdir()) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, env: { ...cleanEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function server(t, status, response) {
  const requests = [];
  const http = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(status, { 'Content-Type': 'application/json', ...(status === 302 ? { Location: '/redirect-target' } : {}) });
    res.end(JSON.stringify(response));
  });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { http.closeAllConnections(); http.close(resolve); }));
  return { origin: `http://127.0.0.1:${http.address().port}`, requests };
}

test('dry-run emits only the registration contract without credentials or network configuration', async t => {
  const f = await fixture(t);
  const source = path.join(f.dir, 'screen.tsx');
  await writeFile(source, 'AppAssets.Travel.coast\n');
  const result = await run([...f.sync, '--references', source, '--sdk-version', '0.2.1-preview.1', '--dry-run', '--json'], {
    ASSETLIB_TOKEN: token, GITHUB_ACTIONS: 'true', GITHUB_SHA: 'abc123', GITHUB_HEAD_REF: 'feature',
    GITHUB_REF: 'refs/pull/42/merge', GITHUB_REPOSITORY: 'org/repo', GITHUB_RUN_ID: '12345',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    build: { platform: 'ios', appVersion: '1.6.0', buildNumber: '231', sdkVersion: '0.2.1-preview.1', vcs: { provider: 'github', repository: 'org/repo', commit: 'abc123', branch: 'feature', pullRequest: '42' }, ci: { provider: 'github-actions', runId: '12345' } },
    catalog, catalogHash: catalogHash(catalog), codeReferences: [{ key: 'travel.coast', path: 'screen.tsx', line: 1 }],
  });
  assert.ok(!result.stdout.includes(token));
});

test('hash prints the canonical hash, and check matches existing generated output without writing it', async t => {
  const f = await fixture(t);
  const generated = path.join(f.dir, 'assets.generated.ts');
  await writeFile(generated, generateCatalog(catalog));
  assert.deepEqual(await run(['hash', '--catalog', f.file]), { code: 0, stdout: catalogHash(catalog) + '\n', stderr: '' });
  const args = ['check', '--catalog', f.file, '--generated', generated];
  assert.equal((await run(args)).code, 0);
  await writeFile(generated, 'stale\n');
  const stale = await run(args);
  assert.equal(stale.code, 1); assert.match(stale.stderr, /differs/);
  assert.equal(await readFile(generated, 'utf8'), 'stale\n');
});

test('sync posts the exact body and bearer header, with flags overriding environment defaults', async t => {
  const f = await fixture(t), s = await server(t, 201, registration);
  const result = await run([...f.sync, '--console', s.origin, '--org', org, '--app', app, '--json'], {
    ASSETLIB_TOKEN: token, ASSETLIB_CONSOLE: 'http://127.0.0.1:1', ASSETLIB_ORG: 'bad', ASSETLIB_APP: 'bad',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), registration);
  assert.equal(result.stderr, ''); assert.equal(s.requests.length, 1);
  assert.deepEqual(s.requests[0].body, { schemaVersion: 1, build: { platform: 'ios', appVersion: '1.6.0', buildNumber: '231' }, catalog, catalogHash: catalogHash(catalog) });
  assert.equal(s.requests[0].path, `/api/apps/${org}/${app}/builds`);
  assert.equal(s.requests[0].method, 'POST');
  assert.equal(s.requests[0].headers.authorization, `Bearer ${token}`);
  assert.equal(s.requests[0].headers['content-type'], 'application/json');
  assert.equal(s.requests[0].headers.cookie, undefined);
});

test('sync accepts environment defaults and summarizes existing and conflicting placements', async t => {
  const f = await fixture(t), s = await server(t, 200, { ...registration, placements: { created: [], existing: ['travel.coast'], conflicting: [{ key: 'home.hero', reason: 'width differs' }] } });
  const result = await run(f.sync, { ASSETLIB_TOKEN: token, ASSETLIB_CONSOLE: s.origin, ASSETLIB_ORG: org, ASSETLIB_APP: app });
  assert.equal(result.code, 0); assert.match(result.stdout, /Build:.*33333333/);
  assert.match(result.stdout, /Existing: travel.coast/); assert.match(result.stdout, /home.hero \(width differs\)/);
});

for (const [status, error] of [[401, 'Missing or invalid token'], [400, 'catalogHash mismatch'], [403, 'Token revoked'], [413, 'Body too large'], [429, 'Rate limited'], [500, 'Server unavailable']]) {
  test(`HTTP ${status} returns exit 1 with the server message and redacts echoed tokens`, async t => {
    const f = await fixture(t), s = await server(t, status, { error: `${error} ${token}` });
    const result = await run([...f.sync, '--json'], { ASSETLIB_TOKEN: token, ASSETLIB_CONSOLE: s.origin, ASSETLIB_ORG: org, ASSETLIB_APP: app });
    assert.equal(result.code, 1); assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).error, `HTTP ${status}: ${error} [REDACTED]`);
  });
}

test('sync does not follow redirects', async t => {
  const f = await fixture(t), s = await server(t, 302, { error: 'Redirect refused' });
  const result = await run(f.sync, { ASSETLIB_TOKEN: token, ASSETLIB_CONSOLE: s.origin, ASSETLIB_ORG: org, ASSETLIB_APP: app });
  assert.equal(result.code, 1); assert.match(result.stderr, /HTTP 302/); assert.equal(s.requests.length, 1);
});

test('invalid flags and build identity fail locally; token is environment-only', async t => {
  const f = await fixture(t);
  for (const args of [
    [...f.sync, '--token', token], [...f.sync, '--unknown'], [...f.sync, '--catalog'],
    [...f.sync.slice(0, 4), 'desktop', ...f.sync.slice(5), '--dry-run'],
    [...f.sync.slice(0, 6), 'version with spaces', ...f.sync.slice(7), '--dry-run'],
    [...f.sync.slice(0, 8), 'a'.repeat(65), '--dry-run'],
  ]) {
    const result = await run(args, { ASSETLIB_TOKEN: token });
    assert.equal(result.code, 1); assert.ok(!(result.stdout + result.stderr).includes(token));
  }
  const missing = await run([...f.sync, '--console', 'http://127.0.0.1:1', '--org', org, '--app', app]);
  assert.equal(missing.code, 1); assert.match(missing.stderr, /ASSETLIB_TOKEN is required/);
});

test('partial scans return exit 2 and JSON diagnostics separately from the exact payload', async t => {
  const f = await fixture(t), source = path.join(f.dir, 'many.ts');
  await writeFile(source, '"travel.coast"\n'.repeat(201));
  const args = [...f.sync, '--references', source, '--json'];
  const result = await run([...args, '--dry-run']);
  assert.equal(result.code, 2); assert.equal(JSON.parse(result.stdout).codeReferences.length, 200);
  assert.match(JSON.parse(result.stderr).warning, /partial/);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)).sort(), ['build', 'catalog', 'catalogHash', 'codeReferences', 'schemaVersion']);
});

test('partial scans still register bounded references and return exit 2 after HTTP success', async t => {
  const f = await fixture(t), source = path.join(f.dir, 'many.ts');
  await writeFile(source, '"travel.coast"\n'.repeat(201));
  const args = [...f.sync, '--references', source, '--json'];
  const s = await server(t, 201, registration);
  const sync = await run(args, { ASSETLIB_TOKEN: token, ASSETLIB_CONSOLE: s.origin, ASSETLIB_ORG: org, ASSETLIB_APP: app });
  assert.equal(sync.code, 2); assert.equal(s.requests[0].body.codeReferences.length, 200);
});

test('transport mock covers request contract, successful and rejected responses without a listening socket', async t => {
  const f = await fixture(t);
  for (const status of [200, 201, 400, 401, 403, 413, 429, 500, 302]) {
    const response = status < 300 ? registration : { error: `Server message ${token}` };
    let captured;
    const mock = t.mock.method(globalThis, 'fetch', async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify(response), { status });
    });
    let stdout = '', stderr = '';
    const code = await main([...f.sync, '--json', '--console', 'https://console.example', '--org', org, '--app', app], {
      ASSETLIB_TOKEN: token, ASSETLIB_CONSOLE: 'https://wrong.example', ASSETLIB_ORG: 'wrong', ASSETLIB_APP: 'wrong',
    }, { stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
    mock.mock.restore();
    assert.equal(captured.url, `https://console.example/api/apps/${org}/${app}/builds`);
    assert.equal(captured.init.method, 'POST'); assert.equal(captured.init.redirect, 'manual');
    assert.deepEqual(captured.init.headers, { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(captured.init.body), { schemaVersion: 1, build: { platform: 'ios', appVersion: '1.6.0', buildNumber: '231' }, catalog, catalogHash: catalogHash(catalog) });
    assert.equal(code, status < 300 ? 0 : 1); assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), status < 300 ? registration : { error: `HTTP ${status}: Server message [REDACTED]` });
  }
});

test('POST uses a 30-second abort signal and never exposes timeout secrets', async t => {
  const f = await fixture(t);
  let deadline;
  t.mock.method(AbortSignal, 'timeout', milliseconds => { deadline = milliseconds; return new AbortController().signal; });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.redirect, 'manual'); assert.equal(init.method, 'POST');
    throw new Error(`request failed: ${token}`);
  });
  let stdout = '', stderr = '';
  const code = await main(f.sync, { ASSETLIB_TOKEN: token, ASSETLIB_CONSOLE: 'https://console.example', ASSETLIB_ORG: org, ASSETLIB_APP: app }, {
    stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
  });
  assert.equal(deadline, 30_000); assert.equal(code, 1); assert.equal(stdout, ''); assert.match(stderr, /\[REDACTED\]/); assert.ok(!stderr.includes(token));
});
