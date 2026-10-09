import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { catalogHash, readCatalog } from './catalog.mjs';
import { generateCatalog } from './codegen.mjs';
import { detectBuildMetadata } from './detection.mjs';
import { scanReferences } from './references.mjs';
import { adopt, formatAdoption } from './adopt.mjs';

const HELP = `Usage:
  assetlib sync --catalog <path> --platform <ios|android|web|expo> --app-version <v> --build-number <n>
    [--references <dir|file>]... [--root <dir>] [--console <origin>] [--org <uuid>] [--app <uuid>]
    [--sdk-version <v>] [--allow-insecure-loopback] [--dry-run] [--json]
  assetlib hash --catalog <path>
  assetlib check --catalog <path> --generated <path>
  assetlib adopt --catalog <path> --src <dir> [--src <dir>]...
    [--generated <path>] [--client-import "<module>#<export>"] [--min-edge <px>] [--apply] [--json]

ASSETLIB_TOKEN supplies the sync token; ASSETLIB_CONSOLE, ASSETLIB_ORG, and ASSETLIB_APP supply defaults.
Sync requires HTTPS; --allow-insecure-loopback permits HTTP only for localhost, 127.0.0.1, or [::1].
Exit codes: 0 success, 1 error or generated-file mismatch, 2 partial reference scan, 3 nothing to adopt.
`;
const optionsByCommand = {
  sync: ['catalog', 'platform', 'app-version', 'build-number', 'references', 'root', 'console', 'org', 'app', 'sdk-version', 'allow-insecure-loopback', 'dry-run', 'json'],
  hash: ['catalog'],
  check: ['catalog', 'generated'],
  adopt: ['catalog', 'src', 'generated', 'client-import', 'min-edge', 'apply', 'json'],
};

