import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const name = process.argv[2];
if (name !== 'foundation' && name !== 'graphics') throw new Error('Choose foundation or graphics');
const output = process.argv[3];
if (!output)
  throw new Error('Usage: node scripts/pack-shared.mjs foundation|graphics OUTPUT_DIRECTORY');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const dirty = git(
  'status',
  '--porcelain',
  '--untracked-files=all',
  '--',
  `packages/${name}`,
  'scripts/pack-shared.mjs',
);
if (dirty)
  throw new Error('Commit reviewed shared package source and packaging script before exporting.');
const pkg = JSON.parse(
  readFileSync(new URL(`../packages/${name}/package.json`, import.meta.url), 'utf8'),
);
const directory = resolve(output);
const filename = `midi-madness-${name}-${pkg.version}.tgz`;
if (existsSync(resolve(directory, filename)))
  throw new Error(`Artifact version already exists: ${filename}`);
mkdirSync(directory, { recursive: true });
const [artifact] = JSON.parse(
  execFileSync(
    'npm',
    ['pack', '--workspace', `@midi-madness/${name}`, '--json', '--pack-destination', directory],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  ),
);
if (artifact.filename !== filename) throw new Error('Unexpected package artifact filename');
const provenance = {
  package: pkg.name,
  version: pkg.version,
  sourceCommit: git('rev-parse', 'HEAD'),
  sourceTree: git('rev-parse', `HEAD:packages/${name}`),
  filename,
  integrity: artifact.integrity,
  files: artifact.files.map(({ path }) => path),
};
writeFileSync(resolve(directory, `${filename}.json`), JSON.stringify(provenance, null, 2) + '\n');
process.stdout.write(`${resolve(directory, filename)}\n`);
