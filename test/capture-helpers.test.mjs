import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freezeMedia, viewProbe, blockedByImagesOff, CaptureSession } from '../extension/browser/capture.js';

test('freezeMedia pauses what plays and resumes exactly that', () => {
  const mk = (paused) => ({ paused, isConnected: true, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } });
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

// Page stubs for freezeMedia: media elements and the document's animations, both replaceable between calls.
const freezePage = (state) => {
  globalThis.window = globalThis;
  globalThis.document = { querySelectorAll: (s) => (s === 'video, audio' ? state.media : []), getAnimations: () => state.anims };
  return () => { delete globalThis.document; delete globalThis.__harplusFrozen; delete globalThis.window; };
};
const mkMedia = (paused) => ({ paused, isConnected: true, plays: 0, pause() { this.paused = true; }, play() { this.plays++; this.paused = false; return Promise.resolve(); } });
const mkAnim = () => ({ playState: 'running', plays: 0, pause() { this.playState = 'paused'; }, play() { this.plays++; this.playState = 'running'; } });

test('freezeMedia(false) does not replay an animation a view cancelled', () => {
  const anim = mkAnim();
  const done = freezePage({ media: [], anims: [anim] });
  try {
    freezeMedia(true);
    anim.playState = 'idle'; // the no-CSS view disabled its stylesheet
    freezeMedia(false);
    assert.equal(anim.plays, 0, 'a cancelled animation is not played');
    assert.equal(anim.playState, 'idle');
  } finally { done(); }
});

test('freezeMedia(false) does not restart a media element the page removed', () => {
  const m = mkMedia(false);
  const done = freezePage({ media: [m], anims: [] });
  try {
    freezeMedia(true);
    m.isConnected = false;
    freezeMedia(false);
    assert.equal(m.plays, 0, 'a detached element stays paused');
    assert.equal(m.paused, true);
  } finally { done(); }
});

test('a second freezeMedia(true) keeps the first call\'s entries and records each object once', () => {
  const m1 = mkMedia(false), a1 = mkAnim(), a2 = mkAnim();
  const state = { media: [m1], anims: [a1] };
  const done = freezePage(state);
  try {
    freezeMedia(true);
    state.anims = [a1, a2]; // a1 is still listed (paused); a2 is new
    m1.paused = false; // the page played it again: paused anew, recorded once
    freezeMedia(true);
    assert.equal(globalThis.__harplusFrozen.anims.length, 2, 'no double entry');
    assert.equal(globalThis.__harplusFrozen.media.length, 1);
    freezeMedia(false);
    assert.equal(a1.plays, 1, 'the first call\'s animation resumed once');
    assert.equal(a2.plays, 1, 'the second call\'s animation resumed');
    assert.equal(m1.plays, 1, 'the first call\'s media resumed once');
  } finally { done(); }
});

test('freezeMedia(false) with no prior freeze does nothing and returns true', () => {
  globalThis.window = globalThis;
  assert.equal(freezeMedia(false), true);
  delete globalThis.window;
});

// viewProbe reads page globals: stub them per case, then remove every one.
const withPage = ({ sheets = [], adopted = [], styled = 0, dir = 'rtl', direction = 'rtl', pseudo, media = {}, width = 1280, rootFont = '16px', spacingSheet = false, letterSpacing = 'normal', screenWidth = width, defaultFont = 16 }, fn) => {
  globalThis.window = globalThis;
  const root = { getAttribute: (a) => (a === 'dir' ? dir : null) };
  globalThis.document = {
    styleSheets: sheets, adoptedStyleSheets: adopted, documentElement: root, body: {},
    querySelectorAll: (s) => (s === '[style]' ? Array.from({ length: styled }) : []),
    getElementById: () => null,
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
  if (spacingSheet) globalThis.__harplusSpacing = {};
  try { return fn(); } finally {
    for (const k of ['document', 'getComputedStyle', 'matchMedia', 'innerWidth', 'screen', '__harplusPseudo', '__harplusKeep', '__harplusSpacing', 'window']) delete globalThis[k];
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

test('viewProbe spacing: needs the adopted spacing sheet (window.__harplusSpacing) and a non-normal letter-spacing', () => {
  assert.equal(withPage({ spacingSheet: true, letterSpacing: '1.6px' }, () => viewProbe('spacing')).ok, true);
  assert.equal(withPage({ spacingSheet: false, letterSpacing: '1.6px' }, () => viewProbe('spacing')).ok, false);
  assert.equal(withPage({ spacingSheet: true }, () => viewProbe('spacing')).ok, false);
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

test('blockedByImagesOff: Image and Media requests are blocked at the request stage, whatever their URL', () => {
  assert.equal(blockedByImagesOff('https://x.test/a', 'Image'), true);
  assert.equal(blockedByImagesOff('https://x.test/a', 'Media'), true);
});

test('blockedByImagesOff: a script-fetched request waits for its response (no content type yet → continue)', () => {
  assert.equal(blockedByImagesOff('https://cdn.test/v.mp4', 'XHR'), false);
  assert.equal(blockedByImagesOff('https://rr1.googlevideo.com/videoplayback?itag=22', 'Fetch'), false);
});

test('blockedByImagesOff: video, audio, stream manifests and raster images fetched by script are blocked by content type', () => {
  for (const [url, ct] of [
    ['https://cdn.test/v.mp4', 'video/mp4'], ['https://cdn.test/seg', 'video/mp4; codecs="avc1"'], ['https://cdn.test/a', 'audio/mpeg'],
    ['https://cdn.test/live.m3u8', 'application/vnd.apple.mpegurl'], ['https://cdn.test/live', 'application/x-mpegURL'],
    ['https://cdn.test/m.mpd', 'application/dash+xml'], ['https://cdn.test/a.ts?x=1', 'video/mp2t'],
    ['https://s.pstatic.net/logo.png', 'image/png'], ['https://x.test/p', 'image/webp'], ['https://x.test/i.avif', 'IMAGE/AVIF'],
  ]) for (const type of ['XHR', 'Fetch', 'Other']) assert.equal(blockedByImagesOff(url, type, ct), true, `${type} ${url} ${ct}`);
});

test('blockedByImagesOff: stream segments served with a generic type are blocked by their path', () => {
  assert.equal(blockedByImagesOff('https://rr1.googlevideo.com/videoplayback?expire=1', 'XHR', 'application/vnd.yt-ump'), true);
  assert.equal(blockedByImagesOff('https://cdn.test/v/seg-1.m4s', 'Fetch', 'application/octet-stream'), true);
  assert.equal(blockedByImagesOff('https://cdn.test/a.ts?x=1', 'XHR', 'application/octet-stream'), true);
  assert.equal(blockedByImagesOff('https://cdn.test/live/x.m3u8', 'XHR', 'text/plain'), true);
});

test('blockedByImagesOff: what a reader with images off still gets is continued', () => {
  // An icon library fetches SVG by XHR and inlines it as markup: Chrome's images-off setting does not touch that.
  assert.equal(blockedByImagesOff('https://x.test/icons/menu.svg', 'XHR', 'image/svg+xml'), false);
  assert.equal(blockedByImagesOff('https://x.test/icons/menu.svg', 'Fetch', 'image/svg+xml; charset=utf-8'), false);
  // Monaco and the TypeScript playground fetch type definitions; servers often label .ts as video/mp2t.
  assert.equal(blockedByImagesOff('https://x.test/lib.es5.d.ts', 'Fetch', 'video/mp2t'), false);
  assert.equal(blockedByImagesOff('https://x.test/src/main.ts', 'Fetch', 'application/typescript'), false);
  assert.equal(blockedByImagesOff('https://x.test/main.tsx', 'Fetch', 'text/plain'), false, '.tsx is not .ts');
  assert.equal(blockedByImagesOff('https://x.test/api/data.json', 'XHR', 'application/json'), false);
  assert.equal(blockedByImagesOff('https://x.test/load?file=a.mp4', 'Fetch', 'application/json'), false, 'the query does not count');
  assert.equal(blockedByImagesOff('not a url', 'Fetch', 'application/octet-stream'), false);
});

test('blockedByImagesOff: the page itself, its scripts, styles and fonts are never blocked', () => {
  assert.equal(blockedByImagesOff('https://x.test/photo.png', 'Document', 'image/png'), false, 'a reading of an image URL still loads');
  assert.equal(blockedByImagesOff('https://deno.test/mod.ts', 'Script', 'video/mp2t'), false);
  assert.equal(blockedByImagesOff('https://x.test/site.css?v=icon.svg', 'Stylesheet', 'text/css'), false);
  assert.equal(blockedByImagesOff('https://x.test/font.woff2', 'Font', 'font/woff2'), false);
});

test('a no-images run that outlives its timeout stops before touching the restored page', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Only the no-images view: every other view and group is off.
  const views = new Proxy({}, { get: (_, k) => k === 'noimages' });
  const s = new CaptureSession(1, { mode: 'reload', views });
  let restoring = false;
  let releaseSettle = null;
  const late = []; // the run's in-page and CDP steps that happened once the restore had started
  const note = (what) => { if (restoring) late.push(what); };
  s.send = async () => ({});
  s.evaluate = async (fn, args) => {
    if (fn.name === 'freezeMedia' && args === true) note('freezeMedia(true)');
    if (fn.name === 'measureView') { note('measure'); return { text: 1 }; }
    return true;
  };
  s.evaluateFrames = async (fn) => { note(fn.name); return [0]; };
  s.shoot = async () => { note('shoot'); return []; };
  s.reloadQuiet = async () => { s.loaded = false; };
  s.blockImages = async (on) => {
    if (on) return;
    // The restore's first step: only now does the run's settle come back.
    restoring = true;
    releaseSettle?.();
  };
  s.settle = () => {
    if (restoring) { s.loaded = true; return Promise.resolve(); } // the restore's own settle
    return new Promise((r) => { releaseSettle = () => { s.loaded = true; r(); }; });
  };
  let patch = null;
  const job = s.captureViews({ log: { _harplus: {} } }).then((p) => { patch = p; });
  for (let i = 0; i < 400 && !patch; i++) {
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(1000);
  }
  await job;
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); // give the late run time to reach its next step
  assert.equal(restoring, true, 'the restore ran');
  assert.deepEqual(late, [], 'no hide, freeze, shot or probe after the restore started');
  assert.ok(patch.capture.viewsSkipped.some((v) => v.view === 'noimages' && /timed out/.test(v.reason)), 'the view is skipped as timed out');
  assert.ok(!('noimages' in patch.capture.viewChecks), 'no check committed');
});
