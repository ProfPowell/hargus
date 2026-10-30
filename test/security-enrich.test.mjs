import { test } from 'node:test';
import assert from 'node:assert/strict';
import exposure from '../extension/plugins/exposure.js';
import observatory from '../extension/plugins/observatory.js';
import reputation from '../extension/plugins/reputation.js';
import { createReading, makeTarget } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';
import { h } from '../extension/ui/render.js';
import { EXPOSURE, OBSERVATORY, REPUTATION, runCase, ODD_CVE, LONG_CVE } from './fixtures/security-enrich-cases.mjs';
import BASELINE from './fixtures/security-enrich-findings-baseline.json' with { type: 'json' };

const PLUGINS = { exposure: [exposure, EXPOSURE], observatory: [observatory, OBSERVATORY], reputation: [reputation, REPUTATION] };

test('findings: every field but places is unchanged from before places (score-check cannot replay enrich plugins)', async () => {
  for (const [id, [plugin, cases]] of Object.entries(PLUGINS)) {
    for (const [name, make] of Object.entries(cases)) {
      const out = await runCase(plugin, make);
      // Through JSON, as the baseline was saved: undefined fields (normalize drops them too) are not differences.
      assert.deepEqual(JSON.parse(JSON.stringify(out.findings.map(({ places, ...f }) => f))), BASELINE[id][name], `${id}: ${name}`);
    }
  }
});

/** Pass one plugin result through normalize(), as a real run does. */
async function normalized(out) {
  const reading = createReading({ entries: [], target: makeTarget('https://www.example.com/', 'E', 'https://www.example.com/') });
  await runPlugins(reading, [{ id: 'n', name: 'N', phase: 'analyze', run: async () => out }], {});
  return reading.log._harplus.plugins.n;
}

test('exposure: CVE IDs stay evidence, never places (they name weaknesses, not where on the site)', async () => {
  for (const [name, make] of Object.entries(EXPOSURE)) {
    const r = await normalized(await runCase(exposure, make));
    assert.ok(r.findings.every((f) => !f.places), name);
  }
  const r = await normalized(await runCase(exposure, EXPOSURE['odd and crowded']));
  const f = r.findings.find((x) => /known CVEs/.test(x.title));
  assert.equal(f.evidence.split(', ').length, 15, 'evidence still names the first 15');
  assert.ok(f.evidence.startsWith(`${ODD_CVE}, ${LONG_CVE}`), 'odd and long IDs kept as given');
});

test('exposure render: answer first, IP rows with a listed word, CVE tags capped at 20 with a count', async () => {
  const out = await runCase(exposure, EXPOSURE.base);
  const s = String(exposure.render({ status: 'ok', ...out }, h));
  assert.ok(s.indexOf('class="stats"') < s.indexOf('<table'));
  assert.match(s, /IPs looked up<\/span><div class="stat-value">3<\/div><span class="stat-note">2 CDN or not listed/);
  assert.match(s, /Open ports<\/span><div class="stat-value">5/);
  assert.match(s, /Sensitive services<\/span><div class="stat-value">1/);
  assert.match(s, /CVEs \(non-CDN\)<\/span><div class="stat-value">20/);
  assert.match(s, /<td>CDN edge<\/td>/);
  assert.match(s, /<a href="https:\/\/www\.shodan\.io\/host\/93\.184\.215\.14"[^>]*>93\.184\.215\.14<\/a>/);
  assert.equal((s.match(/<span class="tag">CVE-/g) || []).length, 20 + 3, '20 for the origin, 3 for the CDN');
  const big = await runCase(exposure, EXPOSURE['odd and crowded']);
  assert.match(String(exposure.render({ status: 'ok', ...big }, h)), / \+230 more/);
});

test('exposure headlines read on their own', async () => {
  const out = await runCase(exposure, EXPOSURE.base);
  const heads = out.summary.filter((x) => x.headline).map((x) => `${x.label} ${x.value}`);
  assert.deepEqual(heads, ['Main IP ports 22, 80, 443, 3306, 8080', 'CVEs (non-CDN) 20']);
});

test('observatory render: grade and failed tests first, no repeated score kv; Grade is the headline', async () => {
  const out = await runCase(observatory, OBSERVATORY['grade B']);
  const s = String(observatory.render({ status: 'ok', ...out }, h));
  assert.ok(s.indexOf('class="stats"') < s.indexOf('<dl'));
  assert.match(s, /Grade<\/span><div class="stat-value">B<\/div><span class="stat-note">75 \/ 100/);
  assert.match(s, /Tests failed<\/span><div class="stat-value">2<\/div><span class="stat-note">of 10/);
  assert.doesNotMatch(s, /<dt>(Grade|Score|Passed|Failed)<\/dt>/);
  assert.match(s, /<a href="https:\/\/developer\.mozilla\.org\/en-US\/observatory\/analyze\?host=www\.example\.com"[^>]*>Full report on MDN<\/a>/);
  assert.match(s, /<dt>Scanned<\/dt><dd>2026-10-08 17:00<\/dd>/);
  assert.deepEqual(out.summary.filter((x) => x.headline), [{ label: 'Grade', headline: true, value: 'B (75)' }]);
  assert.equal(out.findings[0].places, undefined, 'a site grade has no places');
});

test('reputation render: a pass/fail check per service first, then what each returned', async () => {
  const out = await runCase(reputation, REPUTATION['all flagged lower']);
  const s = String(reputation.render({ status: 'ok', ...out }, h));
  assert.ok(s.indexOf('class="checks"') < s.indexOf('<h4>'));
  assert.match(s, /data-status="poor"><span class="sr-only">\(fail\)<\/span>AbuseIPDB: 93\.184\.215\.14<small>30% confidence · 30 reports<\/small>/);
  assert.match(s, /\(fail\)<\/span>VirusTotal: example\.com<small>1 malicious · 0 suspicious/);
  assert.match(s, /\(fail\)<\/span>GreyNoise: 93\.184\.215\.14<small>unknown/);
  assert.match(s, /<h4>VirusTotal<\/h4>/);
  assert.match(s, /<dt>Categories<\/dt><dd>business, tech<\/dd>/);
  const clean = await runCase(reputation, REPUTATION.clean);
  const c = String(reputation.render({ status: 'ok', ...clean }, h));
  assert.equal((c.match(/\(pass\)/g) || []).length, 3);
  assert.match(c, /known service \(Google\)/);
});

test('reputation: the checks agree with the findings, and "Flagged by" is the headline', async () => {
  for (const [name, make] of Object.entries(REPUTATION)) {
    const out = await runCase(reputation, make);
    const s = String(reputation.render({ status: 'ok', ...out }, h));
    assert.equal((s.match(/\(fail\)/g) || []).length, out.findings.length, name);
    const head = out.summary.find((x) => x.headline);
    assert.deepEqual(head, { label: 'Flagged by', headline: true, value: `${out.findings.length} of 3 services` }, name);
  }
  const one = await runCase(reputation, () => { const [r, ctx] = REPUTATION.clean(); return [r, { ...ctx, keys: { abuseipdb: 'a' } }]; });
  assert.equal(one.summary.find((x) => x.headline).value, '0 of 1 service');
});
