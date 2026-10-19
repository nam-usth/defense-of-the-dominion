#!/usr/bin/env node
// Zero-dependency static file server for local play:  node tools/serve.mjs [port]
// The game has to be served over HTTP: browsers block fetch() of the OBJ/DDS
// assets when index.html is opened straight from disk (file://).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.obj': 'text/plain; charset=utf-8', '.mtl': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary', '.aac': 'audio/aac', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.dds': 'application/octet-stream', '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  if (rel.includes('\0')) { res.writeHead(400); return res.end('Bad request'); } // fs throws (and would kill the server) on NUL
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, rel);
  // stay inside the repo and never serve dotfiles (.git, .claude, ...)
  if (!file.startsWith(ROOT + path.sep) || path.relative(ROOT, file).split(path.sep).some(p => p.startsWith('.'))) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}).on('error', err => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Try another one: node tools/serve.mjs ${PORT + 1}` : err.message);
  process.exit(1);
}).listen(PORT, () => console.log(`Defense of the Dominion → http://localhost:${PORT}/`));
