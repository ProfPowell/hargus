import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RULES, RULE_VIEWS, ruleInfo, missingExpected, isOneSentence } from '../extension/core/rules.js';
import { REFERENCE } from '../extension/core/a11y-reference.js';

test('security header rule is Deploy and says what to send', () => {
  const r = ruleInfo('security', 'missing-hsts', 'security');
  assert.equal(r.tag, 'Deploy');
  assert.match(r.expected, /max-age/);
});

test('accessibility contrast rule is Page with a WCAG link', () => {
  const r = ruleInfo('contrast', 'contrast-pair', 'accessibility');
  assert.equal(r.tag, 'Page');
  assert.match(r.expected, /4\.5:1/);
  assert.ok(r.ref.url.startsWith('https://www.w3.org/WAI/WCAG22/Understanding/'));
});

test('accessibility rules without table text take the reference fix; focus-<kind> resolves', () => {
  const r = ruleInfo('a11y-structure', 'focus-link', 'accessibility');
  assert.equal(r.tag, 'Page');
  assert.ok(isOneSentence(r.expected));
  assert.ok(r.ref.url.startsWith('https://www.w3.org/'));
});

test('axe rules use axe help text and rule page', () => {
  const r = ruleInfo('axe', 'region', 'accessibility', { help: 'All page content should be contained by landmarks', url: 'https://dequeuniversity.com/rules/axe/4.10/region', tags: ['wcag2a'] });
  assert.equal(r.tag, 'Page');
  assert.equal(r.expected, 'All page content should be contained by landmarks.');
  assert.equal(r.ref.url, 'https://dequeuniversity.com/rules/axe/4.10/region');
});

test('timing rules', () => {
  assert.equal(ruleInfo('vitals', 'slow-metric', 'performance').tag, 'Timing');
  assert.equal(ruleInfo('pagespeed', 'anything', 'performance').tag, 'Timing');
});

test('unknown rules default by area; unsure is Deploy', () => {
  assert.equal(ruleInfo('x', 'nope', 'accessibility').tag, 'Page');
  assert.equal(ruleInfo('x', 'nope', 'content').tag, 'Page');
  for (const a of ['performance', 'build', 'sustainability', undefined]) assert.equal(ruleInfo('x', 'nope', a).tag, 'Deploy');
  assert.equal(ruleInfo('x', 'nope', 'accessibility').expected, undefined);
});

test('every Expected is one sentence with no code fence', () => {
  for (const [k, row] of Object.entries(RULES)) {
    if (row.expected) assert.ok(isOneSentence(row.expected), `${k}: ${row.expected}`);
    if (row.tag) assert.ok(['Page', 'Deploy', 'Timing'].includes(row.tag), k);
  }
  for (const id of Object.keys(REFERENCE)) {
    const e = ruleInfo('a11y-basics', id, 'accessibility').expected;
    assert.ok(isOneSentence(e), `${id}: ${e}`);
  }
});

test('performance, build and sustainability rules in the table are tagged', () => {
  for (const [k, row] of Object.entries(RULES)) {
    if (/^(network|head-order|vitals|images|coverage|carbon|html|css|javascript|console|layout|resilience|tech)\//.test(k)) assert.ok(row.tag, `${k} has no tag`);
  }
});

test('environment-dependent rules are Deploy', () => {
  for (const k of ['network/many-third-party-hosts', 'tech/ad-vendors', 'javascript/third-party-js-share', 'security/missing-sri', 'network/asset-errors',
    'console/console-errors', 'console/uncaught-errors', 'network/many-requests', 'network/large-images']) {
    assert.ok(Object.hasOwn(RULES, k), k);
    const [plugin, id] = k.split('/');
    assert.equal(ruleInfo(plugin, id, 'build').tag, 'Deploy', k);
  }
});

test('view rules: ruleInfo names the views each needs; every view is a capture view and every rule a real plugin rule', async () => {
  const { DEFAULTS } = await import('../extension/browser/settings.js');
  assert.deepEqual(ruleInfo('international', 'translated-text-clipped', 'international').views, ['translated-de', 'translated-ar', 'translated-ja']);
  assert.deepEqual(ruleInfo('a11y-views', 'reflow-scroll', 'accessibility').views, ['reflow']);
  assert.deepEqual(ruleInfo('resilience', 'nojs-links-missing', 'quality').views, ['nojs']);
  assert.deepEqual(ruleInfo('layout', 'breakpoint-overflow', 'quality').views, ['breakpoints']);
  assert.equal(ruleInfo('security', 'missing-hsts', 'security').views, undefined);
  const keys = Object.keys(DEFAULTS.capture.views);
  for (const [k, views] of Object.entries(RULE_VIEWS)) {
    for (const v of views) assert.ok(keys.includes(v), `${k}: ${v}`);
    const [plugin, id] = k.split('/');
    // layout's breakpoint findings are built in core/views.js.
    const src = fs.readFileSync(new URL(`../extension/plugins/${plugin}.js`, import.meta.url), 'utf8') +
      (plugin === 'layout' ? fs.readFileSync(new URL('../extension/core/views.js', import.meta.url), 'utf8') : '');
    assert.ok(src.includes(`'${id}'`), `${k} is emitted by ${plugin}`);
  }
  // Every non-info rule of the plugins that read view measurements is tagged.
  const tagged = (plugin, ids) => ids.forEach((id) => assert.ok(RULE_VIEWS[`${plugin}/${id}`], `${plugin}/${id} has views`));
  tagged('a11y-views', ['reflow-scroll', 'reflow-clip', 'spacing-clip', 'spacing-scroll', 'text200-ignored', 'text200-clip', 'text200-scroll', 'dark-light', 'forced-optout', 'forced-icons', 'print-chrome', 'print-overlays']);
  tagged('international', ['pseudo-text-clipped', 'pseudo-sideways-scroll', 'translated-text-clipped', 'translated-sideways-scroll', 'translated-text-left', 'rtl-sideways-scroll']);
  tagged('resilience', ['nojs-almost-no-content', 'nojs-partial-content', 'nojs-links-missing', 'nocss-hidden-content']);
  tagged('layout', ['breakpoint-overflow', 'breakpoint-text-clip']);
});

test('missingExpected on the calibrate readings (informational)', () => {
  const dir = new URL('./e2e/out/calibrate/', import.meta.url);
  if (!fs.existsSync(dir)) return;
  const keys = new Set();
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.har'))) {
    const plugins = JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8')).log?._harplus?.plugins || {};
    for (const [pid, res] of Object.entries(plugins)) for (const fi of res.findings || []) if (fi.id && fi.severity !== 'info') keys.add(`${pid}/${fi.id}`);
  }
  const missing = missingExpected([...keys]);
  console.log(`missingExpected: ${missing.length} of ${keys.size} rule keys seen`, missing.join(' '));
});

test('graded rules: the Expected grade is one the plugin does not flag', async () => {
  const { GRADE_SEVERITY } = await import('../extension/plugins/observatory.js');
  const { RATING_SEVERITY } = await import('../extension/plugins/carbon.js');
  const obs = RULES['observatory/observatory-grade'].expected;
  for (const g of ['A+', 'A', 'A-']) assert.equal(GRADE_SEVERITY(g), null);
  assert.match(obs, /A grade \(A-, A or A\+\)/);
  assert.equal(GRADE_SEVERITY('B+') !== null, true);
  assert.match(RULES['carbon/carbon-rating'].expected, /B or better/);
  for (const g of ['A+', 'A', 'B']) assert.equal(RATING_SEVERITY[g], undefined);
  assert.ok(RATING_SEVERITY.C);
});
