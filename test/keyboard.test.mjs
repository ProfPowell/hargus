import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeKeyboard, walkEnd, walkComplete, KB_LIMITS, CMP_TOOLS, confinedCandidate, dropTrailingNone, ENDED_LABELS, isBanner, frameAction, confinedVerdict, firstPageStop, skipLinkStop } from '../extension/core/keyboard.js';
import plugin, { analyzeStructure } from '../extension/plugins/a11y-structure.js';
import { OVERLAP } from '../extension/core/a11y-overlap.js';
import { h } from '../extension/ui/render.js';
import { DEFAULTS } from '../extension/browser/settings.js';

let uid = 0;
/** A clean stop: named, visible, on screen, with a focus change, below the previous one. */
const stop = (over = {}) => {
  uid++;
  return { uid, sel: `a.s${uid}`, role: 'link', name: `Link ${uid}`, tag: 'a', box: { x: 10, y: uid * 40, w: 100, h: 20 },
    visible: true, onScreen: true, tabindex: 0, changed: true, ...over };
};
const skip = (target = { exists: true, visible: true, focusable: false, landmark: true, heading: false }) =>
  stop({ name: 'Skip to content', skip: { href: '#main', ...target } });
const walk = (stops, over = {}) => ({ stops, ended: 'cycle', ms: 1200, ...over });
const t = (r) => r.findings.map((f) => `${f.severity}:${f.title}`);

test('limits: 2,000 stops (time is the real bound), 60 s, 50 presses in a frame, a quarter of the focusables', () => {
  assert.deepEqual(KB_LIMITS, { stops: 2000, ms: 60_000, framePresses: 50, confineShare: 0.25 });
});

test('a clean walk gives no findings', () => {
  const r = analyzeKeyboard(walk([skip(), stop(), stop(), stop()]));
  assert.deepEqual(t(r), []);
  assert.ok(r.summary);
});

test('a trap is a high finding with the trapped selectors', () => {
  const a = stop({ sel: 'button.t1' });
  const b = stop({ sel: 'button.t2' });
  const r = analyzeKeyboard(walk([skip(), stop(), a, b, a, b, a, b], { ended: 'trap', trapped: ['button.t1', 'button.t2'] }));
  assert.deepEqual(t(r), ['high:Keyboard focus gets trapped']);
  assert.equal(r.findings[0].id, 'kb-trap');
  assert.equal(r.findings[0].evidence, 'button.t1\nbutton.t2');
});

test('focus lost in the middle counts; trailing nones do not', () => {
  const r = analyzeKeyboard(walk([skip(), stop(), { none: true }, stop(), { none: true }, { none: true }, stop(), { none: true }]));
  assert.deepEqual(t(r), ['medium:Focus is lost 3 times while tabbing']);
  assert.deepEqual(t(analyzeKeyboard(walk([skip(), stop(), { none: true }, stop()]))), ['medium:Focus is lost 1 time while tabbing']);
  assert.deepEqual(t(analyzeKeyboard(walk([skip(), stop(), { none: true }], { ended: 'left-page' }))), []);
});

test('hidden or off-screen stops (medium), counted once each', () => {
  const hid = stop({ visible: false });
  const off = stop({ onScreen: false });
  const r = analyzeKeyboard(walk([skip(), hid, off, stop()]));
  assert.deepEqual(t(r), ['medium:2 keyboard stops are hidden or off-screen']);
  assert.equal(r.findings[0].id, 'kb-hidden');
  assert.equal(r.findings[0].evidence, `${hid.sel}\n${off.sel}`);
  assert.deepEqual(t(analyzeKeyboard(walk([skip(), off, off]))), ['medium:1 keyboard stop is hidden or off-screen']);
});

test('stops without an accessible name (high)', () => {
  assert.deepEqual(t(analyzeKeyboard(walk([skip(), stop({ name: '' }), stop({ name: '  ' }), stop()]))), ['high:2 keyboard stops have no accessible name']);
  assert.deepEqual(t(analyzeKeyboard(walk([skip(), stop({ name: '' })]))), ['high:1 keyboard stop has no accessible name']);
});

test('a stop whose ring is on its wrapper is not reported', () => {
  const r = analyzeKeyboard(walk([skip(), stop({ changed: true, changedOn: 'parent' }), stop()]));
  assert.ok(!r.findings.some((f) => f.id === 'kb-no-focus-style'));
});

test('frame stops are not judged for focus style', () => {
  const frame = analyzeKeyboard(walk([skip(), stop({ frame: true, changed: false }), stop()]));
  assert.ok(!frame.findings.some((f) => f.id === 'kb-no-focus-style'));
  const plain = analyzeKeyboard(walk([skip(), stop({ changed: false }), stop()]));
  assert.ok(plain.findings.some((f) => f.id === 'kb-no-focus-style'));
});

test('stops with no visible focus change (medium); unknown (null) is not counted', () => {
  const r = analyzeKeyboard(walk([skip(), stop({ changed: false }), stop({ changed: false }), stop({ changed: null })]));
  assert.deepEqual(t(r), ['medium:2 keyboard stops show no visible focus change']);
  assert.equal(r.findings[0].id, 'kb-no-focus-style');
});

test('positive tabindex (low), from stops and the collected focusables, by selector', () => {
  const p = stop({ tabindex: 3 });
  const r = analyzeKeyboard(walk([skip(), p, stop()]), { focusables: [{ selector: p.sel, tabindex: 3 }, { selector: 'input.x', tabindex: 2 }, { selector: 'a.y', tabindex: 0 }] });
  assert.deepEqual(t(r), ['low:2 elements use a positive tabindex']);
  assert.equal(r.findings[0].id, 'kb-positive-tabindex');
});

test('tab order jumping back up the page (low): > 200 px above the previous stop and overlapping it horizontally', () => {
  const s1 = stop({ box: { x: 0, y: 1000, w: 200, h: 20 } });
  const up = stop({ box: { x: 50, y: 500, w: 100, h: 20 } }); // 500 px up, overlaps: a jump
  const side = stop({ box: { x: 600, y: 100, w: 100, h: 20 } }); // far up but no horizontal overlap
  const near = stop({ box: { x: 600, y: 0, w: 100, h: 20 } }); // only 100 px up
  const pinned = stop({ box: { x: 600, y: -900, w: 100, h: 20 }, fixed: true }); // fixed/sticky: ignored
  const top = { ...skip(), box: { x: 0, y: 0, w: 100, h: 20 } };
  const r = analyzeKeyboard(walk([top, s1, up, side, near, pinned]));
  assert.deepEqual(t(r), ['low:Tab order jumps back up the page 1 time']);
  assert.equal(r.findings[0].evidence, up.sel);
  assert.equal(r.findings[0].id, 'kb-jumps');
});

