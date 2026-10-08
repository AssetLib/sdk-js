#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { auditAssets, formatReport } from '../src/audit.mjs';

const help = `Usage: assetlib-audit <app-root> [options]
       npx -y @assetlib/audit@0.1.0 <app-root> [options]

Read-only, local PNG/JPEG/WebP inventory.

  --json                    Print a deterministic JSON report to stdout
  --assets <path>           Restrict images to this file or directory, relative
                            to app-root (repeatable; default: whole root)
  --references <path>       Scan quoted reference hints in this source file or
                            directory, relative to app-root (repeatable)
  --long-edge <pixels>      Dimension-candidate threshold (default: 2048)
  --max-files <count>       Maximum images read (default: 2000)
  --max-entries <count>     Maximum directory entries visited (default: 20000)
  --max-file-bytes <bytes>  Maximum bytes per image (default: 33554432)
  --max-bytes <bytes>       Maximum total image bytes (default: 134217728)
  --help                    Print this help

Symlinks, hidden entries, dependencies, and build directories are excluded.
Reference scanning is opt-in, limited to 500 files / 2 MiB total / 256 KiB each.
No-match is not unused. Size candidates are heuristics, not proven waste.
No account, network, uploads, telemetry, transforms, or source rewrites.

Exit codes: 0 complete within scope; 2 partial coverage; 1 invalid input/failure.
The report is still printed when coverage is partial. No report file is written.
`;

try {
  const { values, positionals } = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, assets: { type: 'string', multiple: true }, references: { type: 'string', multiple: true }, 'long-edge': { type: 'string' }, 'max-files': { type: 'string' }, 'max-entries': { type: 'string' }, 'max-file-bytes': { type: 'string' }, 'max-bytes': { type: 'string' } }, allowPositionals: true, strict: true });
  if (values.help) process.stdout.write(help);
  else {
    if (positionals.length !== 1) throw new Error('Provide exactly one app-root directory. Use --help for usage.');
    const options = { assets: values.assets ?? ['.'], references: values.references ?? [] };
    for (const [flag, key] of Object.entries({ 'long-edge': 'longEdge', 'max-files': 'maxFiles', 'max-entries': 'maxEntries', 'max-file-bytes': 'maxFileBytes', 'max-bytes': 'maxBytes' })) {
      if (values[flag] !== undefined) {
        if (!/^\d+$/.test(values[flag])) throw new Error(`${flag} must be a positive integer.`);
        options[key] = Number(values[flag]);
      }
    }
    const report = await auditAssets(positionals[0], options);
    process.stdout.write(values.json ? JSON.stringify(report, null, 2) + '\n' : formatReport(report));
    if (report.coverage.status === 'partial') process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`Assetlib audit: ${error.message}\n`);
  process.exitCode = 1;
}
