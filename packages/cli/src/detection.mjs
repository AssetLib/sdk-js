import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const githubVariables = ['GITHUB_SHA', 'GITHUB_REF_NAME', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_HEAD_REF', 'GITHUB_REF'];
const circleVariables = ['CIRCLE_SHA1', 'CIRCLE_BRANCH', 'CIRCLE_PROJECT_USERNAME', 'CIRCLE_PROJECT_REPONAME', 'CIRCLE_BUILD_NUM', 'CIRCLE_PULL_REQUEST', 'CIRCLE_REPOSITORY_URL'];

// Metadata is optional: omit unusable values instead of blocking a build.
function field(value) {
  return typeof value === 'string' && value.trim() && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
}

function compact(values) {
  const result = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, field(value)]).filter(([, value]) => value !== undefined));
  return Object.keys(result).length ? result : undefined;
}

function detected(env, marker, variables) {
  return env[marker] === 'true' || variables.some(name => typeof env[name] === 'string' && env[name].length > 0);
}

function circleProvider(value) {
  if (!field(value)) return undefined;
  try {
    // CircleCI supplies either an HTTPS URL or an SSH Git remote.
    const remote = value.match(/^(?:[^@/:]+@)?([^/:]+):([^/].*)$/u);
    const host = (remote && !value.includes('://') ? remote[1] : new URL(value).hostname).toLowerCase();
    if (host === 'github.com') return 'github';
    if (host === 'bitbucket.org') return 'bitbucket';
  } catch { /* A missing or unfamiliar remote does not prevent registration. */ }
  return undefined;
}

async function gitValue(args, cwd, env) {
  try {
    const result = await execute('git', ['rev-parse', ...args], { cwd, env, encoding: 'utf8', timeout: 2000, maxBuffer: 4096, windowsHide: true });
    return field(result.stdout.trim());
  } catch { return undefined; }
}

/** Detect build identity without accessing credentials or requiring Git/CI. */
export async function detectBuildMetadata(catalogPath, env = process.env) {
  if (detected(env, 'GITHUB_ACTIONS', githubVariables)) {
    return {
      vcs: compact({ provider: 'github', repository: env.GITHUB_REPOSITORY, commit: env.GITHUB_SHA, branch: field(env.GITHUB_HEAD_REF) ?? env.GITHUB_REF_NAME, pullRequest: field(env.GITHUB_REF)?.match(/^refs\/pull\/(\d+)\/merge$/u)?.[1] }),
      ci: compact({ provider: 'github-actions', runId: env.GITHUB_RUN_ID }),
    };
  }
  if (detected(env, 'CIRCLECI', circleVariables)) {
    const username = field(env.CIRCLE_PROJECT_USERNAME);
    const repositoryName = field(env.CIRCLE_PROJECT_REPONAME);
    const vcs = compact({
      provider: circleProvider(env.CIRCLE_REPOSITORY_URL),
      repository: username && repositoryName ? `${username}/${repositoryName}` : undefined,
      commit: env.CIRCLE_SHA1,
      branch: env.CIRCLE_BRANCH,
      pullRequest: field(env.CIRCLE_PULL_REQUEST)?.match(/\/(?:pull|pulls|pull-requests|pullrequests)\/(\d+)\/?(?:[?#].*)?$/u)?.[1],
    });
    return { ...(vcs ? { vcs } : {}), ci: compact({ provider: 'circleci', runId: env.CIRCLE_BUILD_NUM }) };
  }
  const cwd = path.dirname(path.resolve(catalogPath));
  const [commit, branch] = await Promise.all([gitValue(['HEAD'], cwd, env), gitValue(['--abbrev-ref', 'HEAD'], cwd, env)]);
  const vcs = compact({ commit, branch });
  return vcs ? { vcs } : {};
}
