import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KEYPATH_SRC } from '../extension/core/keypath-src.js';
import { fnSource } from '../extension/browser/capture.js';
import { kbStart, describeFocus, kbConfine } from '../extension/browser/keyboard-walk.js';
import a11yBasics from '../extension/plugins/a11y-basics.js';
import a11yStructure from '../extension/plugins/a11y-structure.js';

const src = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');

test('one keyPath source: the walk and both collectors take it through pageDeps and define no copy', () => {
  for (const [file, fns] of [['browser/keyboard-walk.js', [kbStart, describeFocus, kbConfine]], ['plugins/a11y-basics.js', [a11yBasics.collect]], ['plugins/a11y-structure.js', [a11yStructure.collect]]]) {
    assert.doesNotMatch(src(file), /const keyPath\s*=|function keyPath\b/, `${file} defines its own keyPath`);
    for (const fn of fns) {
      assert.equal(fn.pageDeps?.keyPath, KEYPATH_SRC, `${file} ${fn.name}`);
      const out = fnSource(fn);
      assert.ok(out.includes(KEYPATH_SRC), `${fn.name}: the source is compiled in`);
      assert.doesNotThrow(() => new Function(`return (${out});`), `${fn.name}: the wrapped source parses`);
    }
  }
  assert.match(KEYPATH_SRC, /^function keyPath\(node\)/);
});

// A tiny element tree, enough for keyPath.
function tree() {
  const mk = (localName, { id = '', classes = [] } = {}) => ({ nodeType: 1, localName, id, classList: classes, children: [], parentElement: null, getRootNode: () => doc });
  const add = (p, c) => { c.parentElement = p; p.children.push(c); return c; };
  const doc = { querySelectorAll: (s) => all.filter((e) => `#${e.id}` === s) };
  const body = mk('body');
  const main = add(body, mk('main', { id: 'main' }));
  const ul = add(main, mk('ul', { classes: ['menu', 'top', 'x'] }));
  const li1 = add(ul, mk('li'));
  const li2 = add(ul, mk('li'));
  const a = add(li2, mk('a'));
  // A shadow root under a host in li1: its own id scope.
  const host = add(li1, mk('my-widget', { id: 'w' }));
  const shadow = { host, querySelectorAll: (s) => inner.filter((e) => `#${e.id}` === s) };
  const btn = { ...mk('button', { id: 'go' }), getRootNode: () => shadow };
  const inner = [btn];
  const all = [body, main, ul, li1, li2, a, host];
  return { a, btn, doc };
}

test('keyPath through fnSource: id steps, classes and nth-of-type, and a shadow host prefix', () => {
  globalThis.CSS ??= { escape: (s) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) };
  const { a, btn, doc } = tree();
  globalThis.document = doc;
  function probe(el) { return keyPath(el); } // eslint-disable-line no-undef
  probe.pageDeps = { keyPath: KEYPATH_SRC };
  const run = new Function(`return (${fnSource(probe)});`)();
  assert.equal(run(a), 'main#main > ul.menu.top > li:nth-of-type(2) > a');
  assert.equal(run(btn), 'my-widget#w >>> button#go');
  delete globalThis.document;
});
