import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, sep, extname } from 'node:path';
import { createRequire } from 'node:module';
const root = resolve(import.meta.dirname, '..');
const three = resolve(dirname(createRequire(resolve(root, 'package.json')).resolve('three')), '..');
const mounts = new Map([
  ['/graphics/', resolve(root, 'dist')],
  ['/foundation/', resolve(root, '../foundation/dist')],
  ['/three/build/', resolve(three, 'build')],
  ['/three/examples/jsm/', resolve(three, 'examples/jsm')],
  ['/', resolve(root, 'examples')],
]);
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript' };
createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const [prefix, directory] = [...mounts].find(([prefix]) => pathname.startsWith(prefix));
    const suffix = pathname === '/' ? 'monument.html' : pathname.slice(prefix.length);
    const file = await realpath(resolve(directory, suffix));
    if (!file.startsWith((await realpath(directory)) + sep)) {
      res.writeHead(403).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(Number(process.env.PORT ?? 5190), '127.0.0.1', function () {
  console.log(`Monument fixture: http://127.0.0.1:${this.address().port}`);
});
