// Tiny static server for the end-to-end test site, with headers worth reading.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./site/', import.meta.url));
const TYPES = {
  '.map': 'application/json',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};

export function startServer(port = 0) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let path = url.pathname;
    if (path === '/old') { res.writeHead(301, { location: '/' }); return res.end(); }
    // Mock validators (so the e2e run exercises the extension's POSTs without the internet).
    if (path.startsWith('/__mock/nu/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ messages: [{ type: 'error', lastLine: 12, firstColumn: 3, message: 'Duplicate ID “dup”.', extract: '<span id="dup">' }, { type: 'error', lastLine: 12, message: 'Bad value “” for attribute “id” on element “div”: An ID must not be the empty string.' }] }));
    }
    if (path.startsWith('/__mock/greencheck/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ url: path.slice('/__mock/greencheck/'.length), green: true, hosted_by: 'Test Host' }));
    }
    if (path.startsWith('/__mock/css')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const ok = /multipart\/form-data/.test(req.headers['content-type'] || '') && body.includes('name="text"');
      // Deliberate delay: analysis cannot finish before this lookup returns, so a reading
      // stays 'pending' for at least 1.5 s after capture() resolves. The e2e "saved before
      // analysis" assertion relies on this window instead of racing the lookups.
      await new Promise((r) => setTimeout(r, 1500));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(`{ "cssvalidation": { "uri": "x", "validity": false, "result": { "errorcount": 1, "warningcount": 0 }, "errors": [ { "source": "x", "line": 3, "context": " :root ", "type": "value", "message": "${ok ? 'Value Error : color oklch() is not a color value' : 'NO FORM DATA'}" } ], "warnings": [ , ] } }`);
    }
    // Optional reference data for full-fidelity runs: HARPLUS_E2E_WA (webappanalyzer/src), HARPLUS_E2E_WF (web-features data.json)
    if (path.startsWith('/__data/wa/') && process.env.HARPLUS_E2E_WA) {
      try {
        const body = await readFile(join(process.env.HARPLUS_E2E_WA, path.slice('/__data/wa/'.length)));
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        return res.end(body);
      } catch { res.writeHead(404); return res.end(); }
    }
    if (path === '/__data/web-features.json' && process.env.HARPLUS_E2E_WF) {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(await readFile(process.env.HARPLUS_E2E_WF));
    }
    if (req.method === 'POST') { res.writeHead(204); return res.end(); }
    if (path === '/') path = '/index.html';
    if (path === '/api/data.json') path = '/api.json';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    let body;
    try { body = await readFile(file); } catch {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>Not found</title><h1>404</h1>');
    }
    const headers = { 'content-type': TYPES[extname(file)] || 'application/octet-stream' };
    if (path === '/index.html') {
      body = Buffer.from(body.toString().replaceAll('__PORT__', String(server.address().port)));
      Object.assign(headers, {
        server: 'nginx/1.18.0', 'x-powered-by': 'PHP/7.4.3', 'cache-control': 'no-cache',
        'set-cookie': ['sid=abc123; Path=/', 'pref=dark; Path=/; SameSite=Lax'],
      });
    }
    if (path === '/app.css') {
      body = gzipSync(body);
      Object.assign(headers, { 'content-encoding': 'gzip', 'cache-control': 'max-age=3600' });
    }
    res.writeHead(200, headers);
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, '0.0.0.0', () => resolve({
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startServer(Number(process.argv[2]) || 8080);
  console.log(`test site on http://127.0.0.1:${port}/`);
}
