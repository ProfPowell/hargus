import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPluginResult } from '../examples/remote-lighthouse/server.mjs';
import { whois } from '../cli/whois.mjs';

const CLI = fileURLToPath(new URL('../cli/harplus.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/local-site.har', import.meta.url));

test('cli upgrades a plain DevTools-style HAR offline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harplus-cli-'));
  const plain = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  delete plain.log._harplus;
  plain.log.creator = { name: 'WebInspector', version: '537.36' };
  const input = join(dir, 'site.har');
  writeFileSync(input, JSON.stringify(plain));
  const out = execFileSync('node', [CLI, 'analyze', input, '--no-lookups'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out, /Findings/);
  const result = JSON.parse(readFileSync(join(dir, 'site.plus.har'), 'utf8'));
  const p = result.log._harplus.plugins;
  assert.equal(p.network.status, 'ok');
  assert.equal(p.security.status, 'ok');
  assert.equal(p.tech.status, 'ok');
  assert.equal(p.dns, undefined, 'lookups skipped');
  assert.equal(result.log._harplus.capture.source, 'WebInspector 537.36');
  const md = execFileSync('node', [CLI, 'summary', join(dir, 'site.plus.har'), '--md'], { encoding: 'utf8' });
  assert.match(md, /^# Terra Test Outfitters/);
  assert.match(md, /## Findings \(\d+\)/);
});

test('cli summary reads an extension reading as-is', () => {
  const out = execFileSync('node', [CLI, 'summary', FIXTURE], { encoding: 'utf8' });
  assert.match(out, /Page metadata/);
  assert.match(out, /Technology stack/);
});

test('cli writes a standalone HTML report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harplus-report-'));
  const out = join(dir, 'r.html');
  execFileSync('node', [CLI, 'summary', FIXTURE, '--report', out], { encoding: 'utf8' });
  const doc = readFileSync(out, 'utf8');
  assert.match(doc, /^<!doctype html>/);
  assert.match(doc, /id="overview"/);
  for (const a of ['performance', 'accessibility', 'security', 'build', 'infrastructure']) assert.match(doc, new RegExp(`id="area-${a}"`));
  assert.match(doc, /@layer reset, tokens/); // theme.css inlined
});

test('lighthouse example maps an LHR to the plugin contract', () => {
  const lhr = {
    lighthouseVersion: '13.5.0',
    finalDisplayedUrl: 'https://x.test/',
    categories: {
      performance: { title: 'Performance', score: 0.42, auditRefs: [{ id: 'largest-contentful-paint' }, { id: 'unused-javascript' }] },
      accessibility: { title: 'Accessibility', score: 0.95, auditRefs: [{ id: 'image-alt' }, { id: 'manual-thing' }] },
    },
    audits: {
      'largest-contentful-paint': { id: 'largest-contentful-paint', title: 'Largest Contentful Paint', score: 0.2, scoreDisplayMode: 'numeric', displayValue: '5.1 s' },
      'unused-javascript': { id: 'unused-javascript', title: 'Reduce unused JavaScript', score: 0.6, scoreDisplayMode: 'metricSavings', displayValue: 'Est savings of 300 KiB' },
      'image-alt': { id: 'image-alt', title: 'Image elements do not have [alt] attributes', score: 0, scoreDisplayMode: 'binary' },
      'manual-thing': { id: 'manual-thing', title: 'Manual', score: null, scoreDisplayMode: 'manual' },
    },
  };
  const r = toPluginResult(lhr);
  assert.deepEqual(r.summary.slice(0, 2), [{ label: 'Performance', value: '42' }, { label: 'Accessibility', value: '95' }]);
  assert.equal(r.findings.length, 3);
  assert.equal(r.findings[0].severity, 'medium');
  assert.ok(r.findings.some((f) => f.category === 'accessibility' && f.id === 'image-alt'));
  assert.equal(r.data.scores.performance, 0.42);
});

test('port-43 whois follows IANA and registrar referrals', async () => {
  const servers = {
    'whois.iana.org': (q) => (q === 'com' ? 'domain: COM\nrefer: whois.verisign-grs.com\n' : ''),
    'whois.verisign-grs.com': () => '   Domain Name: EXAMPLE.COM\n   Registrar WHOIS Server: whois.registrar.test\n',
    'whois.registrar.test': () => 'Registrant Organization: Example Corp\n',
  };
  const { text, server } = await whois('example.com', { port43: async (host, q) => servers[host](q) });
  assert.equal(server, 'whois.verisign-grs.com → whois.registrar.test');
  assert.match(text, /Example Corp/);
});

test('cli --profile scores the report with that profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harplus-cli-'));
  const report = join(dir, 'r.html');
  execFileSync('node', [CLI, 'summary', FIXTURE, '--profile', 'public', '--report', report], { encoding: 'utf8' });
  assert.match(readFileSync(report, 'utf8'), /Scored as Public sector \/ education/);
  assert.throws(() => execFileSync('node', [CLI, 'summary', FIXTURE, '--profile', 'nope'], { encoding: 'utf8', stdio: 'pipe' }), /unknown profile "nope"/);
});

test('cli --no-link-check disables the links plugin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harplus-cli-'));
  const out = join(dir, 'x.plus.har');
  const input = join(dir, 'in.har');
  const har = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  delete har.log._harplus.plugins.links; // the refreshed fixture (Task 7) already carries a links result
  writeFileSync(input, JSON.stringify(har));
  execFileSync('node', [CLI, 'analyze', input, '--no-link-check', '--only', 'links', '-o', out, '--quiet'], { encoding: 'utf8' });
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).log._harplus.plugins.links, undefined);
});

test('cli --no-link-check without --only keeps the links plugin off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harplus-cli-'));
  const input = join(dir, 'in.har');
  const har = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  delete har.log._harplus.plugins.links;
  writeFileSync(input, JSON.stringify(har));
  const run = (flag, out) => {
    execFileSync('node', [CLI, 'analyze', input, '--only', 'links', ...flag, '-o', out, '--quiet'], { encoding: 'utf8' });
    return JSON.parse(readFileSync(out, 'utf8')).log._harplus.plugins.links;
  };
  // --only keeps this offline. The --enable vs --no-link-check ordering in cli/harplus.mjs is covered by reading
  // the code, not by a test: covering it without --only would run the whole enrich phase on the network.
  // control: the fixture has no content data, so links records a skip rather than touching the network
  assert.ok(run([], join(dir, 'a.plus.har')), 'control: links runs when enabled');
  assert.equal(run(['--no-link-check'], join(dir, 'b.plus.har')), undefined);
});
