import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewModel, renderPreviews } from '../extension/ui/previews.js';
import { h } from '../extension/ui/render.js';
import meta from '../extension/plugins/meta.js';

const target = { finalUrl: 'https://www.s.test/shop/tents?x=1', host: 'www.s.test' };
const full = {
  title: 'Tents for every trail and every weather condition you might face', description: 'D'.repeat(200), canonical: 'https://www.s.test/shop/tents',
  og: { 'og:title': 'OG title', 'og:description': 'OG description', 'og:image': '/img/og.jpg', 'og:site_name': 'Terra' },
  twitter: { 'twitter:card': 'summary_large_image', 'twitter:title': 'TW title' }, themeColor: '#2a7',
};

test('model: platform fallbacks and image choice', () => {
  const m = previewModel(full, { target, ogImage: { thumb: 'data:image/webp;base64,AAAA' }, interactive: true });
  assert.equal(m.siteName, 'Terra');
  assert.equal(m.google.title, full.title);
  assert.equal(m.og.title, 'OG title');
  assert.equal(m.x.title, 'TW title');
  assert.equal(m.x.description, 'OG description');
  assert.equal(m.x.card, 'summary_large_image');
  assert.equal(m.og.image, 'data:image/webp;base64,AAAA');
  assert.equal(m.themeColor, '#2a7');
  const bare = previewModel({ og: {}, twitter: {} }, { target, interactive: false });
  assert.equal(bare.og.title, 'www.s.test');
  assert.equal(bare.x.card, 'summary');
  assert.equal(bare.og.image, '');
  assert.equal(previewModel({ ...full, themeColor: 'red;}' }, { target }).themeColor, '');
  const remote = previewModel({ ...full, og: { ...full.og, 'og:image': 'https://cdn.s.test/og.jpg' } }, { target, interactive: true });
  assert.equal(remote.og.image, 'https://cdn.s.test/og.jpg');
  assert.equal(previewModel({ ...full, og: { ...full.og, 'og:image': 'https://cdn.s.test/og.jpg' } }, { target, interactive: false }).og.image, '', 'export never loads remote images');
});

test('render: seven cards, truncation, escaping, no undefined', () => {
  const out = String(renderPreviews(previewModel({ ...full, title: '<b>x</b> ' + 'y'.repeat(80) }, { target, ogImage: null, interactive: false }), h));
  assert.equal((out.match(/class="pv-card /g) || []).length, 7);
  for (const name of ['Google', 'X', 'Facebook', 'LinkedIn', 'Slack', 'Discord', 'Bluesky']) assert.match(out, new RegExp(`<figcaption>${name}</figcaption>`));
  assert.match(out, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(out, /D{154}…/, 'Google description cut to 155 with an ellipsis');
  assert.match(out, /WWW\.S\.TEST/, 'Facebook domain upper-cased');
  assert.match(out, /border-left-color:#2a7/);
  assert.match(out, /pv-noimg/);
  assert.doesNotMatch(out, /undefined|NaN/);
});

test('meta glance renders the previews from ctx', () => {
  const out = String(meta.glance({ status: 'ok', data: { ...full, url: target.finalUrl } }, h, { target, results: { links: { data: { ogImage: { thumb: 'data:image/webp;base64,AAAA' } } } }, interactive: true }));
  assert.match(out, /Share previews/);
  assert.match(out, /src="data:image\/webp;base64,AAAA"/);
});
