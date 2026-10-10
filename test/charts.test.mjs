import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html, raw, esc, isRaw } from '../extension/ui/html.js';
import * as render from '../extension/ui/render.js';

test('html tag escapes values and passes raw through', () => {
  const out = html`<p title="${'"x"'}">${'<b>'}${raw('<i>ok</i>')}${['a', '&']}${null}${false}${0}</p>`;
  assert.ok(isRaw(out));
  assert.equal(String(out), '<p title="&quot;x&quot;">&lt;b&gt;<i>ok</i>a&amp;0</p>');
  assert.equal(esc("'"), '&#39;');
});

test('render.js re-exports the html helpers', () => {
  assert.equal(render.html, html);
  assert.equal(render.raw, raw);
  assert.equal(render.esc, esc);
});
