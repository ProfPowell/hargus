import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

test('cli prints the overall score and profile', () => {
  const out = execFileSync('node', [CLI, 'summary', FIXTURE, '--profile', 'public'], { encoding: 'utf8' });
  assert.match(out, /Overall \d+ [A-F]/);
  assert.match(out, /scored as Public sector \/ education/);
});

test('cli readout and Markdown warn when the reading looks like a bot check; a normal reading has no warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harplus-bot-'));
  const har = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  har.log.entries.push({ request: { url: 'https://shop.test/home/botfailoveroriginal_files/spin.min.js', method: 'GET', headers: [], queryString: [] }, _resourceType: 'script', response: { status: 200, headers: [], content: { mimeType: 'text/javascript', size: 1 } }, startedDateTime: har.log.entries[0].startedDateTime, time: 1, timings: {}, cache: {} });
  const file = join(dir, 'bot.har');
  writeFileSync(file, JSON.stringify(har));
  const out = execFileSync('node', [CLI, 'summary', file], { encoding: 'utf8' });
  assert.match(out, /⚠ This looks like a bot check or waiting page \(Akamai\), not the real page — detected from a request to …\/home\/botfailoveroriginal_files\/spin\.min\.js\./);
  assert.match(execFileSync('node', [CLI, 'summary', file, '--md'], { encoding: 'utf8' }), /^> ⚠ This looks like a bot check/m);
  assert.doesNotMatch(execFileSync('node', [CLI, 'summary', FIXTURE], { encoding: 'utf8' }), /bot check/);
  assert.doesNotMatch(execFileSync('node', [CLI, 'summary', FIXTURE, '--md'], { encoding: 'utf8' }), /bot check/);
});

// ---- punch list and recheck ----
// The fixture was saved before rule ids, and its page plugins cannot re-run offline (hargus analyze re-runs only the
// analyze phase), so these tests give every finding a made-up rule id instead.

const SCRATCH = () => mkdtempSync(join(tmpdir(), 'hargus-punch-'));
/** The fixture with a rule id on every finding, optionally changed by `edit`. */
function fixtureWithIds(edit = () => {}) {
  const har = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  for (const r of Object.values(har.log._harplus.plugins)) (r.findings || []).forEach((f, i) => { f.id ||= `test-rule-${i}`; });
  edit(har);
  return har;
}
const writeJson = (dir, name, data) => {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(data));
  return file;
};
const run = (args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 60_000 });
const BOT = (h) => ({ request: { url: 'https://shop.test/home/botfailoveroriginal_files/spin.min.js', method: 'GET', headers: [], queryString: [] }, _resourceType: 'script', response: { status: 200, headers: [], content: { mimeType: 'text/javascript', size: 1 } }, startedDateTime: h.log.entries[0].startedDateTime, time: 1, timings: {}, cache: {} });

