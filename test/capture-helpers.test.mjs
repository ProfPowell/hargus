import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freezeMedia, viewProbe } from '../extension/browser/capture.js';

test('freezeMedia pauses what plays and resumes exactly that', () => {
  const mk = (paused) => ({ paused, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } });
  const a = mk(false), b = mk(true);
  const anim = { playState: 'running', pause() { this.playState = 'paused'; }, play() { this.playState = 'running'; } };
  globalThis.window = globalThis;
  globalThis.document = { querySelectorAll: (s) => (s === 'video, audio' ? [a, b] : []), getAnimations: () => [anim] };
  freezeMedia(true);
  assert.equal(a.paused, true); assert.equal(b.paused, true); assert.equal(anim.playState, 'paused');
  freezeMedia(false);
  assert.equal(a.paused, false, 'was playing → resumed');
  assert.equal(b.paused, true, 'was paused → stays paused');
  assert.equal(anim.playState, 'running');
  delete globalThis.document;
  delete globalThis.window;
});

test('freezeMedia(false) with no prior freeze does nothing and returns true', () => {
  globalThis.window = globalThis;
  assert.equal(freezeMedia(false), true);
  delete globalThis.window;
});

// viewProbe reads page globals: stub them per case, then remove every one.
const withPage = ({ sheets = [], adopted = [], styled = 0, dir = 'rtl', direction = 'rtl', pseudo, media = {}, width = 1280, rootFont = '16px', spacingEl = false, letterSpacing = 'normal', screenWidth = width, defaultFont = 16 }, fn) => {
  globalThis.window = globalThis;
  const root = { getAttribute: (a) => (a === 'dir' ? dir : null) };
  globalThis.document = {
    styleSheets: sheets, adoptedStyleSheets: adopted, documentElement: root, body: {},
    querySelectorAll: (s) => (s === '[style]' ? Array.from({ length: styled }) : []),
    getElementById: (id) => (id === 'harplus-spacing' && spacingEl ? {} : null),
  };
  globalThis.getComputedStyle = (n) => (n === root ? { fontSize: rootFont, direction } : { direction, letterSpacing });
  // An em media query measures against the browser's default font size, as in Chrome.
  globalThis.matchMedia = (q) => {
    const em = /^\(max-width: ([\d.]+)em\)$/.exec(q);
    return { matches: em ? width <= Number(em[1]) * defaultFont : !!media[q] };
  };
  globalThis.innerWidth = width;
  globalThis.screen = { width: screenWidth };
  if (pseudo) globalThis.__harplusPseudo = pseudo;
  try { return fn(); } finally {
    for (const k of ['document', 'getComputedStyle', 'matchMedia', 'innerWidth', 'screen', '__harplusPseudo', '__harplusKeep', 'window']) delete globalThis[k];
  }
};

test('viewProbe nocss: fails while a sheet or style attribute is live, passes when all are off', () => {
  const bad = withPage({ sheets: [{ disabled: false }] }, () => viewProbe('nocss'));
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /1 style sheets and 0 style attributes/);
  assert.equal(withPage({ styled: 2 }, () => viewProbe('nocss')).ok, false);
  assert.equal(withPage({ adopted: [{}] }, () => viewProbe('nocss')).ok, false);
  assert.deepEqual(withPage({ sheets: [{ disabled: true }] }, () => viewProbe('nocss')), { ok: true, detail: 'all styles off' });
});

test('viewProbe rtl: passes on rtl, reports when the page removed it', () => {
  assert.equal(withPage({}, () => viewProbe('rtl')).ok, true);
  assert.deepEqual(withPage({ dir: 'ltr', direction: 'ltr' }, () => viewProbe('rtl')), { ok: false, detail: 'the page removed the RTL direction' });
});

test('viewProbe reports how often a keeper re-applied the change', () => {
  const r = withPage({}, () => { globalThis.__harplusKeep = { count: 3 }; return viewProbe('rtl'); });
  assert.equal(r.detail, 'right-to-left (re-applied 3 times)');
});

test('viewProbe pseudo: fails when half the text was restored', () => {
  const pairs = (changed) => Array.from({ length: 10 }, (_, i) => [{ isConnected: true, textContent: i < changed ? 'ṕśéúđó' : 'pseudo' }, 'pseudo']);
  const bad = withPage({ pseudo: pairs(5) }, () => viewProbe('pseudo'));
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /restored 50% of the text/);
  assert.equal(withPage({ pseudo: pairs(10) }, () => viewProbe('pseudo')).ok, true);
});

test('viewProbe media: follows matchMedia', () => {
  const q = '(prefers-color-scheme: dark)';
  assert.deepEqual(withPage({ media: { [q]: true } }, () => viewProbe('media', q)), { ok: true, detail: `${q} active` });
  assert.equal(withPage({}, () => viewProbe('media', q)).ok, false);
});

test('viewProbe spacing: needs the injected sheet and a non-normal letter-spacing', () => {
  assert.equal(withPage({ spacingEl: true, letterSpacing: '1.6px' }, () => viewProbe('spacing')).ok, true);
  assert.equal(withPage({ spacingEl: false, letterSpacing: '1.6px' }, () => viewProbe('spacing')).ok, false);
  assert.equal(withPage({ spacingEl: true }, () => viewProbe('spacing')).ok, false);
});

test('viewProbe width: within 1 px of the expected viewport', () => {
  assert.equal(withPage({ width: 320 }, () => viewProbe('width', 320)).ok, true);
  assert.deepEqual(withPage({ width: 1280 }, () => viewProbe('width', 320)), { ok: false, detail: 'viewport is 1280 px, expected 320' });
});

test('viewProbe device: checks the emulated screen, not the layout width', () => {
  assert.deepEqual(withPage({ width: 980, screenWidth: 390 }, () => viewProbe('device', 390)), { ok: true, detail: '390 px screen (page lays out at 980 px)' });
  assert.deepEqual(withPage({ width: 390, screenWidth: 390 }, () => viewProbe('device', 390)), { ok: true, detail: '390 px screen' });
  assert.deepEqual(withPage({ width: 1280, screenWidth: 1280 }, () => viewProbe('device', 390)), { ok: false, detail: 'screen is 1280 px, expected 390' });
});

test('viewProbe fontSetting: probes the browser default font, whatever the page sets on its root', () => {
  // A page pinning html { font-size: 16px } still passes when the browser default is doubled.
  assert.deepEqual(withPage({ rootFont: '16px', defaultFont: 32 }, () => viewProbe('fontSetting', 16 * 1.8)),
    { ok: true, detail: 'browser text size at least 28.8 px (page root font 16 px)' });
  assert.deepEqual(withPage({ rootFont: '16px', defaultFont: 16 }, () => viewProbe('fontSetting', 16 * 1.8)),
    { ok: false, detail: 'browser text size below 28.8 px (page root font 16 px)' });
});

test('viewProbe: a keeper that gave up says so in the failure', () => {
  const r = withPage({ dir: 'ltr', direction: 'ltr' }, () => { globalThis.__harplusKeep = { count: 200, gaveUp: true }; return viewProbe('rtl'); });
  assert.equal(r.detail, 'the page removed the RTL direction (the page fought back; stopped after 200 re-applications)');
});

test('viewProbe: an unknown kind is not measured', () => {
  assert.deepEqual(withPage({}, () => viewProbe('other')), { ok: true, detail: 'not measured' });
});
