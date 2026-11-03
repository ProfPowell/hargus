import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RULES, ruleInfo, missingExpected, isOneSentence } from '../extension/core/rules.js';
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
