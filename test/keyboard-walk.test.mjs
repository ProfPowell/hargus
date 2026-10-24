// keyboardWalk's orchestration with a fake CDP session: the two phases around a banner, the restore on errors,
// the navigation warning. The page helpers themselves run in the e2e test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureSession } from '../extension/browser/capture.js';

const st = (uid, over = {}) => ({ uid, sel: `#s${uid}`, role: 'link', name: `S${uid}`, tag: 'a', box: { x: 0, y: uid * 50, w: 10, h: 10 }, visible: true, onScreen: true, tabindex: null, ...over });

/** A session whose page answers each Tab press with the next scripted stop (null: focus on nothing). */
function fake(script, { start = { scrollX: 0, scrollY: 0, focusableAll: 40, focusableCount: 38 }, confine, aside = { ok: true, hidden: 1, attrs: 1, scroll: true }, onPress, failAt } = {}) {
  const s = new CaptureSession(1, { mode: 'snapshot' });
  const calls = [];
  let press = 0;
  s.isolatedContext = async () => 7;
  s.waitForIdle = async () => {};
  s.evaluate = async (fn, args) => {
    calls.push(fn.name);
    if (fn.name === 'kbStart') return start;
    if (fn.name === 'kbConfine') return typeof confine === 'function' ? confine(args) : confine ?? null;
    if (fn.name === 'kbSetAside') return aside;
    if (fn.name === 'kbRestart') return true;
    if (fn.name === 'kbRestore') return { active: 'body', scrollX: 0, scrollY: 0, scrollers: 0, scrollersOff: 0, docH: 3000, aside: 3, banner: true };
    return null;
  };
  s.send = async (method, params) => {
    if (method === 'Input.dispatchKeyEvent') {
      if (params.type === 'rawKeyDown') { press++; onPress?.(s, press); }
      return {};
    }
    if (method === 'Runtime.evaluate') return script[press - 1] ? { result: { objectId: `o${press}` } } : { result: {} };
    if (method === 'Runtime.callFunctionOn') {
      if (press === failAt) return { exceptionDetails: { text: 'boom' } };
      return { result: { value: { ...script[press - 1], before: null, after: null } } };
    }
    return {};
  };
  return { s, calls };
}

test('a banner holding focus: its stops become banner.stops, it is set aside, and the page phase walks from the top', async () => {
  const b = [st(1, { sel: '#b1' }), st(2, { sel: '#b2' }), st(3, { sel: '#b3' })];
  const page = [4, 5, 6, 7, 8].map((u) => st(u));
  const { s, calls } = fake([...b, b[0], ...page, page[0]], {
    confine: ({ uids }) => (assert.deepEqual(uids, [1, 2, 3]), { sel: 'div#onetrust-consent-sdk', kind: 'cmp', tool: 'OneTrust', modal: false, consent: true }),
  });
  const hp = { capture: {} };
  await s.keyboardWalk(hp);
  const k = hp.capture.keyboard;
  assert.deepEqual(calls, ['kbStart', 'kbConfine', 'kbSetAside', 'kbRestart', 'kbRestore']);
  assert.deepEqual(k.banner.stops.map((x) => x.uid), [1, 2, 3]);
  assert.deepEqual({ ...k.banner, stops: undefined }, { sel: 'div#onetrust-consent-sdk', kind: 'cmp', tool: 'OneTrust', modal: false, consent: true, stops: undefined, ended: 'trap', setAside: true, changed: { hidden: 1, attrs: 1, scroll: true } });
  assert.deepEqual(k.stops.map((x) => x.uid), [4, 5, 6, 7, 8], 'the main stops are the page phase');
  assert.equal(k.ended, 'cycle');
  assert.equal(k.trapped, undefined, "the banner phase's trap is not the page's");
  assert.equal(k.confined, undefined);
  assert.equal(k.focusableCount, 38);
  assert.equal(k.reachedY, 400);
  assert.equal(k.docH, 3000);
  assert.equal(k.restored.banner, true);
  assert.equal(k.restored.aside, 3);
});

