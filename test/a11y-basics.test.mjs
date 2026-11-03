import { test } from 'node:test';
import assert from 'node:assert/strict';
import basics from '../extension/plugins/a11y-basics.js';
import { createReading, makeTarget } from '../extension/core/harplus.js';
import { runPlugins } from '../extension/core/plugin-host.js';
import { h } from '../extension/ui/render.js';

const blank = () => createReading({ entries: [], target: makeTarget('https://s.test/', 'S', 'https://s.test/') });
const normalize = async (out) => {
  const reading = blank();
  await runPlugins(reading, [{ id: 'n', name: 'N', phase: 'analyze', run: async () => out }], {});
  return reading.log._harplus.plugins.n;
};
const stats = { images: 10, formFields: 2, links: 20, buttons: 3, landmarks: 4, skipLink: true };
const run = (rules) => basics.run({}, { collected: { rules, errors: [], stats }, results: {}, har: { log: {} } });

test('element checks: places are the sampled elements with their markup; evidence unchanged', () => {
  const r = run([{ id: 'frame-title', impact: 'serious', help: 'Iframes without a title', count: 2,
    samples: [{ selector: 'div > iframe', html: '<iframe src="/a">' }, { selector: 'iframe#b', html: '' }] }]);
  const f = r.findings[0];
  assert.equal(f.evidence, 'div > iframe\niframe#b');
  assert.deepEqual(f.places, [{ selector: 'div > iframe', note: '<iframe src="/a">' }, { selector: 'iframe#b' }]);
});

test('page checks without samples carry no places', () => {
  const f = run([{ id: 'document-title', impact: 'serious', help: 'Document has no <title>', count: 1, page: true, samples: [] }]).findings[0];
  assert.equal(f.evidence, undefined);
  assert.equal(f.places, undefined);
});

test('odd values: a long selector and markup with "<" are capped by normalize and escaped when drawn', async () => {
  const long = `body > ${'div.wrap > '.repeat(80)}button`;
  const saved = await normalize(run([{ id: 'button-name', impact: 'critical', help: 'Buttons without an accessible name', count: 1,
    samples: [{ selector: long, html: '<button><svg><script>alert(1)</script></svg></button>' }] }]));
  const [p] = saved.findings[0].places;
  assert.equal(p.selector.length, 500);
  assert.equal(p.note, '<button><svg><script>alert(1)</script></svg></button>');
  assert.doesNotMatch(String(h.places(saved.findings[0].places)), /<script>/);
});

test('render: answer first; severity words and samples; no counts repeated from the glance; short note', () => {
  const r = run([
    { id: 'image-alt', impact: 'critical', help: 'Images without an alt attribute', count: 4, samples: [{ selector: 'img.a', html: '' }] },
    { id: 'duplicate-id', impact: 'minor', help: 'Duplicate id values', count: 2, samples: [{ selector: '#x', html: '' }] },
  ]);
  const s = String(basics.render(r, h));
  assert.ok(s.indexOf('class="stats"') < s.indexOf('<table'));
  assert.match(s, /Issues<\/span><div class="stat-value">6/);
  assert.match(s, /Failing checks<\/span><div class="stat-value">2/);
  assert.match(s, /<span class="sev" data-sev="high"><span class="sev-ico" aria-hidden="true"><\/span>High<\/span>/);
  assert.match(s, /<span class="sev" data-sev="info"><span class="sev-ico" aria-hidden="true"><\/span>Info<\/span>/);
  assert.match(s, /Images without an alt attribute <code>image-alt<\/code>/);
  assert.match(s, /<code>img\.a<\/code>/);
  assert.doesNotMatch(s, /<th scope="col">count<\/th>/i);
  assert.match(s, /Heuristics only/);
  assert.match(String(basics.render(run([]), h)), /No issues from the basic checks/);
});

test('glance: says when the bars show only the top 8 checks', () => {
  const rules = Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, impact: 'minor', help: `Check ${i}`, count: i + 1, samples: [] }));
  assert.match(String(basics.glance({ data: { rules, stats } }, h)), /top 8 of 9 checks/);
  assert.doesNotMatch(String(basics.glance({ data: { rules: rules.slice(0, 3), stats } }, h)), /top 8/);
});

test('headline reads on its own', () => {
  const s = run([{ id: 'link-name', impact: 'serious', help: 'Links without an accessible name', count: 3, samples: [] }]).summary.find((x) => x.headline);
  assert.equal(`${s.label} ${s.value}`, 'Issues 3 across 1 checks');
});

test('rule ids: every check is its own id, the key of its reference entry; no subject', async () => {
  const { REFERENCE } = await import('../extension/core/a11y-reference.js');
  const { assertRuleIds } = await import('./helpers.mjs');
  const ids = ['html-lang', 'document-title', 'image-alt', 'input-label', 'button-name', 'link-name', 'frame-title', 'meta-viewport', 'duplicate-id', 'tabindex', 'autoplay-audio', 'focusable-hidden', 'fieldset-legend', 'label-empty', 'label-orphaned', 'label-multiple', 'link-broken-anchor', 'link-redundant', 'title-redundant', 'video-captions', 'media-embed', 'layout-table'];
  const r = run(ids.map((id) => ({ id, impact: 'serious', help: id, count: 2, samples: [{ selector: 'p', html: '<p>' }] })));
  assert.deepEqual(r.findings.map((f) => f.id), ids);
  assertRuleIds(r.findings, 'a11y-basics');
  for (const f of r.findings) {
    assert.ok(Object.hasOwn(REFERENCE, f.id), f.id);
    assert.equal(f.subject, undefined, f.id);
  }
});