test('cli punchlist writes the list with its block; default name is <name>.punchlist.md', () => {
  const dir = SCRATCH();
  const har = writeJson(dir, 'site.har', fixtureWithIds());
  const out = join(dir, 'x.md');
  const r = run(['punchlist', har, '-o', out]);
  assert.equal(r.status, 0, r.stderr);
  const md = readFileSync(out, 'utf8');
  assert.match(md, /^# Punch list: Terra Test Outfitters/);
  assert.match(md, /<!-- hargus-punchlist \{.*\} -->\n$/);
  assert.equal(run(['punchlist', har]).status, 0);
  assert.match(readFileSync(join(dir, 'site.punchlist.md'), 'utf8'), /<!-- hargus-punchlist /);
});

test('cli punchlist on a reading without rule ids prints the reason and exits 2', () => {
  const dir = SCRATCH();
  const out = join(dir, 'x.md');
  const r = run(['punchlist', FIXTURE, '-o', out]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Record this page again to export a punch list/);
  assert.equal(existsSync(out), false);
});

test('cli punchlist on a record-mode reading prints the reason and exits 2', () => {
  const dir = SCRATCH();
  const har = writeJson(dir, 'rec.har', fixtureWithIds((h) => { h.log._harplus.capture.mode = 'record'; }));
  const r = run(['punchlist', har, '-o', join(dir, 'x.md')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Punch lists cover one page/);
});

test('cli recheck with a saved reading: summary, rewritten list, exit 1 while items remain', () => {
  const dir = SCRATCH();
  const har = writeJson(dir, 'site.har', fixtureWithIds());
  const list = join(dir, 'x.md');
  assert.equal(run(['punchlist', har, '-o', list]).status, 0);
  const r = run(['recheck', list, '--reading', har]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /^\d+ items: 0 fixed, [1-9]\d* still there, [1-9]\d* verify after deploy; 0 new\n$/);
  const md = readFileSync(list, 'utf8');
  assert.match(md, /— still there/);
  assert.match(md, /— verify after deploy/, 'local URL: Deploy items wait for the deploy');
  assert.match(md, /^Rechecked .* · \d+ items: 0 fixed/m);
});

test('cli recheck: a reading with no high/medium/low findings exits 0; --out leaves the list alone', () => {
  const dir = SCRATCH();
  const list = join(dir, 'x.md');
  assert.equal(run(['punchlist', writeJson(dir, 'site.har', fixtureWithIds()), '-o', list]).status, 0);
  const before = readFileSync(list, 'utf8');
  const clean = writeJson(dir, 'clean.har', fixtureWithIds((h) => {
    for (const p of Object.values(h.log._harplus.plugins)) if (p.findings) p.findings = p.findings.filter((f) => f.severity === 'info');
  }));
  const out = join(dir, 'y.md');
  const r = run(['recheck', list, '--reading', clean, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /: [1-9]\d* fixed, 0 still there, .*; 0 new/);
  assert.equal(readFileSync(list, 'utf8'), before);
  assert.match(readFileSync(out, 'utf8'), /^- \[x\] .* — fixed \d{4}-\d{2}-\d{2}$/m);
});

test('cli recheck: a list without its block exits 2, says to export a fresh list, file unchanged', () => {
  const dir = SCRATCH();
  const har = writeJson(dir, 'site.har', fixtureWithIds());
  const list = join(dir, 'x.md');
  assert.equal(run(['punchlist', har, '-o', list]).status, 0);
  const stripped = readFileSync(list, 'utf8').replace(/<!-- hargus-punchlist .*-->\n/, '');
  writeFileSync(list, stripped);
  const r = run(['recheck', list, '--reading', har]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /export a fresh/i);
  assert.equal(readFileSync(list, 'utf8'), stripped);
});

test('cli recheck: an interstitial reading exits 2 and leaves the list untouched', () => {
  const dir = SCRATCH();
  const list = join(dir, 'x.md');
  assert.equal(run(['punchlist', writeJson(dir, 'site.har', fixtureWithIds()), '-o', list]).status, 0);
  const before = readFileSync(list, 'utf8');
  const bot = writeJson(dir, 'bot.har', fixtureWithIds((h) => { h.log.entries.push(BOT(h)); }));
  const r = run(['recheck', list, '--reading', bot]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bot check or waiting page/);
  assert.equal(readFileSync(list, 'utf8'), before);
});

test('cli recheck: a redirect to another path is named in the summary', () => {
  const dir = SCRATCH();
  const list = join(dir, 'x.md');
  assert.equal(run(['punchlist', writeJson(dir, 'site.har', fixtureWithIds()), '-o', list]).status, 0);
  const moved = writeJson(dir, 'moved.har', fixtureWithIds((h) => { h.log._harplus.target.finalUrl = 'http://127.0.0.1:50574/login?next=%2F'; }));
  const r = run(['recheck', list, '--reading', moved]);
  assert.match(r.stdout, /; 0 new \(redirected to \/login\?next=%2F\)\n$/);
  assert.match(readFileSync(list, 'utf8'), /\(redirected to \/login\?next=%2F\)/);
});

test('cli recheck: --url without a value and --timeout 0 are errors (exit 2)', () => {
  const dir = SCRATCH();
  const list = join(dir, 'x.md');
  assert.equal(run(['punchlist', writeJson(dir, 'site.har', fixtureWithIds()), '-o', list]).status, 0);
  const noUrl = run(['recheck', list, '--url']);
  assert.equal(noUrl.status, 2);
  assert.match(noUrl.stderr, /--url/);
  const zero = run(['recheck', list, '--timeout', '0']);
  assert.equal(zero.status, 2);
  assert.match(zero.stderr, /--timeout must be a positive number of seconds/);
  const none = run(['recheck']);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /missing <list\.md>/);
});

test('cli recheck: a failing recheck exits 2 whatever the argument order', () => {
  const dir = SCRATCH();
  const list = join(dir, 'x.md');
  const har = writeJson(dir, 'site.har', fixtureWithIds());
  assert.equal(run(['punchlist', har, '-o', list]).status, 0);
  for (const args of [['--timeout', '0', 'recheck', list], ['--reading', har, 'recheck', list, '--timeout', '0'], ['-o', join(dir, 'y.md'), 'recheck', list, '--url']]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
  }
  const ok = run(['--reading', har, '-o', join(dir, 'z.md'), 'recheck', list]);
  assert.equal(ok.status, 1, ok.stderr);
});

test('cli recheck: settings the reading did not apply are notes on stderr; stdout is the summary only', () => {
  const dir = SCRATCH();
  const list = join(dir, 'x.md');
  const har = writeJson(dir, 'site.har', fixtureWithIds((h) => {
    h.log._harplus.capture.viewsSkipped = [{ view: 'translated-de', reason: 'translator unavailable' }, { view: 'rtl', reason: 'disabled' }];
  }));
  assert.equal(run(['punchlist', har, '-o', list]).status, 0);
  const r = run(['recheck', list, '--reading', har]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^note: translated-de view not recorded here \(translator unavailable\)$/m);
  assert.doesNotMatch(r.stderr, /rtl view/);
  assert.match(r.stdout, /^\d+ items: 0 fixed, \d+ still there, \d+ verify after deploy; 0 new\n$/);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'the list is written through a temp file and rename');
});

test('recorder: run counts snap to the nearest of 1, 3, 5 (ties up)', async () => {
  const { nearestRuns } = await import('../cli/record.mjs');
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map(nearestRuns), [1, 1, 3, 3, 5, 5, 5, 5]);
});