test('a container that does not qualify, or a banner that cannot be set aside: confined, no page phase', async () => {
  const b = [st(1), st(2)];
  const plain = fake([...b, b[0]], { confine: { sel: 'div.box', kind: null } });
  const hp = { capture: {} };
  await plain.s.keyboardWalk(hp);
  assert.deepEqual(hp.capture.keyboard.confined, { sel: 'div.box', reached: 2, total: 40 });
  assert.equal(hp.capture.keyboard.banner, undefined);
  assert.deepEqual(hp.capture.keyboard.stops.map((x) => x.uid), [1, 2]);
  assert.ok(!plain.calls.includes('kbSetAside'));

  const stuck = fake([...b, b[0]], { confine: { sel: 'div[role=dialog]', kind: 'dialog', modal: true, consent: false }, aside: { ok: false } });
  const hp2 = { capture: {} };
  await stuck.s.keyboardWalk(hp2);
  const k = hp2.capture.keyboard;
  assert.equal(k.banner.setAside, false);
  assert.deepEqual(k.banner.stops, [], 'not duplicated: the stops stay the main list');
  assert.deepEqual(k.stops.map((x) => x.uid), [1, 2]);
  assert.deepEqual(k.confined, { sel: 'div[role=dialog]', reached: 2, total: 40 });
  assert.ok(!stuck.calls.includes('kbRestart'));
});

test('a walk that is not confined asks nothing of the page; a cycle drops the trailing presses that left the page', async () => {
  const stops = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((u) => st(u));
  const { s, calls } = fake([...stops, null, stops[0]], { start: { scrollX: 0, scrollY: 0, focusableAll: 20, focusableCount: 20 } });
  const hp = { capture: {} };
  await s.keyboardWalk(hp);
  assert.deepEqual(calls, ['kbStart', 'kbRestore']);
  assert.equal(hp.capture.keyboard.ended, 'cycle');
  assert.equal(hp.capture.keyboard.stops.length, 11, 'no trailing {none}');
});

test('a frame holding focus past 50 presses ends the phase as confinement', async () => {
  const frame = st(1, { sel: 'iframe#sp', tag: 'iframe', frame: true });
  const { s, calls } = fake(Array(60).fill(frame), { confine: { sel: 'div#sp_message_container_1', kind: 'cmp', tool: 'Sourcepoint', modal: false, consent: true }, aside: { ok: false } });
  const hp = { capture: {} };
  await s.keyboardWalk(hp);
  assert.equal(hp.capture.keyboard.ended, 'frame');
  assert.equal(hp.capture.keyboard.stops[0].presses, 51);
  assert.ok(calls.includes('kbConfine'));
});

test('an error mid-walk keeps the stops and still restores; a navigation warns and restores nothing', async () => {
  const err = fake([st(1), st(2), st(3)], { failAt: 2 });
  const hp = { capture: {} };
  await err.s.keyboardWalk(hp);
  assert.equal(hp.capture.keyboard.ended, 'error');
  assert.match(hp.capture.keyboard.error, /boom/);
  assert.deepEqual(hp.capture.keyboard.stops.map((x) => x.uid), [1]);
  assert.equal(err.calls.at(-1), 'kbRestore');

  const nav = fake([st(1), st(2), st(3)], { onPress: (s, n) => { if (n === 2) s.kbWatch.navigated = true; } });
  const hp2 = { capture: {} };
  await nav.s.keyboardWalk(hp2);
  assert.equal(hp2.capture.keyboard.ended, 'navigated');
  assert.ok(!nav.calls.includes('kbRestore'));
  assert.deepEqual(nav.s.warnings, ['the keyboard walk triggered a navigation; in-page results describe the new page']);
});

test('an outer abort during the page phase still restores the banner', async () => {
  const b = [st(1), st(2)];
  const state = { aborted: false };
  const { s, calls } = fake([...b, b[0], st(3), st(4), st(5)], {
    confine: { sel: 'div#b', kind: 'fixed', modal: false, consent: true },
    onPress: (_, n) => { if (n === 5) state.aborted = true; },
  });
  const hp = { capture: {} };
  await assert.rejects(s.keyboardWalk(hp, state), /aborted/);
  assert.equal(calls.at(-1), 'kbRestore');
  assert.equal(hp.capture.keyboard, undefined, 'the caller reports an abort');
});