test('skip link: good, missing, hidden, not a skip link, or no first stop', () => {
  assert.deepEqual(t(analyzeKeyboard(walk([skip(), stop()]))), [], 'good: a landmark target');
  assert.deepEqual(t(analyzeKeyboard(walk([skip({ exists: true, visible: true, focusable: true, landmark: false, heading: false }), stop()]))), [], 'good: a focusable target');
  assert.deepEqual(t(analyzeKeyboard(walk([skip({ exists: true, visible: true, focusable: false, landmark: false, heading: true }), stop()]))), [], 'good: a heading target');
  const missing = analyzeKeyboard(walk([skip({ exists: false }), stop()]));
  assert.deepEqual(t(missing), ["medium:The skip link's target is missing"]);
  assert.match(missing.findings[0].title, /missing$/);
  assert.equal(missing.findings[0].id, 'kb-skip-target');
  assert.match(missing.findings[0].detail, /#main/);
  assert.deepEqual(t(analyzeKeyboard(walk([skip({ exists: true, visible: false, focusable: true, landmark: true, heading: false }), stop()]))), ["medium:The skip link's target is hidden"], 'hidden');
  assert.deepEqual(t(analyzeKeyboard(walk([skip({ exists: true, visible: true, focusable: false, landmark: false, heading: false }), stop()]))), ["medium:The skip link's target can't take focus"], 'a plain div');
  const none = analyzeKeyboard(walk([stop(), stop()]));
  assert.deepEqual(t(none), ['low:No skip link as the first stop']);
  assert.equal(none.findings[0].id, 'kb-no-skip-link');
  assert.deepEqual(t(analyzeKeyboard(walk([{ none: true }, { none: true }], { ended: 'left-page' }))), [], 'no stops at all: nothing to judge');
});

test('clickable elements that cannot be reached by keyboard (medium), minus any that were stops', () => {
  const s = stop();
  const r = analyzeKeyboard(walk([skip(), s]), { clickables: [{ selector: 'div.card', text: 'Card' }, { selector: s.sel }, { selector: 'span.x' }] });
  assert.deepEqual(t(r), ["medium:2 clickable elements can't be reached by keyboard"]);
  assert.equal(r.findings[0].id, 'kb-clickable');
  assert.equal(r.findings[0].evidence, 'div.card\nspan.x');
  assert.deepEqual(t(analyzeKeyboard(walk([skip()]), { clickables: [{ selector: 'div.card' }] })), ["medium:1 clickable element can't be reached by keyboard"]);
});

test('skipped, failed or missing walks give no findings', () => {
  assert.deepEqual(analyzeKeyboard({ skipped: 'turned off' }).findings, []);
  assert.deepEqual(analyzeKeyboard(undefined).findings, []);
  assert.deepEqual(analyzeKeyboard({ error: 'boom' }).findings, []);
});

test('walkComplete: only full walks replace the DOM-inferred focus order', () => {
  for (const ended of ['cycle', 'trap', 'left-page']) assert.equal(walkComplete(walk([stop()], { ended })), true, ended);
  for (const ended of ['cap', 'time', 'frame', 'navigated', 'error']) assert.equal(walkComplete(walk([stop()], { ended })), false, ended);
  assert.equal(walkComplete(walk([stop()], { confined: { sel: 'div#modal', reached: 3, total: 80 } })), false, 'confined without being set aside');
  assert.equal(walkComplete(walk([stop()], { banner: { sel: 'div#b', setAside: true, stops: [stop()] } })), true, 'a banner set aside: the page phase counts');
  assert.equal(walkComplete({ skipped: 'turned off' }), false);
  assert.equal(walkComplete(undefined), false);
  assert.equal(walkComplete(walk([], { ended: 'left-page' })), false, 'no real stop');
});

test('an aborted walk keeps its other findings but not the jump finding', () => {
  const s1 = stop({ box: { x: 0, y: 1000, w: 200, h: 20 } });
  const up = stop({ box: { x: 0, y: 100, w: 200, h: 20 }, name: '' });
  const r = analyzeKeyboard(walk([skip(), s1, up], { ended: 'navigated' }));
  assert.deepEqual(t(r), ['high:1 keyboard stop has no accessible name']);
});

test('walkEnd: cycle, trap (1–3 elements three times), focus leaving, else null', () => {
  const k = (...xs) => xs.map((x) => (x === '-' ? { none: true } : { uid: x, sel: `#${x}` }));
  assert.deepEqual(walkEnd(k(1, 2, 3, 4), k(1)[0]), { ended: 'cycle' });
  assert.deepEqual(walkEnd(k(1, 2, '-'), k(1)[0]), { ended: 'cycle' }, 'focus left the page in between: a cycle');
  assert.deepEqual(walkEnd(k('-', 1, 2, 4, 5), k(1)[0]), { ended: 'cycle' }, 'leading nones do not count');
  assert.equal(walkEnd(k(1, 2, 3), k(4)[0]), null);
  assert.deepEqual(walkEnd(k(1, 5, 5), k(5)[0]), { ended: 'trap', trapped: ['#5'] });
  assert.deepEqual(walkEnd(k(1, 7, 8, 7, 8, 7), k(8)[0]), { ended: 'trap', trapped: ['#7', '#8'] });
  assert.deepEqual(walkEnd(k(1, 6, 7, 8, 6, 7, 8, 6, 7), k(8)[0]), { ended: 'trap', trapped: ['#6', '#7', '#8'] });
  assert.equal(walkEnd(k(1, 7, 8, 7, 8), k(7)[0]), null, 'twice is not yet a trap');
  assert.deepEqual(walkEnd(k(1, 2, '-'), k('-')[0]), { ended: 'left-page' });
  assert.equal(walkEnd(k(1, 2), k('-')[0]), null, 'one none: keep going');
  assert.equal(walkEnd([], k(1)[0]), null, 'the first stop');
  // Back at the first stop after only 1–3 elements without leaving the page: a trap on the first stop / a modal open on load.
  assert.deepEqual(walkEnd(k(1, 2, 3), k(1)[0]), { ended: 'trap', trapped: ['#1', '#2', '#3'], onFirst: true });
  assert.deepEqual(walkEnd(k(1), k(1)[0]), { ended: 'trap', trapped: ['#1'], onFirst: true });
  assert.deepEqual(walkEnd(k('-', 1, 2), k(1)[0]), { ended: 'trap', trapped: ['#1', '#2'], onFirst: true });
  assert.equal(walkEnd(k('-'), k('-')[0]), null, 'leading nones: the page may not have focus yet');
  // A cross-origin frame keeps the same element focused while Tab moves inside it: not a trap.
  const f = { uid: 9, sel: 'iframe', frame: true };
  assert.equal(walkEnd([...k(1), f, f], f), null);
});

test('analyzeStructure: the walk replaces the DOM-inferred focus-jump finding; skipped or aborted keeps it', () => {
  const none = { count: 0, samples: [] };
  const c = {
    headings: [{ level: 1, text: 'Home' }], hiddenHeadings: [],
    landmarks: { mains: 1, hasMain: true, navs: [], asides: [], banners: 1, contentinfos: 1 },
    focusJumps: { count: 2, samples: [{ selector: 'a.x' }, { selector: 'a.y' }] }, noRole: none,
  };
  const ids = (r) => r.findings.map((f) => f.id);
  assert.ok(ids(analyzeStructure(c)).includes('focus-jumps'), 'no walk');
  assert.ok(ids(analyzeStructure(c, { keyboard: { skipped: 'turned off' } })).includes('focus-jumps'), 'skipped');
  assert.ok(ids(analyzeStructure(c, { keyboard: walk([skip(), stop()], { ended: 'navigated' }) })).includes('focus-jumps'), 'aborted');
  const full = analyzeStructure(c, { keyboard: walk([skip(), stop()]) });
  assert.ok(!ids(full).includes('focus-jumps'), 'a full walk replaces it');
  assert.ok(full.findings.every((f) => f.id));
  const kb = analyzeStructure(c, { keyboard: walk([stop({ name: '' })]) });
  assert.deepEqual(ids(kb).filter((x) => x.startsWith('kb-')), ['kb-no-name', 'kb-no-skip-link']);
  assert.ok(kb.findings.every((f) => f.category === 'accessibility'));
});

test('overlap: keyboard findings have rows where axe covers the same thing', () => {
  const row = (k) => OVERLAP.find((o) => o.ours === `a11y-structure:${k}`);
  assert.equal(row('kb-positive-tabindex')?.mode, 'suppress');
  assert.equal(row('kb-jumps')?.mode, 'keep');
  const okAxe = { status: 'ok', data: { violations: [{ id: 'tabindex' }], incomplete: [], passedIds: [] } };
  const p = stop({ tabindex: 3 });
  const c = { headings: [], hiddenHeadings: [], landmarks: { mains: 1, hasMain: true, navs: [], asides: [], banners: 0, contentinfos: 0 } };
  const r = analyzeStructure(c, { keyboard: walk([skip(), p]), axe: okAxe });
  assert.ok(!r.findings.some((f) => f.id === 'kb-positive-tabindex'), 'yields to axe tabindex');
});

test('render: the Keyboard order table, the ended reason, no-name in red, flags', () => {
  const c = { headings: [], hiddenHeadings: [], landmarks: { mains: 1, hasMain: true, navs: [], asides: [], banners: 0, contentinfos: 0 } };
  const out = analyzeStructure(c, { keyboard: walk([skip(), stop({ name: '', sel: 'button.empty', role: 'button' }), stop({ visible: false, changed: false, tabindex: 4 }), { none: true }, stop()], { ended: 'trap', trapped: ['a.q'] }) });
  const html = String(plugin.render({ status: 'ok', ...out }, h));
  assert.match(html, /<h4>Keyboard order<\/h4>/);
  assert.match(html, /focus gets trapped/i);
  assert.match(html, /class="chip-r rating-poor"[^>]*>[\s\S]*?no accessible name/);
  assert.match(html, /<code>button\.empty<\/code>/);
  assert.match(html, /hidden/);
  assert.match(html, /no visible focus/);
  assert.match(html, /positive tabindex/);
  assert.match(html, /focus lost/);
  assert.doesNotMatch(html, /NaN|undefined/);
  const skipped = analyzeStructure(c, { keyboard: { skipped: 'turned off' } });
  assert.match(String(plugin.render({ status: 'ok', ...skipped }, h)), /Keyboard walk: turned off/);
  assert.doesNotMatch(String(plugin.render({ status: 'ok', ...analyzeStructure(c) }, h)), /Keyboard order/);
});

test('run(): reads the walk from hp.capture.keyboard and clickables from the collector', () => {
  const reading = { log: { entries: [], _harplus: { capture: { keyboard: walk([skip(), stop()]) } } } };
  const collected = { headings: [], hiddenHeadings: [], landmarks: { mains: 1, hasMain: true, navs: [], asides: [], banners: 0, contentinfos: 0 },
    clickables: [{ selector: 'div.card', text: 'Card' }], positiveTabindex: [{ selector: 'input.z', tabindex: 5 }] };
  const out = plugin.run(reading, { collected, skip: () => {} });
  assert.ok(out.findings.some((f) => f.id === 'kb-clickable'), out.findings.map((f) => f.id).join());
  assert.ok(out.findings.some((f) => f.id === 'kb-positive-tabindex'), 'positive tabindex from the collector');
  assert.ok(out.summary.some((s) => s.label === 'Keyboard'));
});

test('settings: the keyboard walk is on by default', () => {
  assert.equal(DEFAULTS.capture.keyboardWalk, true);
});

test('a trap found only by returning to the first stop is not reported on a page with no other focusables', () => {
  const a = stop();
  const b = stop();
  const k = walk([a, b], { ended: 'trap', trapped: [a.sel, b.sel], trapOnFirst: true });
  assert.ok(!analyzeKeyboard(k, { focusableCount: 2 }).findings.some((f) => f.id === 'kb-trap'), 'a two-link page');
  assert.ok(analyzeKeyboard(k, { focusableCount: 12 }).findings.some((f) => f.id === 'kb-trap'), 'more on the page than it reached');
  assert.ok(analyzeKeyboard(k).findings.some((f) => f.id === 'kb-trap'), 'count unknown: reported');
  assert.equal(walkComplete(walk([stop()], { ended: 'error', error: 'x' })), false);
});

test('unnamed stops axe already reported are left out; none left, no finding', () => {
  const a = stop({ name: '' });
  const b = stop({ name: '' });
  assert.deepEqual(t(analyzeKeyboard(walk([skip(), a, b]), { nameCovered: [a.sel] })), ['high:1 keyboard stop has no accessible name']);
  assert.deepEqual(t(analyzeKeyboard(walk([skip(), a, b]), { nameCovered: [a.sel, b.sel] })), []);
});

test('jumps ignore hidden and off-screen stops', () => {
  const top = { ...skip(), box: { x: 0, y: 0, w: 100, h: 20 } };
  const low = stop({ box: { x: 0, y: 1000, w: 100, h: 20 } });
  const offUp = stop({ box: { x: 0, y: -10000, w: 100, h: 20 }, onScreen: false });
  const hidUp = stop({ box: { x: 0, y: 10, w: 100, h: 20 }, visible: false });
  assert.ok(!analyzeKeyboard(walk([top, low, offUp, hidUp])).findings.some((f) => f.id === 'kb-jumps'));
});

const page = { headings: [], hiddenHeadings: [], landmarks: { mains: 1, hasMain: true, navs: [], asides: [], banners: 0, contentinfos: 0 } };

test('analyzeStructure: a full walk replaces the focus probe findings; skipped or aborted keeps them', () => {
  const focus = { samples: [{ kind: 'inline-link', selector: 'p a', changed: [] }, { kind: 'button', selector: 'button', changed: ['outline'] }], outlineNone: 1 };
  const ids = (r) => r.findings.map((f) => f.id);
  assert.ok(ids(analyzeStructure(page, { focus })).includes('focus-inline-link'));
  assert.ok(ids(analyzeStructure(page, { focus, keyboard: { skipped: 'turned off' } })).includes('focus-inline-link'));
  assert.ok(ids(analyzeStructure(page, { focus, keyboard: walk([skip(), stop()], { ended: 'navigated' }) })).includes('focus-inline-link'));
  const full = analyzeStructure(page, { focus, keyboard: walk([skip(), stop({ changed: false })]) });
  assert.ok(!ids(full).some((x) => /^focus-/.test(x)), ids(full).join());
  const kb = full.findings.find((f) => f.id === 'kb-no-focus-style');
  assert.match(kb.detail, /remove the focus outline in 1 rules/);
  const none = { samples: [{ kind: 'inline-link', selector: 'p a', changed: [] }, { kind: 'button', selector: 'button', changed: [] }], outlineNone: 0 };
  assert.ok(!ids(analyzeStructure(page, { focus: none, keyboard: walk([skip(), stop()]) })).includes('focus-none'));
});

test('analyzeStructure: unnamed stops matched to axe name violations drop out only when axe ran ok', () => {
  const a = stop({ name: '' });
  const c = { ...page, kbAxeNamed: [a.sel] };
  const okAxe = { status: 'ok', data: { violations: [{ id: 'button-name' }], incomplete: [], passedIds: [] } };
  assert.ok(!analyzeStructure(c, { keyboard: walk([skip(), a]), axe: okAxe }).findings.some((f) => f.id === 'kb-no-name'));
  assert.ok(analyzeStructure(c, { keyboard: walk([skip(), a]), axe: { status: 'error' } }).findings.some((f) => f.id === 'kb-no-name'));
});

test('collectArgs: unnamed stop selectors and axe name-rule targets, only when axe ran ok', () => {
  const ctx = (axe) => ({ results: { axe }, har: { log: { _harplus: { capture: { keyboard: walk([stop({ name: '', sel: 'button.x' }), stop(), { none: true }]) } } } } });
  const okAxe = { status: 'ok', data: { violations: [{ id: 'button-name', targets: ['#f > button'] }, { id: 'color-contrast', targets: ['p'] }] } };
  // `vague` (the shared vague-link words) always rides along; the walk arguments only when axe ran ok.
  const bare = (a) => { const { vague, ...rest } = a; assert.ok(Array.isArray(vague) && vague.length); return rest; };
  assert.deepEqual(bare(plugin.collectArgs(ctx(okAxe))), { kbUnnamed: ['button.x'], axeNameTargets: ['#f > button'] });
  assert.deepEqual(bare(plugin.collectArgs(ctx({ status: 'error' }))), {});
  assert.deepEqual(bare(plugin.collectArgs({ results: {}, har: { log: { _harplus: {} } } })), {});
});

test('overlap: every keyboard finding has a row; skip target yields to axe skip-link', () => {
  for (const id of ['kb-trap', 'kb-focus-lost', 'kb-hidden', 'kb-no-name', 'kb-no-focus-style', 'kb-positive-tabindex', 'kb-jumps', 'kb-no-skip-link', 'kb-skip-target', 'kb-clickable']) {
    assert.ok(OVERLAP.some((o) => o.ours === `a11y-structure:${id}`), id);
  }
  assert.equal(OVERLAP.find((o) => o.ours === 'a11y-structure:kb-skip-target').axe, 'skip-link');
  assert.equal(OVERLAP.find((o) => o.ours === 'a11y-structure:kb-skip-target').mode, 'suppress');
  assert.equal(OVERLAP.find((o) => o.ours === 'a11y-structure:kb-no-name').mode, 'keep');
  const reported = { status: 'ok', data: { violations: [{ id: 'skip-link' }], incomplete: [], passedIds: [] } };
  assert.ok(!analyzeStructure(page, { keyboard: walk([skip({ exists: false }), stop()]), axe: reported }).findings.some((f) => f.id === 'kb-skip-target'));
  // axe only evaluates links it takes for skip links: passing or "nothing to evaluate" leaves the walk's finding in place
  for (const data of [{ passedIds: ['skip-link'] }, { ranIds: ['skip-link'] }]) {
    const quiet = { status: 'ok', data: { violations: [], incomplete: [], passedIds: [], ...data } };
    assert.ok(analyzeStructure(page, { keyboard: walk([skip({ exists: false }), stop()]), axe: quiet }).findings.some((f) => f.id === 'kb-skip-target'));
  }
});

test('render: a walk that ended on an error keeps its table; frames are explained', () => {
  const f = stop({ frame: true, presses: 4, tag: 'iframe', role: 'Iframe', name: 'Map' });
  const out = analyzeStructure(page, { keyboard: walk([skip(), f], { ended: 'error', error: 'Tab down timed out after 3s' }) });
  const html = String(plugin.render({ status: 'ok', ...out }, h));
  assert.match(html, /stopped on an error: Tab down timed out after 3s\./);
  assert.match(html, /inside a frame \(4 presses\)/);
  assert.match(html, /each frame is one row/);
});

// ---- consent banners, partial walks (final fix wave A)

const bannerWalk = () => {
  const b = [stop({ sel: 'button#accept', name: 'Accept' }), stop({ sel: 'button#reject', name: '' }), stop({ sel: 'a#policy', changed: false })];
  return walk([skip(), stop(), stop()], { banner: { sel: 'div#onetrust-banner-sdk', kind: 'cmp', tool: 'OneTrust', modal: false, consent: true, stops: b, setAside: true } });
};

test('confinedCandidate: a cycle or trap under a quarter of the focusables, or a frame holding focus', () => {
  const six = [stop(), stop(), stop(), stop(), stop(), stop()];
  assert.equal(confinedCandidate('cycle', six, 76), true, 'thymecare: 6 of 76');
  assert.equal(confinedCandidate('trap', six, 76), true);
  assert.equal(confinedCandidate('cycle', six, 24), false, '6 of 24 is a quarter: not under it');
  assert.equal(confinedCandidate('cycle', six, undefined), false, 'unknown count');
  assert.equal(confinedCandidate('left-page', six, 76), false);
  assert.equal(confinedCandidate('cap', six, 76), false);
  assert.equal(confinedCandidate('frame', [stop({ frame: true })], 10), false, 'a frame is decided by frameAction');
  assert.equal(confinedCandidate('cycle', [{ none: true }], 76), false, 'no real stop');
  assert.equal(confinedCandidate('cycle', [...six, ...six], 76), true, 'repeats count once');
});

test('dropTrailingNone: a cycle loses the presses that left the page before it came back; others keep them', () => {
  const a = stop();
  const b = stop();
  assert.deepEqual(dropTrailingNone([a, b, { none: true }], 'cycle'), [a, b]);
  assert.deepEqual(dropTrailingNone([a, { none: true }, b, { none: true }, { none: true }], 'cycle'), [a, { none: true }, b]);
  assert.deepEqual(dropTrailingNone([a, b, { none: true }], 'left-page'), [a, b, { none: true }]);
});

test('CMP_TOOLS: the consent tools the brief names, each with selectors', () => {
  const tools = CMP_TOOLS.map((x) => x.tool);
  for (const n of ['OneTrust', 'Cookiebot', 'TrustArc', 'Usercentrics', 'Didomi', 'Osano', 'Quantcast', 'CookieYes', 'Iubenda', 'Termly', 'Klaro', 'Complianz', 'Sourcepoint']) assert.ok(tools.includes(n), n);
  const sels = CMP_TOOLS.flatMap((x) => x.sels);
  for (const s of ['#onetrust-consent-sdk', '#onetrust-banner-sdk', '#CybotCookiebotDialog', '#truste-consent-track', '.truste_overlay', '#usercentrics-root', '#usercentrics-cmp-ui', '#didomi-host', '.osano-cm-window', '.qc-cmp2-container', '.cky-consent-container', '#iubenda-cs-banner', '[class*="termly"]', '.klaro', '#cmplz-cookiebanner-container', '[id^="sp_message_container"]']) assert.ok(sels.includes(s), s);
});

test('a cookie banner that traps focus without being a modal: medium; its stops feed the name and focus-style checks', () => {
  const r = analyzeKeyboard(bannerWalk());
  const ids = r.findings.map((f) => f.id);
  const trap = r.findings.find((f) => f.id === 'kb-banner-trap');
  assert.equal(trap.severity, 'medium');
  assert.equal(trap.title, "Cookie banner traps keyboard focus but isn't a modal dialog");
  assert.equal(trap.evidence, 'div#onetrust-banner-sdk');
  assert.match(trap.detail, /3 stops/);
  assert.match(trap.detail, /set it aside/);
  assert.match(r.findings.find((f) => f.id === 'kb-no-name').evidence, /button#reject/);
  assert.match(r.findings.find((f) => f.id === 'kb-no-focus-style').evidence, /a#policy/);
  assert.ok(!ids.includes('kb-trap') && !ids.includes('kb-banner-modal') && !ids.includes('kb-banner-unreachable') && !ids.includes('kb-confined'), ids.join());
  assert.match(r.summary.value, /^3 stops · banner 3$/);
});

test('a cookie banner that is a proper modal: info, and the rating ignores it', () => {
  const k = bannerWalk();
  k.banner.modal = true;
  k.banner.stops = [stop({ sel: 'button#accept' })];
  const r = analyzeKeyboard(k);
  assert.deepEqual(t(r), ['info:Cookie banner holds keyboard focus as a modal dialog']);
  assert.equal(r.findings[0].id, 'kb-banner-modal');
  assert.equal(r.summary.rating, 'good');
});

test('a dialog open on load that is not a consent banner is named as a dialog', () => {
  const k = bannerWalk();
  k.banner.consent = false;
  k.banner.kind = 'dialog';
  k.banner.stops = [stop()];
  assert.deepEqual(t(analyzeKeyboard(k)), ["medium:Dialog open on load traps keyboard focus but isn't a modal dialog"]);
});

test('a consent banner visible at load that no stop of a full walk reaches: high', () => {
  const consent = { sel: 'div#cookie-bar', tool: null };
  const r = analyzeKeyboard(walk([skip(), stop(), stop()], { consent }));
  assert.deepEqual(t(r), ["high:Cookie banner can't be reached by keyboard"]);
  assert.equal(r.findings[0].id, 'kb-banner-unreachable');
  assert.equal(r.findings[0].evidence, 'div#cookie-bar');
  assert.deepEqual(t(analyzeKeyboard(walk([skip(), stop({ inConsent: true }), stop()], { consent }))), [], 'reached');
  assert.deepEqual(t(analyzeKeyboard(walk([skip(), stop()], { consent, ended: 'time' }))).filter((x) => x.startsWith('high')), [], 'a partial walk may not have got there yet');
  assert.ok(!analyzeKeyboard({ ...bannerWalk(), consent }).findings.some((f) => f.id === 'kb-banner-unreachable'), 'the banner held focus: reached');
});

test('a trap that also confined the walk is reported once, as a trap', () => {
  const a = stop({ sel: 'div.chat button.t1' });
  const b = stop({ sel: 'div.chat button.t2' });
  const r = analyzeKeyboard(walk([a, b, a, b, a, b], { ended: 'trap', trapped: [a.sel, b.sel], confined: { sel: 'div.chat', reached: 2, total: 80 } }), { focusableCount: 80 });
  assert.ok(r.findings.some((f) => f.id === 'kb-trap'));
  assert.ok(!r.findings.some((f) => f.id === 'kb-confined'), 'no second finding for the same trap');
  assert.equal(walkComplete(walk([a, b], { ended: 'trap', confined: { sel: 'div.chat' } })), false, 'still a partial walk');
});

test('confined to a dialog that could not be set aside: info with the counts; the walk is not complete', () => {
  const k = walk([stop(), stop(), stop()], { confined: { sel: 'div.modal', reached: 3, total: 80 } });
  const r = analyzeKeyboard(k);
  assert.deepEqual(t(r), ['info:Keyboard walk confined to one part of the page from the start; 77 of 80 focusable elements not reached']);
  assert.equal(r.findings[0].id, 'kb-confined');
  assert.equal(r.findings[0].evidence, 'div.modal');
  assert.match(r.summary.value, /confined/);
});

test('a walk stopped by the cap, the clock or a frame: an info finding with the page position', () => {
  const r = analyzeKeyboard(walk([skip(), stop(), stop()], { ended: 'cap', reachedY: 28807.4, docH: 35599 }));
  assert.deepEqual(t(r), ["info:Keyboard walk stopped at 3 stops (page y 28,807 of 35,599); the rest wasn't walked"]);
  assert.equal(r.findings[0].id, 'kb-stopped');
  assert.match(t(analyzeKeyboard(walk([skip()], { ended: 'time' })))[0], /^info:Keyboard walk stopped at 1 stop \(page y unknown\)/);
  assert.match(t(analyzeKeyboard(walk([skip()], { ended: 'frame', reachedY: 10 })))[0], /page y 10\)/);
  assert.match(ENDED_LABELS.frame, /50 presses/);
});

test('a partial walk skips the page-wide order findings (no skip link, jumps)', () => {
  const s1 = stop({ box: { x: 0, y: 1000, w: 200, h: 20 } });
  const up = stop({ box: { x: 0, y: 100, w: 200, h: 20 } });
  for (const over of [{ ended: 'cap' }, { ended: 'time' }, { confined: { sel: 'div', reached: 2, total: 50 } }]) {
    const ids = analyzeKeyboard(walk([stop(), s1, up], over)).findings.map((f) => f.id);
    assert.ok(!ids.includes('kb-no-skip-link') && !ids.includes('kb-jumps'), `${JSON.stringify(over)}: ${ids}`);
  }
  const ids = analyzeKeyboard(walk([stop(), s1, up])).findings.map((f) => f.id);
  assert.ok(ids.includes('kb-no-skip-link') && ids.includes('kb-jumps'), `complete: ${ids}`);
});

test('a none tagged left is not focus lost', () => {
  assert.deepEqual(t(analyzeKeyboard(walk([skip(), stop(), { none: true, left: true }, stop()]))), []);
});

test('analyzeStructure: a confined or capped walk brings back the probe focus findings and the DOM focus-jumps', () => {
  const c = {
    headings: [{ level: 1, text: 'Home' }], hiddenHeadings: [],
    landmarks: { mains: 1, hasMain: true, navs: [], asides: [], banners: 1, contentinfos: 1 },
    focusJumps: { count: 2, samples: [{ selector: 'a.x' }, { selector: 'a.y' }] }, noRole: { count: 0, samples: [] },
  };
  const focus = { samples: [{ kind: 'link', selector: 'a.x', changed: [] }, { kind: 'button', selector: 'button.y', changed: [] }], outlineNone: 0 };
  const ids = (k) => analyzeStructure(c, { keyboard: k, focus }).findings.map((f) => f.id);
  for (const k of [walk([stop()], { confined: { sel: 'div', reached: 1, total: 40 } }), walk([skip(), stop()], { ended: 'cap' }), walk([skip(), stop()], { ended: 'time' })]) {
    const got = ids(k);
    assert.ok(got.includes('focus-jumps') && got.includes('focus-none'), got.join());
    assert.ok(!got.includes('kb-no-skip-link'), got.join());
  }
  const full = ids(walk([skip(), stop()]));
  assert.ok(!full.includes('focus-jumps') && !full.includes('focus-none'), full.join());
});

test('render: a Cookie banner section first with B-numbered stops, then the page stops', () => {
  const c = { headings: [], hiddenHeadings: [], landmarks: { mains: 1, hasMain: true, navs: [], asides: [], banners: 0, contentinfos: 0 } };
  const out = analyzeStructure(c, { keyboard: bannerWalk() });
  const html = String(plugin.render({ status: 'ok', ...out }, h));
  const banner = html.indexOf('Cookie banner');
  const page = html.indexOf('Page');
  assert.ok(banner > 0, 'a Cookie banner heading');
  assert.match(html, />B1</);
  assert.match(html, />B3</);
  assert.match(html, /set it aside/);
  assert.ok(html.indexOf('>B1<') < html.indexOf('>1<'), 'banner rows before the page rows');
  assert.ok(page > 0);
  assert.doesNotMatch(html, /NaN|undefined/);
  const confined = analyzeStructure(c, { keyboard: walk([stop(), stop()], { confined: { sel: 'div.modal', reached: 2, total: 40 } }) });
  assert.match(String(plugin.render({ status: 'ok', ...confined }, h)), /confined to <code>div\.modal<\/code>.*38 of 40/s);
});

test('isBanner, frameAction: consent tools and dialogs are banners; a fixed box only with consent text; frames walked past otherwise', () => {
  assert.equal(isBanner({ kind: 'cmp' }), true);
  assert.equal(isBanner({ kind: 'dialog', consent: false }), true);
  assert.equal(isBanner({ kind: 'fixed', consent: true }), true);
  assert.equal(isBanner({ kind: 'fixed', consent: false }), false, 'a fixed chat widget trap stays kb-trap');
  assert.equal(isBanner({ kind: 'fixed', consent: true, wrapper: true }), false);
  assert.equal(isBanner({ kind: null }), false);
  assert.equal(isBanner(null), false);
  assert.equal(frameAction({ kind: 'cmp', tool: 'Sourcepoint' }), 'banner');
  assert.equal(frameAction({ kind: 'fixed', consent: true }, { phase: 1 }), 'banner');
  assert.equal(frameAction({ kind: null, inside: 1 }), 'skip', 'an ordinary frame');
  assert.equal(frameAction(null), 'skip');
  assert.equal(frameAction({ kind: 'cmp' }, { phase: 2 }), 'skip', 'the page phase walks past frames');
  const sels = CMP_TOOLS.flatMap((x) => x.sels);
  assert.ok(sels.includes('iframe[id^="sp_message_iframe"]') && sels.includes('iframe[src*="consent.trustarc"]'));
});

test('confinedVerdict: a trap, or a container with far fewer focusables; never an app wrapper or most of the page', () => {
  assert.equal(confinedVerdict('trap', { kind: null, inside: 4 }, 100), true);
  assert.equal(confinedVerdict('cycle', { kind: null, inside: 10 }, 100), true, 'under a quarter');
  assert.equal(confinedVerdict('cycle', { kind: null, inside: 40 }, 100), false, 'a cycle in a container with 40 of 100');
  assert.equal(confinedVerdict('trap', { kind: null, inside: 60 }, 100), false, 'most of the page');
  assert.equal(confinedVerdict('trap', { kind: null, inside: 2, wrapper: true }, 100), false, '#root / #__next');
  assert.equal(confinedVerdict('cycle', { kind: null }, 100), false, 'unknown size: only a trap counts');
  assert.equal(confinedVerdict('cycle', null, 100), false);
});

test('CMP_TOOLS parts: only the tools\' own overlays, never the broad container selectors', () => {
  const parts = CMP_TOOLS.flatMap((x) => x.parts || []);
  assert.ok(!parts.some((p) => /class\*=|^\.klaro$/.test(p)), parts.join());
  assert.ok(parts.includes('.onetrust-pc-dark-filter'));
  assert.match(ENDED_LABELS.cap, /2,000 stops/);
});

test('render: a ring drawn on a relative says where', () => {
  const c = { headings: [], hiddenHeadings: [], landmarks: { mains: 1, hasMain: true, navs: [], asides: [], banners: 0, contentinfos: 0 } };
  const out = analyzeStructure(c, { keyboard: walk([skip(), stop({ changedOn: 'parent' }), stop({ changedOn: 'child' }), stop({ changedOn: 'grandparent' })]) });
  const html = String(plugin.render({ status: 'ok', ...out }, h));
  assert.match(html, /focus style on its parent/);
  assert.match(html, /focus style on its child/);
  assert.match(html, /focus style on an ancestor/);
  const pseudo = analyzeStructure(c, { keyboard: walk([skip(), stop({ changedOn: 'parent', changedPseudo: '::after' }), stop({ changedOn: 'self', changedPseudo: '::before' })]) });
  const ph = String(plugin.render({ status: 'ok', ...pseudo }, h));
  assert.match(ph, /focus style on its parent ::after/);
  assert.match(ph, /focus style on its own ::before/);
});

// ---- inline cookie banners (A4) and stops hidden behind a banner (A13)
test('a skip link right after an inline banner counts', () => {
  const consent = { sel: 'div.govuk-cookie-banner', kind: 'inline' };
  const a = stop({ inConsent: true, sel: 'button.accept' });
  const b = stop({ inConsent: true, sel: 'button.reject' });
  const s = stop({ sel: 'a.skip', skip: { href: '#main', exists: true, visible: true, focusable: true } });
  const k = walk([a, b, s, stop()], { consent });
  assert.deepEqual(t(analyzeKeyboard(k)), []);
  assert.equal(firstPageStop(k.stops), s);
  assert.equal(skipLinkStop(k), 'a.skip');
  const broken = analyzeKeyboard(walk([a, b, stop({ sel: 'a.skip2', skip: { href: '#nope', exists: false } })], { consent }));
  assert.deepEqual(t(broken), ["medium:The skip link's target is missing"], 'the target is judged on the stop after the banner');
});

test('a skip link inside the banner is not the page\'s skip link', () => {
  const k = walk([stop({ inConsent: true, skip: { href: '#x', exists: true, visible: true, focusable: true } }), stop(), stop()], { consent: { sel: 'div#c', kind: 'inline' } });
  const r = analyzeKeyboard(k);
  assert.deepEqual(t(r), ['low:No skip link as the first stop']);
  assert.equal(skipLinkStop(k), null);
});

test('firstPageStop: past nones and the leading banner stops; undefined when every stop is in the banner', () => {
  const p = stop();
  assert.equal(firstPageStop([{ none: true }, stop({ inConsent: true }), { none: true }, p, stop({ inConsent: true })]), p);
  assert.equal(firstPageStop([stop({ inConsent: true })]), undefined);
  assert.equal(firstPageStop([]), undefined);
});

test('stops behind a shown banner are reported once', () => {
  const full = [1, 2, 3].map((i) => stop({ sel: `a.full${i}`, obscured: 'full' }));
  const half = [1, 2].map((i) => stop({ sel: `a.half${i}`, obscured: 'half' }));
  const r = analyzeKeyboard(walk([skip(), ...full, ...half, full[0]], { consent: { sel: 'div#bbccookies' } }));
  const ob = r.findings.filter((f) => f.id === 'kb-obscured');
  assert.equal(ob.length, 1);
  assert.equal(ob[0].severity, 'medium');
  assert.equal(ob[0].title, '3 keyboard stops are hidden behind the cookie banner');
  assert.equal(ob[0].evidence, 'a.full1\na.full2\na.full3');
  assert.match(ob[0].detail, /div#bbccookies/);
  assert.match(ob[0].detail, /2 more are half covered/);
  assert.match(ob[0].detail, /2\.4\.11/);
  const one = analyzeKeyboard(walk([skip(), stop({ obscured: 'full' })]));
  const f = one.findings.find((x) => x.id === 'kb-obscured');
  assert.equal(f.title, '1 keyboard stop is hidden behind the cookie banner');
  assert.doesNotMatch(f.detail, /half covered/);
});

test('no obscured finding when only half covered', () => {
  const r = analyzeKeyboard(walk([skip(), stop({ obscured: 'half' }), stop({ obscured: 'half' })], { consent: { sel: 'div#c' } }));
  assert.ok(!r.findings.some((f) => f.id === 'kb-obscured'));
});

test('focus leaving the document between two visits to the same frame is not focus lost (the BBC shape)', () => {
  const sp = stop({ sel: 'iframe#sp_message_iframe_1504881', role: 'iframe', name: 'SP Consent Message', tag: 'iframe', frame: true, presses: 6, changed: null, fixed: true });
  const r = analyzeKeyboard(walk([skip(), stop(), stop(), sp, { none: true }, { ...sp }]));
  assert.ok(!r.findings.some((f) => f.id === 'kb-focus-lost'), t(r).join(' | '));
  // A none between two different elements still counts.
  assert.deepEqual(t(analyzeKeyboard(walk([skip(), stop(), { none: true }, stop()]))), ['medium:Focus is lost 1 time while tabbing']);
});

test('firstPageStop: past leading frame stops (a leaderboard ad before the skip link)', () => {
  const ad = stop({ tag: 'iframe', role: 'iframe', name: 'Advertisement', frame: true, presses: 3, changed: null });
  const s = skip();
  assert.equal(firstPageStop([ad, { none: true }, s, stop()]), s);
  const r = analyzeKeyboard(walk([ad, s, stop(), stop()]));
  assert.ok(!r.findings.some((f) => f.id === 'kb-no-skip-link'), t(r).join(' | '));
});

test('stops under a full-screen frame banner are only "may be covered" in the detail, never in the title', () => {
  const maybe = [1, 2].map((i) => stop({ sel: `a.maybe${i}`, obscured: 'half', obscuredFrame: true }));
  assert.ok(!analyzeKeyboard(walk([skip(), ...maybe], { consent: { sel: 'div#sp' } })).findings.some((f) => f.id === 'kb-obscured'));
  const r = analyzeKeyboard(walk([skip(), stop({ obscured: 'full' }), stop({ obscured: 'half' }), ...maybe], { consent: { sel: 'div#sp' } }));
  const f = r.findings.find((x) => x.id === 'kb-obscured');
  assert.equal(f.title, '1 keyboard stop is hidden behind the cookie banner');
  assert.match(f.detail, /1 more is half covered\. 2 more may be covered \(the banner is a full-screen frame HARgus can't see inside\)\./);
});

test('stops under a full-screen frame banner with nothing fully hidden: one info note, counts first', () => {
  const maybe = [1, 2].map((i) => stop({ sel: `a.maybe${i}`, obscured: 'half', obscuredFrame: true }));
  const r = analyzeKeyboard(walk([skip(), ...maybe, maybe[0]], { consent: { sel: 'div#sp' } }));
  const f = r.findings.filter((x) => x.id === 'kb-obscured-unsure');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'info');
  assert.equal(f[0].title, 'Cookie banner may cover 2 keyboard stops');
  assert.equal(f[0].detail, "The banner is a full-screen frame HARgus can't see inside, so it can't tell whether these stops are hidden while the banner is open (WCAG 2.4.11).");
  assert.equal(f[0].evidence, 'a.maybe1\na.maybe2');
  assert.ok(!r.findings.some((x) => x.id === 'kb-obscured'));
  const one = analyzeKeyboard(walk([skip(), stop({ obscured: 'half', obscuredFrame: true })]));
  assert.equal(one.findings.find((x) => x.id === 'kb-obscured-unsure')?.title, 'Cookie banner may cover 1 keyboard stop');
});

test('no unsure note without frame-covered stops, nor when kb-obscured already counts them', () => {
  const plain = analyzeKeyboard(walk([skip(), stop({ obscured: 'half' }), stop()], { consent: { sel: 'div#c' } }));
  assert.ok(!plain.findings.some((x) => x.id === 'kb-obscured-unsure'), t(plain).join(' | '));
  const maybe = [1, 2].map((i) => stop({ sel: `a.maybe${i}`, obscured: 'half', obscuredFrame: true }));
  const both = analyzeKeyboard(walk([skip(), stop({ obscured: 'full' }), ...maybe], { consent: { sel: 'div#sp' } }));
  assert.ok(!both.findings.some((x) => x.id === 'kb-obscured-unsure'), t(both).join(' | '));
  assert.match(both.findings.find((x) => x.id === 'kb-obscured').detail, /2 more may be covered/);
});

test('extent: per-stop findings count out of unique stops plus banner stops; page-level ones carry no count', () => {
  const stops = [stop(), ...Array.from({ length: 9 }, (_, i) => stop(i < 3 ? { changed: false } : {}))];
  const banner = { sel: '#cmp', modal: true, stops: [stop({ inConsent: true }), stop({ inConsent: true })] };
  const r = analyzeKeyboard(walk(stops, { banner }));
  const f = (id) => r.findings.find((x) => x.id === id);
  assert.deepEqual([f('kb-no-focus-style').count, f('kb-no-focus-style').of, f('kb-no-focus-style').unit], [3, 12, 'keyboard stops']);
  assert.ok(f('kb-no-skip-link'));
  assert.equal(f('kb-no-skip-link').count, undefined);
  assert.equal(f('kb-banner-modal').count, undefined);
});

test('extent: a banner that repeats its stops counts each once in the total', () => {
  const a = stop({ inConsent: true, changed: false });
  const b = stop({ inConsent: true });
  const page = [stop(), stop({ changed: false }), stop(), stop()];
  const r = analyzeKeyboard(walk(page, { banner: { sel: '#cmp', modal: true, stops: [a, b, a, b, { none: true }, a, b] } }));
  const f = r.findings.find((x) => x.id === 'kb-no-focus-style');
  assert.deepEqual([f.count, f.of], [2, 6]);
});

test('extent: kb-clickable counts clickable elements with no population; kb-positive-tabindex and kb-focus-lost count', () => {
  const r = analyzeKeyboard(walk([skip(), stop({ tabindex: 2 }), { none: true }, stop()]), { clickables: [{ selector: 'div.c1' }, { selector: 'div.c2' }] });
  const f = (id) => r.findings.find((x) => x.id === id);
  assert.deepEqual([f('kb-clickable').count, f('kb-clickable').of, f('kb-clickable').unit], [2, undefined, 'clickable elements']);
  assert.deepEqual([f('kb-positive-tabindex').count, f('kb-positive-tabindex').of], [1, 3]);
  assert.deepEqual([f('kb-focus-lost').count, f('kb-focus-lost').of], [1, 3]);
});
