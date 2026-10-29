import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueKey, allIssues } from '../extension/core/issues.js';
import { scoreReading } from '../extension/core/score.js';
import { createReading, makeTarget, toMarkdown, issueMarkdown, findings } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';
import { getPlugins } from '../extension/plugins/index.js';

const blank = () => createReading({ entries: [], target: makeTarget('https://s.test/', 'S', 'https://s.test/') });
const normalize = async (out) => {
  const reading = blank();
  await runPlugins(reading, [{ id: 'n', name: 'N', phase: 'analyze', run: async () => out }], {});
  return reading.log._harplus.plugins.n;
};

test('issueKey: plugin + id, else index; slugged', () => {
  assert.equal(issueKey({ plugin: 'links', id: 'broken-internal', index: 3 }), 'links-broken-internal');
  assert.equal(issueKey({ plugin: 'a11y-basics', index: 0 }), 'a11y-basics-0');
  assert.equal(issueKey({ plugin: 'axe', id: 'Color Contrast!', index: 1 }), 'axe-color-contrast');
});

test('allIssues: report order, info included, duplicate keys made unique', () => {
  const mk = (id) => ({ severity: 'low', category: 'quality', title: 't', ...(id ? { id } : {}) });
  const reading = blank();
  reading.log._harplus.plugins = { p: { id: 'p', name: 'P', status: 'ok', summary: [], findings: [mk('dup'), mk('dup'), mk(), { severity: 'info', category: 'quality', title: 'i', id: 'inf' }] } };
  const scores = scoreReading(reading, getPlugins());
  const issues = allIssues(scores).filter((i) => i.plugin === 'p');
  assert.deepEqual(issues.map((i) => i.key), ['p-dup', 'p-dup-2', 'p-2', 'p-inf']);
  assert.deepEqual(issues.map((i) => i.index), [0, 1, 2, 3]);
});

test('normalize keeps places, whitelists keys, caps 200, drops empties', async () => {
  const r = await normalize({ findings: [{ title: 't', places: [{ url: 'https://a/b', status: 404, line: 12, entry: 3, bogus: 1 }, { bogus: 2 }, ...Array(300).fill({ url: 'u' })] }] });
  const p = r.findings[0].places;
  assert.equal(p.length, 200);
  assert.deepEqual(p[0], { url: 'https://a/b', status: 404, line: 12, entry: 3 });
  assert.equal((await normalize({ findings: [{ title: 't', places: [{ bogus: 1 }] }] })).findings[0].places, undefined);
  const q = (await normalize({ findings: [{ title: 't', places: [{ url: 'x'.repeat(600), status: 'y'.repeat(30), line: -1, entry: 1.5 }] }] })).findings[0].places[0];
  assert.equal(q.url.length, 500); assert.equal(q.status.length, 20); assert.ok(!('line' in q) && !('entry' in q));
});

test('issueMarkdown: same line as the brief; places as sub-bullets, capped at 10', () => {
  const md = issueMarkdown({ severity: 'medium', category: 'content', title: 'T', detail: 'D', pluginName: 'Link check', plugin: 'links',
    places: Array.from({ length: 12 }, (_, i) => ({ status: 404, url: `https://x/${i}`, text: 'a', line: i + 1 })) });
  assert.match(md, /^- \*\*MEDIUM\*\* · content · T — D _\(Link check\)_\n  - 404 https:\/\/x\/0 · “a” · line 1\n/);
  assert.match(md, /\n  - …and 2 more places$/);
  const reading = blank();
  reading.log._harplus.plugins = { links: { id: 'links', name: 'Link check', status: 'ok', summary: [], findings: [{ severity: 'medium', category: 'content', title: 'T', detail: 'D', places: [{ url: 'https://x/0', status: 404 }] }] } };
  assert.ok(toMarkdown(reading).includes(issueMarkdown(findings(reading)[0])));
  assert.ok(toMarkdown(reading).includes('\n  - 404 https://x/0\n'));
});
