import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOutline, landmarkLabel } from '../extension/core/outline.js';
import { h } from '../extension/ui/render.js';
import plugin from '../extension/plugins/a11y-structure.js';

const main = { role: 'main', label: '', id: 1 };
const nav = { role: 'navigation', label: 'Main', id: 2 };
const hd = (level, text, landmarks = []) => ({ level, text, landmarks });

test('headings nest by level inside their innermost landmark', () => {
  const t = buildOutline([hd(1, 'Title', [main]), hd(2, 'A', [main]), hd(3, 'A1', [main]), hd(2, 'B', [main])],
    [{ ...main, landmarks: [] }]);
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, 'landmark');
  assert.equal(t[0].role, 'main');
  const [h1] = t[0].children;
  assert.equal(h1.text, 'Title');
  assert.deepEqual(h1.children.map((c) => c.text), ['A', 'B']);
  assert.deepEqual(h1.children[0].children.map((c) => c.text), ['A1']);
});

test('a skipped level is marked; the first heading is not', () => {
  const t = buildOutline([hd(2, 'First'), hd(4, 'Jump'), hd(2, 'Back')], []);
  assert.deepEqual(t.map((n) => n.text), ['First', 'Back']);
  assert.deepEqual(t[0].issues, []);
  const jump = t[0].children[0];
  assert.equal(jump.text, 'Jump');
  assert.deepEqual(jump.issues, ['skipped']);
  assert.deepEqual(t[1].issues, []);
});

test('an empty heading is marked', () => {
  const t = buildOutline([hd(1, 'T'), hd(2, '  ')], []);
  assert.deepEqual(t[0].children[0].issues, ['empty']);
});

test('a landmark without headings still appears, nested in its parent', () => {
  const t = buildOutline([hd(1, 'T', [main])], [{ ...main, landmarks: [] }, { ...nav, landmarks: [] }, { role: 'complementary', label: '', id: 3, landmarks: [main] }]);
  assert.deepEqual(t.map((n) => n.role), ['main', 'navigation']);
  assert.deepEqual(t[0].children.map((n) => n.kind + ':' + (n.role || n.text)), ['heading:T', 'landmark:complementary']);
  assert.deepEqual(t[1].children, []);
});

test('headings outside any landmark are at the top level, in document order with landmarks', () => {
  const t = buildOutline([hd(1, 'Out', []), hd(2, 'In', [main])], [{ ...main, landmarks: [] }]);
  assert.deepEqual(t.map((n) => n.kind), ['heading', 'landmark']);
});

test('two landmarks of one role stay separate; landmarkLabel', () => {
  const a = { role: 'navigation', label: '', id: 7 }, b = { role: 'navigation', label: '', id: 8 };
  const t = buildOutline([hd(2, 'x', [a]), hd(2, 'y', [b])], []);
  assert.equal(t.length, 2);
  assert.equal(landmarkLabel(nav), 'navigation “Main”');
  assert.equal(landmarkLabel(main), 'main');
});

test('render: nested list, badges, red marks', () => {
  const d = {
    headings: [{ level: 1, text: 'T', selector: 'h1', landmarks: [main] }, { level: 3, text: '', selector: 'h3', landmarks: [main] }],
    hiddenHeadings: [], landmarks: {}, landmarkList: [{ ...main, landmarks: [] }, { ...nav, landmarks: [] }],
  };
  const out = String(plugin.render({ data: d }, h));
  assert.match(out, /class="outline tree"/);
  assert.match(out, /navigation “Main”/);
  assert.match(out, /rating-poor[^>]*>skipped level/);
  assert.match(out, /rating-poor[^>]*>empty/);
});
