import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
const compiler = fileURLToPath(import.meta.resolve('typescript/lib/tsc.js'));
const result = spawnSync(
  process.execPath,
  [compiler, '-p', fileURLToPath(new URL('../tsconfig.json', import.meta.url))],
  { stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;