function parseArgs(args) {
  const [command, ...rest] = args;
  if (!optionsByCommand[command]) throw new Error('Expected sync, hash, check, or adopt. Use --help.');
  const options = { references: [], src: [] };
  for (let i = 0; i < rest.length; i++) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(rest[i]);
    if (!match || !optionsByCommand[command].includes(match[1])) throw new Error('Unknown option. Use --help. Token flags are not supported.');
    const [, name, inline] = match;
    if (!['references', 'src'].includes(name) && Object.hasOwn(options, name)) throw new Error(`Duplicate --${name} option.`);
    if (['dry-run', 'apply', 'json', 'allow-insecure-loopback'].includes(name)) {
      if (inline !== undefined) throw new Error(`--${name} does not take a value.`);
      options[name] = true;
      continue;
    }
    const value = inline ?? rest[++i];
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value.`);
    if (['references', 'src'].includes(name)) options[name].push(value);
    else options[name] = value;
  }
  for (const name of ['catalog', ...(command === 'sync' ? ['platform', 'app-version', 'build-number'] : command === 'check' ? ['generated'] : [])]) {
    if (!options[name]) throw new Error(`--${name} is required.`);
  }
  return { command, options };
}

function buildIdentity(options) {
  if (!['ios', 'android', 'web', 'expo'].includes(options.platform)) throw new Error('--platform must be ios, android, web, or expo.');
  for (const name of ['app-version', 'build-number']) {
    if (!/^[A-Za-z0-9._+-]{1,64}$/.test(options[name])) throw new Error(`--${name} must be 1–64 letters, digits, periods, underscores, pluses, or hyphens.`);
  }
  if (options['sdk-version'] !== undefined && options['sdk-version'].length > 200) throw new Error('--sdk-version must be at most 200 characters.');
  return {
    platform: options.platform,
    appVersion: options['app-version'],
    buildNumber: options['build-number'],
    ...(options['sdk-version'] ? { sdkVersion: options['sdk-version'] } : {}),
  };
}

function endpoint(options, env) {
  const origin = options.console ?? env.ASSETLIB_CONSOLE;
  const org = options.org ?? env.ASSETLIB_ORG;
  const app = options.app ?? env.ASSETLIB_APP;
  if (!origin || !org || !app) throw new Error('Sync requires --console, --org, and --app (or their ASSETLIB_ environment variables).');
  if (![org, app].every(value => /^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$/.test(value))) throw new Error('--org and --app must be UUIDs.');
  let url;
  try { url = new URL(origin); } catch { throw new Error('--console must be an HTTP(S) origin.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('--console must be an HTTP(S) origin without credentials, a path, query, or fragment.');
  if (url.protocol !== 'https:' && !(options['allow-insecure-loopback'] && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('--console requires HTTPS; HTTP is allowed only for localhost, 127.0.0.1, or [::1] with --allow-insecure-loopback.');
  return `${url.origin}/api/apps/${org}/${app}/builds`;
}

async function postBuild(url, token, body) {
  if (!token) throw new Error('ASSETLIB_TOKEN is required for sync.');
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(30_000),
    redirect: 'manual',
  });
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body ?? []) {
    length += chunk.byteLength;
    if (length > 256 * 1024) throw new Error('Console response exceeds 256 KiB.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let result;
  try { result = JSON.parse(text); } catch { /* Plain-text server errors are also useful. */ }
  if (![200, 201].includes(response.status)) {
    const message = typeof result?.error === 'string' ? result.error
      : typeof result?.error?.message === 'string' ? result.error.message
        : typeof result?.message === 'string' ? result.message : text || response.statusText;
    throw new Error(`HTTP ${response.status}: ${message}`);
  }
  if (!result || typeof result.buildId !== 'string' || typeof result.catalogHash !== 'string' ||
      !['created', 'existing', 'conflicting'].every(key => Array.isArray(result.placements?.[key]))) {
    throw new Error('Console returned an invalid build registration response.');
  }
  return result;
}

/** The binary's boundary: every output is scrubbed even if a server echoes a token. */
export async function main(args = process.argv.slice(2), env = process.env, io = process) {
  const redact = text => env.ASSETLIB_TOKEN ? String(text).replaceAll(env.ASSETLIB_TOKEN, '[REDACTED]') : String(text);
  const write = text => io.stdout.write(redact(text));
  const json = value => write(JSON.stringify(value, null, 2) + '\n');
  const wantsJson = args.includes('--json');
  try {
    if (!args.length || args[0] === '--help' || args.length === 2 && args[1] === '--help' && optionsByCommand[args[0]]) {
      write(HELP); return 0;
    }
    const { command, options } = parseArgs(args);
    const catalogPath = path.resolve(options.catalog);
    const catalog = await readCatalog(catalogPath);
    if (command === 'adopt') {
      const report = await adopt({ catalogPath, catalog, src: options.src, generated: options.generated, clientImport: options['client-import'], minEdge: options['min-edge'] === undefined ? 64 : Number(options['min-edge']), apply: options.apply });
      if (options.json) json(report);
      else write(formatAdoption(report));
      return report.summary.candidates ? 0 : 3;
    }
    if (command === 'hash') { write(catalogHash(catalog) + '\n'); return 0; }
    if (command === 'check') {
      const current = await readFile(path.resolve(options.generated), 'utf8');
      if (current !== generateCatalog(catalog)) throw new Error('Generated file differs from the catalog. Regenerate it with assetlib-codegen.');
      write('Generated file is up to date.\n'); return 0;
    }
    const identity = buildIdentity(options);
    const metadata = await detectBuildMetadata(catalogPath, env);
    const scan = await scanReferences({ catalog, catalogPath, references: options.references, root: options.root });
    const payload = {
      schemaVersion: 1,
      build: { ...identity, ...metadata },
      catalog,
      catalogHash: catalogHash(catalog),
      ...(options.references.length ? { codeReferences: scan.codeReferences } : {}),
    };
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 256 * 1024) throw new Error('Build registration body exceeds 256 KiB.');
    // Diagnostics stay off stdout so dry-run and --json always emit the exact contract.
    if (scan.partial) {
      const warning = { warning: 'Reference scan was partial; references may be truncated.', issues: scan.issues };
      io.stderr.write(redact(options.json ? JSON.stringify(warning) + '\n' : warning.warning + '\n' + scan.issues.slice(0, 10).map(issue => `  ${issue.path}: ${issue.reason}`).join('\n') + '\n'));
    }
    if (options['dry-run']) json(payload);
    else {
      const result = await postBuild(endpoint(options, env), env.ASSETLIB_TOKEN, body);
      if (options.json) json(result);
      else {
        write(`Build: ${result.buildId}\nHash: ${result.catalogHash}\n`);
        write(`Created: ${result.placements.created.join(', ') || 'none'}\nExisting: ${result.placements.existing.join(', ') || 'none'}\n`);
        write(`Conflicting: ${result.placements.conflicting.length ? result.placements.conflicting.map(item => `${item.key} (${item.reason})`).join(', ') : 'none'}\n`);
      }
    }
    return scan.partial ? 2 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error.';
    if (wantsJson) json({ error: message });
    else io.stderr.write(redact(`Assetlib: ${message}\n`));
    return 1;
  }
}
