import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';

const roots = new Set([
  '.github', '.gitignore', '.prettierrc.json', 'AGENTS.md', 'CHANGELOG.md',
  'CONTRIBUTING.md', 'LICENSE', 'README.md', 'docs', 'examples',
  'package-lock.json', 'package.json', 'packages', 'scripts', 'setups', 'tests', 'tsconfig.json',
]);
const packages = new Set(['core', 'cli', 'midi', 'midi-live', 'render', 'synth', 'foundation', 'graphics']);
const scripts = new Set(['check-boundary.mjs', 'midi-loopback.ts', 'pack-shared.mjs', 'render-mp3.mjs']);
const files = new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8' }).split('\0').filter(Boolean));
const failures = [];
for (const path of files) {
  if (!existsSync(path)) continue;
  const [root, child] = path.split('/');
  if (!roots.has(root) ||
    (root === 'packages' && !packages.has(child)) ||
    (root === 'scripts' && (!scripts.has(child) || path.split('/').length !== 2)) ||
    (root === 'setups' && child === 'local')) {
    failures.push(`${path}: outside the public tool layout`);
    continue;
  }
  if (/(^|\/)(?:plans?|planning|proposals?|roadmaps?|backlogs?)(?:\/|$)|(^|\/)(?:PROJECT|ROADMAP|BACKLOG|WISHLIST|.+_(?:PLAN|PROPOSAL))\.md$/i.test(path)) {
    failures.push(`${path}: development planning belongs in a private workspace`);
    continue;
  }
  if (lstatSync(path).isSymbolicLink()) {
    failures.push(`${path}: public source must not link to another workspace`);
    continue;
  }
  if (/\.(?:ts|mjs|js|md|json|ya?ml|html|mm|mmi|setup|inst)$/.test(path) &&
    /\/(?:Users|home)\/[a-zA-Z0-9._-]+\//.test(readFileSync(path, 'utf8'))) {
    failures.push(`${path}: contains a personal absolute filesystem path`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Public tool boundary passed.');
}
