import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
/** Hash the compiler, renderer, synth, dependency lock and actual software setup. */
export function rendererHash(
  setup: string | URL = new URL('../../../setups/band/band.setup', import.meta.url),
) {
  const files: string[] = [];
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  for (const name of ['core', 'render', 'synth']) walk(resolve(root, 'packages', name, 'src'));
  files.push(resolve(root, 'package-lock.json'));
  const hash = createHash('sha256');
  for (const path of files.sort()) {
    const bytes = readFileSync(path);
    hash.update(relative(root, path) + '\0' + bytes.length + '\0');
    hash.update(bytes);
  }
  hash.update('\0setup\0');
  hash.update(readFileSync(setup));
  return hash.digest('hex');
}
