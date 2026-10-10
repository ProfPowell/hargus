#!/usr/bin/env node
// Example HAR-PLUS remote plugin: runs Google Lighthouse against the reading's URL.
// Shows that heavy tools (Node, Java, Python, SaaS APIs…) plug in over HTTP — no extension rebuild.
//
//   node examples/remote-lighthouse/server.mjs          # listens on http://localhost:8787/
//   then Options → Remote plugins → add  http://localhost:8787/  (send: "Target URL + readout")
//
// Needs Node 20+ and Chrome. Lighthouse is fetched with npx on first run (or set LIGHTHOUSE_BIN).
// Env: PORT (8787), LIGHTHOUSE_BIN, CHROME_PATH (Lighthouse's own), CHROME_FLAGS ("--headless=new").
// Note: Lighthouse loads the URL in its own clean Chrome profile, so logged-in pages show their logged-out view.

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toPluginResult } from '../../extension/plugins/kb/lighthouse.js';

export { toPluginResult };

const PORT = Number(process.env.PORT) || 8787;
const LIGHTHOUSE = process.env.LIGHTHOUSE_BIN ? [process.env.LIGHTHOUSE_BIN] : ['npx', '--yes', 'lighthouse@13.5.0'];
const CHROME_FLAGS = process.env.CHROME_FLAGS || '--headless=new';
function lighthouse(url) {
  const [cmd, ...pre] = LIGHTHOUSE;
  const args = [...pre, url, '--output=json', '--output-path=stdout', '--quiet',
    `--chrome-flags=${CHROME_FLAGS}`, '--only-categories=performance,accessibility,best-practices,seo'];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 128 * 1024 * 1024, timeout: 240_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.split('\n').find(Boolean) || err.message));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Lighthouse did not return JSON')); }
    });
  });
}

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer(async (req, res) => {
    if (req.method !== 'POST') return send(res, 200, { name: 'HAR-PLUS Lighthouse remote plugin', usage: 'POST a HAR-PLUS remote request' });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      const body = JSON.parse(raw || '{}');
      const url = body.target?.finalUrl || body.target?.url;
      if (!/^https?:\/\//.test(url || '')) return send(res, 400, { error: 'request has no target URL' });
      console.log(`lighthouse ${url}`);
      const result = toPluginResult(await lighthouse(url));
      console.log(`  → ${result.summary.map((s) => `${s.label} ${s.value}`).join(', ')}`);
      send(res, 200, result);
    } catch (e) {
      console.error(`  ✗ ${e.message}`);
      send(res, 502, { error: e.message });
    }
  }).listen(PORT, () => console.log(`HAR-PLUS Lighthouse plugin on http://localhost:${PORT}/`));
}
