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
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};

// Pages for comparing sites: /cmp.html?site=<name>, or /cmp.html on <name>.localhost. Each differs in weight, alt text, contrast,
// description, language, a blocking script and a server delay; `compare.after` switches to a second version for before and after.
const CMP_SITES = {
  alpha: { title: 'Alpha Outfitters', hue: 205, imgs: 3, big: true, alt: false, desc: true, lang: true, delay: 0, after: { big: false, alt: true } },
  beta: { title: 'Beta Bakery', hue: 25, imgs: 2, big: false, alt: true, desc: true, lang: true, delay: 600, after: { delay: 1500, desc: false } },
  gamma: { title: 'Gamma Garage', hue: 140, imgs: 5, big: true, alt: true, desc: false, lang: true, delay: 300, faint: true, after: {} },
  delta: { title: 'Delta Dental', hue: 280, imgs: 1, big: false, alt: true, desc: true, lang: false, delay: 0, after: {} },
  epsilon: { title: 'Epsilon Estates', hue: 340, imgs: 4, big: false, alt: false, desc: true, lang: true, delay: 1200, after: {} },
  zeta: { title: 'Zeta Zoo', hue: 60, imgs: 6, big: true, alt: false, desc: false, lang: false, delay: 100, faint: true, busyMs: 400, after: {} },
  // For the punch list loop: faint text and images without alt; `compare.after` gives the images alt (the faint text stays).
  kappa: { title: 'Kappa Kilns', hue: 15, imgs: 2, big: false, alt: false, desc: true, lang: true, delay: 0, faint: true, after: { alt: true } },
};

function comparePage(name, after) {
  const base = CMP_SITES[name] || CMP_SITES.alpha;
  const s = after ? { ...base, ...base.after } : base;
  const alt = (i) => (s.alt ? ` alt="Photo ${i + 1} from ${s.title}"` : '');
  const imgs = Array.from({ length: s.imgs }, (_, i) => `<img src="/img/hero.svg?s=${name}&amp;n=${i}"${alt(i)} width="160" height="90">`).join('');
  return `<!doctype html>
<html${s.lang ? ' lang="en"' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${s.title}</title>${s.desc ? `<meta name="description" content="${s.title}, a test page for comparing sites.">` : ''}
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:hsl(${s.hue} 60% 96%);color:#1a1a1a}
header{background:hsl(${s.hue} 55% 32%);color:#fff;padding:32px 24px}main{padding:24px;max-width:60rem}
.row{display:flex;flex-wrap:wrap;gap:12px}img{max-width:100%;height:auto;border-radius:6px}</style></head>
<body><header><h1>${s.title}</h1><p>Open every day of the week.</p></header>
<main><h2>About us</h2><p>${'We have served this town for many years and we are glad you found us. '.repeat(3)}</p>
<div class="row">${imgs}</div>${s.big ? `<p><img src="/img/big.jpg?s=${name}"${alt(9)} width="640" height="360"></p>` : ''}
<h2>Visit</h2><p>Find us on the high street, next to the station.</p>${s.faint ? '<p style="color:#c8c8c8">Opening hours may change on public holidays.</p>' : ''}</main>
${s.busyMs ? `<script>for (const end = Date.now() + ${s.busyMs}; Date.now() < end;);</script>` : ''}</body></html>`;
}

export function startServer(port = 0) {
  const compare = { after: false };
  const hits = []; // [{ path, search, at, cache }] for the document, the frame's image and the streamed video, so tests can order them
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let path = url.pathname;
    if (path === '/' || path === '/index.html' || path === '/img/lazy-a.png' || path === '/img/loop.webm') hits.push({ path, search: url.search, at: Date.now(), cache: req.headers['cache-control'] || '' });
    if (path === '/head-400') {
      if (req.method === 'HEAD') { res.writeHead(400); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>Dislikes HEAD</title><p>ok</p>');
    }
    if (path === '/old') { res.writeHead(301, { location: '/' }); return res.end(); }
    if (path === '/cmp.html') {
      const sub = /^([a-z]+)\.localhost(?::\d+)?$/.exec(req.headers.host || '')?.[1];
      const name = url.searchParams.get('site') || sub || 'alpha';
      const { delay } = { ...CMP_SITES[name], ...(compare.after ? CMP_SITES[name]?.after : {}) };
      if (delay) await new Promise((r) => setTimeout(r, delay));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(comparePage(name, compare.after));
    }
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
    if (path === '/missing-page') {
      await new Promise((r) => setTimeout(r, 400));
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>Not found</title><h1>404</h1>');
    }
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
    // A page that embeds a frame from the other origin (localhost) names the port.
    if (path === '/consent-sp.html' || path === '/consent-sp-open.html') body = Buffer.from(body.toString().replaceAll('__PORT__', String(server.address().port)));
    if (path === '/index.html') {
      body = Buffer.from(body.toString().replaceAll('__PORT__', String(server.address().port)));
      Object.assign(headers, {
        server: 'nginx/1.18.0', 'x-powered-by': 'PHP/7.4.3', 'cache-control': 'no-cache',
        'set-cookie': ['sid=abc123; Path=/', 'pref=dark; Path=/; SameSite=Lax'],
      });
    }
    // A strict style CSP: no inline <style> and no style attributes (gov.uk's kind).
    if (path === '/csp.html') headers['content-security-policy'] = "style-src 'self'";
    if (path === '/app.css') {
      body = gzipSync(body);
      Object.assign(headers, { 'content-encoding': 'gzip', 'cache-control': 'max-age=3600' });
    }
    res.writeHead(200, headers);
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, '0.0.0.0', () => resolve({
    port: server.address().port,
    hits,
    compare,
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startServer(Number(process.argv[2]) || 8080);
  console.log(`test site on http://127.0.0.1:${port}/`);
}
