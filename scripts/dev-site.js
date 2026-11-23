#!/usr/bin/env node
// Local preview of the site with the same serverless handlers Vercel runs,
// reading ./data from disk:  node scripts/dev-site.js [port]
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';

process.env.SIGNAL_DATA_LOCAL = process.env.SIGNAL_DATA_LOCAL || '1';
const port = Number(process.argv[2]) || 4173;
const SITE = path.resolve('site');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const handlers = {
  '/api/data': (await import('../api/data.js')).default,
  '/api/aggregate': (await import('../api/aggregate.js')).default,
  '/api/meta': (await import('../api/meta.js')).default,
};

function shim(req, res, url) {
  req.query = Object.fromEntries(url.searchParams.entries());
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (o) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(o));
    return res;
  };
  res.send = (b) => (res.end(b), res);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const h = handlers[url.pathname];
    if (h) {
      shim(req, res, url);
      return h(req, res);
    }
    let p = url.pathname;
    if (p === '/' || /^\/(headlines|outlets|method|article\/[^/]+)$/.test(p)) p = '/index.html';
    const file = path.join(SITE, p);
    if (!file.startsWith(SITE)) return res.writeHead(403).end();
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  })
  .listen(port, () => console.log(`[signal] site at http://localhost:${port} (data from ./data)`));
