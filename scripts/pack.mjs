import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, 'release');
await mkdir(output, { recursive: true });
const sums = [];
for (const name of ['sdk-core', 'sdk-expo']) {
  const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', output], { cwd: path.join(root, 'packages', name), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
  const pack = result[0];
  const bytes = await readFile(path.join(output, pack.filename));
  sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${pack.filename}`);
  console.log(`${pack.filename}: ${bytes.length} bytes`);
}
await writeFile(path.join(output, 'SHA256SUMS'), sums.join('\n') + '\n');
console.log('Release tarballs and SHA256SUMS are in release/. Nothing was published.');
