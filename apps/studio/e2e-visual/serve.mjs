// The built Studio (`apps/studio/dist`) on one port, every unknown path answered with index.html (HeoPress P07a task 13.1).
// No dependencies, so the screenshot run needs nothing native: the API itself is replayed by Playwright.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../dist');
const port = Number(process.argv[2] ?? 1991);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  let file = path.join(root, pathname);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(root, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1');
