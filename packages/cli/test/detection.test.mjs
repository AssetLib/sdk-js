import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { detectBuildMetadata } from '../src/detection.mjs';

const execute = promisify(execFile);

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'assetlib-ci-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('GitHub Actions wins over CircleCI and uses the PR head branch', async () => {
  assert.deepEqual(await detectBuildMetadata('/unused/catalog.json', {
    GITHUB_ACTIONS: 'true', GITHUB_SHA: 'abc123', GITHUB_REF_NAME: '42/merge', GITHUB_REPOSITORY: 'org/repo', GITHUB_RUN_ID: '12345', GITHUB_HEAD_REF: 'feature/artwork', GITHUB_REF: 'refs/pull/42/merge',
    CIRCLECI: 'true', CIRCLE_SHA1: 'wrong-commit', CIRCLE_BUILD_NUM: '999',
  }), {
    vcs: { provider: 'github', repository: 'org/repo', commit: 'abc123', branch: 'feature/artwork', pullRequest: '42' },
    ci: { provider: 'github-actions', runId: '12345' },
  });
});

test('GitHub variables detect CI without the marker and use the regular branch', async () => {
  assert.deepEqual(await detectBuildMetadata('/unused/catalog.json', { GITHUB_SHA: 'abc123', GITHUB_REF_NAME: 'main', GITHUB_REF: 'refs/heads/main' }), {
    vcs: { provider: 'github', commit: 'abc123', branch: 'main' }, ci: { provider: 'github-actions' },
  });
});

test('CircleCI identifies the repository, build, and pull request', async () => {
  assert.deepEqual(await detectBuildMetadata('/unused/catalog.json', {
    CIRCLECI: 'true', CIRCLE_SHA1: 'def456', CIRCLE_BRANCH: 'feature/assets', CIRCLE_PROJECT_USERNAME: 'team', CIRCLE_PROJECT_REPONAME: 'app', CIRCLE_BUILD_NUM: '4321', CIRCLE_PULL_REQUEST: 'https://github.com/team/app/pull/27', CIRCLE_REPOSITORY_URL: 'git@github.com:team/app.git',
  }), {
    vcs: { provider: 'github', repository: 'team/app', commit: 'def456', branch: 'feature/assets', pullRequest: '27' }, ci: { provider: 'circleci', runId: '4321' },
  });
});

test('CircleCI supports Bitbucket and omits an unknown VCS provider', async () => {
  assert.deepEqual(await detectBuildMetadata('/unused/catalog.json', { CIRCLE_BUILD_NUM: '12', CIRCLE_REPOSITORY_URL: 'https://bitbucket.org/team/app.git', CIRCLE_PULL_REQUEST: 'https://bitbucket.org/team/app/pull-requests/16' }), {
    vcs: { provider: 'bitbucket', pullRequest: '16' }, ci: { provider: 'circleci', runId: '12' },
  });
  assert.deepEqual(await detectBuildMetadata('/unused/catalog.json', { CIRCLE_BUILD_NUM: '12', CIRCLE_SHA1: 'abc123', CIRCLE_REPOSITORY_URL: 'https://unknown.example/team/app' }), {
    vcs: { commit: 'abc123' }, ci: { provider: 'circleci', runId: '12' },
  });
});

test('unusable metadata is omitted rather than truncated or inherited from process.env', async () => {
  assert.deepEqual(await detectBuildMetadata('/unused/catalog.json', {
    GITHUB_ACTIONS: 'true', GITHUB_SHA: 'x'.repeat(201), GITHUB_REF_NAME: 'fallback', GITHUB_HEAD_REF: 'bad\nbranch', GITHUB_REPOSITORY: 123, GITHUB_RUN_ID: ' ', GITHUB_REF: 'refs/pull/99/head',
  }), { vcs: { provider: 'github', branch: 'fallback' }, ci: { provider: 'github-actions' } });
  assert.deepEqual(await detectBuildMetadata('/unused/catalog.json', { CIRCLECI: 'true', CIRCLE_PROJECT_USERNAME: 'x'.repeat(100), CIRCLE_PROJECT_REPONAME: 'y'.repeat(100) }), { ci: { provider: 'circleci' } });
});

test('missing git, a non-repository, and an unavailable catalog directory never fail', async t => {
  const directory = await temporaryDirectory(t);
  const env = { PATH: path.join(directory, 'no-executables') };
  assert.deepEqual(await detectBuildMetadata(path.join(directory, 'catalog.json'), env), {});
  assert.deepEqual(await detectBuildMetadata(path.join(directory, 'catalog.json'), { PATH: process.env.PATH }), {});
  assert.deepEqual(await detectBuildMetadata(path.join(directory, 'missing/catalog.json'), env), {});
});

test('git fallback reads HEAD and branch from the catalog repository', async t => {
  try { await execute('git', ['--version']); } catch { t.skip('git is unavailable'); return; }
  const directory = await temporaryDirectory(t);
  const gitDirectory = path.join(directory, '.git');
  await mkdir(path.join(gitDirectory, 'refs/heads'), { recursive: true });
  await mkdir(path.join(directory, 'nested'));
  // Materialize a self-contained Git fixture without running commit or modifying
  // the caller's repository. The only Git commands in this test are read-only.
  async function object(type, text) {
    const body = Buffer.from(text);
    const value = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
    const hash = createHash('sha1').update(value).digest('hex');
    const folder = path.join(gitDirectory, 'objects', hash.slice(0, 2));
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, hash.slice(2)), deflateSync(value));
    return hash;
  }
  const tree = await object('tree', '');
  const commit = await object('commit', `tree ${tree}\nauthor Test <test@example.test> 0 +0000\ncommitter Test <test@example.test> 0 +0000\n\nDetection fixture\n`);
  await writeFile(path.join(gitDirectory, 'refs/heads/detection-fixture'), `${commit}\n`);
  await writeFile(path.join(gitDirectory, 'HEAD'), 'ref: refs/heads/detection-fixture\n');
  assert.deepEqual(await detectBuildMetadata(path.join(directory, 'nested/catalog.json'), { PATH: process.env.PATH }), { vcs: { commit, branch: 'detection-fixture' } });
});
