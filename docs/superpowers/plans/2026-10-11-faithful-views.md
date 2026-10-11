# Faithful Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every view shows what it claims and proves it.
- The vision filters appear in their shots.
- "No images" is a real images-off load, video included.
- Media is frozen during views.
- Every view records a self-check that the report and plugins respect.

**Architecture:**
- **Pixel maths:** pure functions in a new `extension/core/view-checks.js`, run in the service worker on decoded shots.
- **In-page probes and keepers:** self-contained helpers in `extension/browser/capture.js`.
- **No-images:** uses CDP `Fetch` interception plus a reload, in the same shape as the no-JS view.
- **Checks storage:** results go in `capture.viewChecks`, kept separate from `capture.views` measurements.

**Tech Stack:** Plain ES modules, `node --test` (`npm test`), and the Playwright e2e (`npm run test:e2e`, from the repo or worktree root). ffmpeg is available locally to make the fixture video once.

**Spec:** `docs/superpowers/specs/2026-10-11-faithful-views-design.md`

## Global Constraints

- In-page helpers in `capture.js` are serialised into the page, so they must be self-contained: no imports, no module constants, no closures.
- Check record shape: `capture.viewChecks[id] = { ok: boolean, detail: string }`, carried in the views patch (`patch.capture.viewChecks`). It is never written into `capture.views`.
- Vision thresholds, verbatim:
  - achromatopsia: saturation ≤ 0.03;
  - protanopia, deuteranopia, tritanopia: at least 2% of thumbnail pixels changed by more than 8/255 in some channel;
  - blurred: edge energy ≤ 0.6 × reference;
  - lowcontrast: luminance spread ≤ 0.8 × reference;
  - if reference saturation < 0.02, the colour checks pass with the detail "page has no colour to change".
- Pseudo-localisation keep threshold: at least 0.9 of saved text nodes are still pseudo'd.
- Copy, verbatim:
  - report note: `May not reflect the setting — ${detail}`;
  - plugin info finding: `${label} view could not be verified — ${detail}`;
  - no-images load failure: `page did not finish loading without images`.
- Fetch blocking: `Fetch.enable({ patterns: [{ resourceType: 'Image' }, { resourceType: 'Media' }] })` on the main session and every child session. `Fetch.requestPaused` → `Fetch.failRequest({ requestId, errorReason: 'BlockedByClient' })`.
- Older readings without `viewChecks` behave as today: no notes and no skipped views.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A page that loads new images after the no-images reload** (lazy loaders, `IntersectionObserver`, carousels). They must stay blocked, because blocking is at the network level. Test: Task 7 lazy-loader fixture.
2. **A YouTube or other cross-origin iframe** in the no-images view. Its media and thumbnails must be blocked too, so `Fetch` must also be enabled on child sessions, including ones attached after the reload. Test: Task 7 fixture iframe with an image (the fixture already has `frame.html` on a second origin).
3. **A page whose base shot has a video playing.** The vision colour-shift check must compare against a reference shot taken after `freezeMedia`, not the old base shot, or a moving video would pass it falsely. Test: Task 2 unit test (a different-frame reference with a no-op filter must FAIL), plus Task 7 e2e with the video playing.
4. **A greyscale page** (or one with almost no colour). The colour checks pass with "page has no colour to change" instead of a false alarm. Test: Task 1 unit test.
5. **A view that fails its check on an older reading opened again.** Readings without `viewChecks` show no notes and skip nothing. Test: Task 5 report and plugin tests.

---

### Task 1: Pure pixel statistics and the vision check (`core/view-checks.js`)

**Files:**
- Create: `extension/core/view-checks.js`, `test/view-checks.test.mjs`

**Interfaces:**
- Produces: `imageStats(rgba: Uint8ClampedArray, width: number, height: number) → { sat, edge, spread, thumb: Uint8Array, tw, th }`.
- Produces: `visionCheck(view: string, stats, refStats) → { ok, detail }`.
- Produces: `THUMB = { w: 64, h: 40 }`.

- [ ] **Step 1: Write the failing tests** (`test/view-checks.test.mjs`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageStats, visionCheck } from '../extension/core/view-checks.js';

const W = 128, H = 80;
const img = (fn) => { const a = new Uint8ClampedArray(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, b] = fn(x, y); const i = (y * W + x) * 4; a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = 255; } return a; };
const halves = img((x) => (x < W / 2 ? [230, 20, 20] : [20, 170, 20]));            // red | green
const grey = img((x) => { const v = x < W / 2 ? 90 : 160; return [v, v, v]; });
const stripes = img((x) => ((x >> 2) % 2 ? [255, 255, 255] : [0, 0, 0]));          // sharp edges
const smooth = img((x) => { const v = Math.round(127 + 60 * Math.sin(x / 9)); return [v, v, v]; });
const narrow = img((x) => { const v = 120 + (x % 20); return [v, v, v]; });
const st = (a) => imageStats(a, W, H);

test('saturation: colour high, grey zero', () => {
  assert.ok(st(halves).sat > 0.5);
  assert.equal(st(grey).sat, 0);
});

test('edge energy: stripes sharp, smooth low', () => {
  assert.ok(st(stripes).edge > 3 * st(smooth).edge);
});

test('luminance spread: p95 - p5', () => {
  assert.ok(st(stripes).spread > 200);
  assert.ok(st(narrow).spread < 25);
});

test('achromatopsia: ≤ 0.03 passes, colour fails', () => {
  assert.equal(visionCheck('achromatopsia', st(grey), st(halves)).ok, true);
  const f = visionCheck('achromatopsia', st(halves), st(halves));
  assert.equal(f.ok, false);
  assert.match(f.detail, /saturation/);
});

test('protanopia: a colour shift passes; an identical image fails (Review Focus 3)', () => {
  const shifted = img((x) => (x < W / 2 ? [150, 140, 30] : [150, 140, 30]));
  assert.equal(visionCheck('protanopia', st(shifted), st(halves)).ok, true);
  assert.equal(visionCheck('protanopia', st(halves), st(halves)).ok, false);
});

test('blurred: edge ≤ 0.6 × reference; lowcontrast: spread ≤ 0.8 × reference', () => {
  assert.equal(visionCheck('blurred', st(smooth), st(stripes)).ok, true);
  assert.equal(visionCheck('blurred', st(stripes), st(stripes)).ok, false);
  assert.equal(visionCheck('lowcontrast', st(narrow), st(stripes)).ok, true);
  assert.equal(visionCheck('lowcontrast', st(stripes), st(stripes)).ok, false);
});

test('an already-grey page: colour checks pass with the explanation (Review Focus 4)', () => {
  for (const v of ['achromatopsia', 'protanopia', 'deuteranopia', 'tritanopia']) {
    const r = visionCheck(v, st(grey), st(grey));
    assert.deepEqual(r, { ok: true, detail: 'page has no colour to change' });
  }
});

test('missing stats → ok with an "unmeasured" detail, never a throw', () => {
  assert.deepEqual(visionCheck('blurred', null, st(stripes)), { ok: true, detail: 'not measured' });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/view-checks.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`extension/core/view-checks.js`)

```js
// Pixel statistics for view self-checks. Pure: callers decode the screenshot to RGBA first.

export const THUMB = { w: 64, h: 40 };

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Mean saturation, mean neighbour luminance difference (edge), p95−p5 luminance (spread), and a small RGB thumbnail. */
export function imageStats(rgba, width, height) {
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40000))); // sample ~40k pixels
  let satSum = 0, n = 0, edgeSum = 0, en = 0;
  const lums = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      satSum += mx ? (mx - mn) / mx : 0; n++;
      const l = lum(r, g, b); lums.push(l);
      if (x + step < width) { const j = i + step * 4; edgeSum += Math.abs(l - lum(rgba[j], rgba[j + 1], rgba[j + 2])); en++; }
    }
  }
  lums.sort((a, b) => a - b);
  const q = (p) => lums[Math.min(lums.length - 1, Math.floor(p * lums.length))] ?? 0;
  const { w: tw, h: th } = THUMB;
  const thumb = new Uint8Array(tw * th * 3);
  for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
    const x = Math.min(width - 1, Math.floor(((tx + 0.5) * width) / tw)), y = Math.min(height - 1, Math.floor(((ty + 0.5) * height) / th));
    const i = (y * width + x) * 4, o = (ty * tw + tx) * 3;
    thumb[o] = rgba[i]; thumb[o + 1] = rgba[i + 1]; thumb[o + 2] = rgba[i + 2];
  }
  return { sat: n ? satSum / n : 0, edge: en ? edgeSum / en : 0, spread: q(0.95) - q(0.05), thumb, tw, th };
}

const changedShare = (a, b) => {
  if (!a?.thumb || !b?.thumb || a.thumb.length !== b.thumb.length) return 0;
  let changed = 0;
  for (let p = 0; p < a.thumb.length; p += 3) {
    if (Math.max(Math.abs(a.thumb[p] - b.thumb[p]), Math.abs(a.thumb[p + 1] - b.thumb[p + 1]), Math.abs(a.thumb[p + 2] - b.thumb[p + 2])) > 8) changed++;
  }
  return changed / (a.thumb.length / 3);
};
const pct = (x) => `${Math.round(x * 100)}%`;

/** Did a vision view's shot really show its filter, relative to a reference shot of the same frozen page? */
export function visionCheck(view, stats, ref) {
  if (!stats || !ref) return { ok: true, detail: 'not measured' };
  const colour = ['achromatopsia', 'protanopia', 'deuteranopia', 'tritanopia'].includes(view);
  if (colour && ref.sat < 0.02) return { ok: true, detail: 'page has no colour to change' };
  if (view === 'achromatopsia') return stats.sat <= 0.03 ? { ok: true, detail: `saturation ${stats.sat.toFixed(3)}` } : { ok: false, detail: `still in colour (saturation ${stats.sat.toFixed(3)})` };
  if (colour) {
    const share = changedShare(stats, ref);
    return share >= 0.02 ? { ok: true, detail: `${pct(share)} of pixels shifted` } : { ok: false, detail: `colours unchanged (${pct(share)} of pixels shifted)` };
  }
  if (view === 'blurred') return stats.edge <= 0.6 * ref.edge ? { ok: true, detail: `edges ${pct(stats.edge / (ref.edge || 1))} of normal` } : { ok: false, detail: `not blurred (edges ${pct(stats.edge / (ref.edge || 1))} of normal)` };
  if (view === 'lowcontrast') return stats.spread <= 0.8 * ref.spread ? { ok: true, detail: `contrast ${pct(stats.spread / (ref.spread || 1))} of normal` } : { ok: false, detail: `contrast unchanged (${pct(stats.spread / (ref.spread || 1))} of normal)` };
  return { ok: true, detail: 'not measured' };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/view-checks.test.mjs`, then `npm test`
Expected: PASS. If the synthetic thresholds in a test are off by a hair, adjust the synthetic image rather than the spec's thresholds, and say so in the report.

- [ ] **Step 5: Commit**

```bash
git add extension/core/view-checks.js test/view-checks.test.mjs
git commit -m "View checks: pixel statistics and the vision self-check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Vision shots without a clip, frozen media, vision checks recorded

**Files:**
- Modify: `extension/browser/capture.js`:
  - a new `freezeMedia` helper;
  - a new `decodeStats` method;
  - the vision views block (around lines 938–949);
  - the `captureViews` head and tail;
  - the `view()` helper (recording checks).
- Test: `test/capture-helpers.test.mjs` (new; the `freezeMedia` logic with a stubbed DOM)

**Interfaces:**
- Consumes: `imageStats` and `visionCheck` (Task 1).
- Produces:
  - `patch.capture.viewChecks: { [id]: { ok, detail } }`;
  - a `checks` local object in `captureViews`, written as `patch.capture.viewChecks = checks` at the end;
  - an exported in-page `freezeMedia(on)`.
  - The `view()` helper accepts runs that return `{ id, shots, measured, check }`, and records `check` into `checks[id]` when present. If `check.ok === false`, it also pushes the warning `${label}: may not reflect the setting — ${check.detail}`.

- [ ] **Step 1: Write the failing test** for `freezeMedia` (`test/capture-helpers.test.mjs`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freezeMedia } from '../extension/browser/capture.js';

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
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/capture-helpers.test.mjs`
Expected: FAIL (`freezeMedia` is not exported).

- [ ] **Step 3: Add `freezeMedia`** to `capture.js` (exported; self-contained)

```js
/** Pause playing media and running animations (on) so every view shows the same frame; resume exactly those (off). */
export function freezeMedia(on) {
  if (on) {
    const media = [];
    const walk = (root) => {
      for (const m of root.querySelectorAll('video, audio')) if (!m.paused) { m.pause(); media.push(m); }
      for (const el of root.querySelectorAll ? root.querySelectorAll('*') : []) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    const anims = (document.getAnimations ? document.getAnimations() : []).filter((a) => a.playState === 'running');
    for (const a of anims) a.pause();
    window.__harplusFrozen = { media, anims };
    return true;
  }
  const f = window.__harplusFrozen;
  if (!f) return true;
  for (const m of f.media) m.play?.()?.catch?.(() => {});
  for (const a of f.anims) a.play();
  delete window.__harplusFrozen;
  return true;
}
```

The stubbed `querySelectorAll('*')` returns `[]`, so the shadow walk is a no-op in the test.

- [ ] **Step 4: Run the test**

Run: `node --test test/capture-helpers.test.mjs`
Expected: PASS.

- [ ] **Step 5: Decoding and vision views in `captureViews`**

Add a method to `CaptureSession`. It runs in the service worker, which has `createImageBitmap` and `OffscreenCanvas`:

```js
  /** Decode a base64 screenshot and return imageStats (null if decoding isn't available or fails). */
  async decodeStats(data, mimeType) {
    try {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: mimeType || 'image/webp' }));
      const w = Math.min(bmp.width, 640), h = Math.max(1, Math.round((bmp.height * w) / bmp.width));
      const c = new OffscreenCanvas(w, h); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0, w, h); bmp.close?.();
      return imageStats(g.getImageData(0, 0, w, h).data, w, h);
    } catch { return null; }
  }
```

Import `imageStats` and `visionCheck` from `'../core/view-checks.js'`.

In `captureViews`:

- Add `const checks = {};` beside `views`.
- In `view()`, after the success line `if (got.measured) views[id] = got.measured;`, add:
  ```js
  if (got.check) { checks[id] = got.check; if (got.check.ok === false) this.warnings.push(`${label}: may not reflect the setting — ${got.check.detail}`); }
  ```
- Right after the base `measure()` line, before the device views:
  ```js
  await withTimeout(this.evaluate(freezeMedia, true, 'main'), 3000, 'freeze media').catch(() => {});
  ```
- Replace the vision loop body with:

```js
    // A reference shot of the frozen page: the vision checks compare against it, not the (moving) base shot.
    let refStats = null;
    const visionWanted = want.vision !== false && VISION_VIEWS.some((id) => want[id] !== false);
    if (visionWanted) {
      const ref = await withTimeout(this.send('Page.captureScreenshot', { format: 'png' }), 20_000, 'reference shot').catch(() => null);
      refStats = ref ? await this.decodeStats(ref.data, 'image/png') : null;
    }
    // Two committed frames after the filter changes (a 200 ms cap covers hidden tabs where rAF doesn't fire).
    const frames = () => withTimeout(this.evaluate(() => new Promise((r) => { let n = 0; const t = () => (++n >= 2 ? r(true) : requestAnimationFrame(t)); requestAnimationFrame(t); setTimeout(() => r(true), 200); }), null, 'main'), 2000, 'frames').catch(() => {});
    for (const id of VISION_VIEWS) {
      await view(id, {
        runMs: 30_000,
        restoreMs: 10_000,
        run: async () => {
          await this.send('Emulation.setEmulatedVisionDeficiency', { type: VISION_DEFICIENCY[id] });
          await settled(500);
          await frames();
          // Unclipped: through chrome.debugger a clipped capture skips the vision-deficiency filter.
          const got = await grabFold(id, false);
          const shot = got.shots.find((s) => s.kind === 'viewport');
          const stats = shot ? await this.decodeStats(shot.data, shot.mimeType) : null;
          return { ...got, check: visionCheck(id, stats, refStats) };
        },
        restore: () => this.send('Emulation.setEmulatedVisionDeficiency', { type: 'none' }),
      });
    }
```

The `frames` helper may wait a little longer than two frames, because both the animation-frame and timeout callbacks advance it. That's acceptable, since it only needs at least two.

- Before the reload-based views (the nojs block), add:
  ```js
  await withTimeout(this.evaluate(freezeMedia, false, 'main'), 3000, 'unfreeze media').catch(() => {});
  ```
  Task 3 also moves noimages there.
- At the end, next to `patch.capture.views = views;`, add `patch.capture.viewChecks = checks;`.

**Report sizing check:** `shotView`/`foldImage` in `report.js` sizes vision images using the `scale` field set on css-scaled shots. With the clip gone, vision shots carry `dpr` like the other fold shots. Open the screens pane on a reading (or read `foldImage`) and confirm vision thumbnails still render at the same displayed size. If `foldImage` relied on `scale`, use `cssWidth` as the other fold views do.

- [ ] **Step 6: Run the unit suite**

Run: `npm test`
Expected: PASS. The browser path is verified in Task 7.

- [ ] **Step 7: Commit**

```bash
git add extension/browser/capture.js test/capture-helpers.test.mjs
git commit -m "Views: vision shots without a clip (the filter now shows), media frozen during views, vision self-checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: A real images-off load (no-images via Fetch and a reload)

**Files:**
- Modify: `extension/browser/capture.js`:
  - `onEvent` (handle `Fetch.requestPaused`);
  - `onChild` (enable Fetch on new child sessions while blocking);
  - the noimages view;
  - remove `stripImages`;
  - a new in-page `imagesProbe`.

**Interfaces:**
- Consumes: the `checks` and `view()` check handling, and the `freezeMedia(false)` placement (Task 2).
- Produces: the in-page `imagesProbe() → { imgPainted, bgPainted, mediaPlaying }`, and `checks.noimages`.

- [ ] **Step 1: Blocking plumbing**

Add these session fields in the constructor: `this.blockingImages = false; this.fetchSessions = new Set();`.

```js
  /** Block Image and Media requests (the no-images view): main session plus every child session. */
  async blockImages(on) {
    const patterns = [{ resourceType: 'Image' }, { resourceType: 'Media' }];
    if (on) {
      this.blockingImages = true;
      for (const sid of [undefined, ...this.childSessionIds()]) {
        await this.send('Fetch.enable', { patterns }, sid).then(() => this.fetchSessions.add(sid ?? '')).catch(() => {});
      }
    } else {
      this.blockingImages = false;
      for (const sid of this.fetchSessions) await this.send('Fetch.disable', {}, sid || undefined).catch(() => {});
      this.fetchSessions.clear();
    }
  }
```

`childSessionIds()` returns the current child session ids. The recorder tracks them in `this.recorder.targets` (a Map of session id → type), so use `[...this.recorder.targets.keys()]`.

In `onEvent`, near the top:

```js
    if (method === 'Fetch.requestPaused') {
      // The no-images view: fail image and media requests so the page loads exactly as with images off.
      const fail = this.blockingImages && /^(Image|Media)$/.test(params.resourceType);
      this.send(fail ? 'Fetch.failRequest' : 'Fetch.continueRequest', fail ? { requestId: params.requestId, errorReason: 'BlockedByClient' } : { requestId: params.requestId }, sid).catch(() => {});
      return;
    }
```

In `onChild`, after the child session's own setup, if `this.blockingImages` is true:

```js
      if (this.blockingImages) await this.send('Fetch.enable', { patterns: [{ resourceType: 'Image' }, { resourceType: 'Media' }] }, sessionId).then(() => this.fetchSessions.add(sessionId)).catch(() => {});
```

Do this before `Runtime.runIfWaitingForDebugger`, so the child's first image requests are caught.

- [ ] **Step 2: `imagesProbe`** (self-contained, in-page)

```js
/** After an images-off load: what still paints an image? */
function imagesProbe() {
  const shown = (el) => el.getClientRects().length > 0;
  let imgPainted = 0, mediaPlaying = 0;
  const walk = (root) => {
    for (const img of root.querySelectorAll('img')) if (shown(img) && img.complete && img.naturalWidth > 0) imgPainted++;
    for (const v of root.querySelectorAll('video')) if (shown(v) && v.readyState >= 2) mediaPlaying++;
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(document);
  const IMG = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)(\?|#|$)/i;
  const bgPainted = performance.getEntriesByType('resource')
    .filter((e) => (e.initiatorType === 'css' || e.initiatorType === 'img' || IMG.test(e.name)) && (e.decodedBodySize > 0 || e.transferSize > 0)).length;
  return { imgPainted, bgPainted, mediaPlaying };
}
```

- [ ] **Step 3: The view.** Delete the old `view('noimages', …)` block and `stripImages`. Add a new noimages view immediately **before** the nojs block, after the `freezeMedia(false)` call from Task 2:

```js
    await view('noimages', {
      runMs: 60_000,
      restoreMs: 30_000,
      run: async () => {
        await this.blockImages(true);
        await this.reloadQuiet();
        await this.settle(15_000);
        if (!this.loaded) throw new Error('page did not finish loading without images');
        await withTimeout(this.evaluate(freezeMedia, true, 'main'), 3000, 'freeze media').catch(() => {});
        const got = await grab('noimages');
        const p = await withTimeout(this.evaluate(imagesProbe, null, 'main'), 5000, 'images probe').catch(() => null);
        const left = p ? [p.imgPainted && `${p.imgPainted} images still painted`, p.bgPainted && `${p.bgPainted} image files loaded`, p.mediaPlaying && `${p.mediaPlaying} videos playing`].filter(Boolean) : ['not measured'];
        return { ...got, measured: got.measured && p ? { ...got.measured, ...p } : got.measured, check: { ok: !!p && left.length === 0, detail: p ? (left.join(', ') || 'no images, backgrounds or video') : 'not measured' } };
      },
      restore: async () => {
        await this.blockImages(false);
        await this.reloadQuiet().catch(() => {});
        await this.settle(15_000);
      },
    });
```

When nojs is also wanted, the tab ends with the nojs restore's reload. The noimages restore reload is still required, so that nojs starts from a normal page.

Update the `captureViews` doc comment: no-images and no-JS are the reload-based views at the end.

**Measured shape:** the resilience comparison (`compareViews`) reads `views.noimages` measurements as before (text, links, images, imagesWithAlt and so on). They now describe a real images-off page, and the probe fields are added to them.

- [ ] **Step 4: Run the unit suite**

Run: `npm test`
Expected: PASS. Fix any test that referenced `stripImages` or the `data-harplus-src` attributes, and list them in the report.

- [ ] **Step 5: Commit**

```bash
git add extension/browser/capture.js test/
git commit -m "No-images view: block image and media requests and reload (a real images-off load), with a self-check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Self-checks and keepers for the in-place views

**Files:**
- Modify: `extension/browser/capture.js`:
  - `stripStyles`, `flipDir` and `pseudoText` gain a `MutationObserver` keeper;
  - a new in-page `viewProbe(kind, arg)`;
  - the nocss, rtl, pseudo, display, spacing, reflow, text200, breakpoint, device and nojs views return a `check`.
- Test: `test/capture-helpers.test.mjs` (extend; the pure decision part of `viewProbe`)

**Interfaces:**
- Produces: `viewProbe(kind: string, arg) → { ok, detail }`, run in-page. Kinds: `'nocss'`, `'rtl'`, `'pseudo'`, `'media'` (arg: a media query), `'spacing'`, `'width'` (arg: the expected `innerWidth`), `'rootFont'` (arg: the minimum px).
- Each keeper counts its re-applications in `window.__harplusKeep.count`.

- [ ] **Step 1: `viewProbe`** (self-contained, exported for tests, in-page)

```js
/** Is the view's change in effect right now? Runs in the page just before the shot. */
export function viewProbe(kind, arg) {
  const kept = window.__harplusKeep?.count ? ` (re-applied ${window.__harplusKeep.count} times)` : '';
  if (kind === 'nocss') {
    const live = [...document.styleSheets].filter((s) => !s.disabled).length + (document.adoptedStyleSheets?.length || 0);
    const styled = document.querySelectorAll('[style]').length;
    return live || styled ? { ok: false, detail: `${live} style sheets and ${styled} style attributes still active` } : { ok: true, detail: `all styles off${kept}` };
  }
  if (kind === 'rtl') {
    const ok = document.documentElement.getAttribute('dir') === 'rtl' && getComputedStyle(document.body || document.documentElement).direction === 'rtl';
    return ok ? { ok: true, detail: `right-to-left${kept}` } : { ok: false, detail: 'the page removed the RTL direction' };
  }
  if (kind === 'pseudo') {
    const saved = window.__harplusPseudo || [];
    const live = saved.filter(([n, orig]) => n.isConnected && n.textContent !== orig).length;
    const share = saved.length ? live / saved.length : 1;
    return share >= 0.9 ? { ok: true, detail: `${Math.round(share * 100)}% of text pseudo-localised${kept}` } : { ok: false, detail: `the page restored ${Math.round((1 - share) * 100)}% of the text` };
  }
  if (kind === 'media') return matchMedia(arg).matches ? { ok: true, detail: `${arg} active` } : { ok: false, detail: `${arg} not active in the page` };
  if (kind === 'spacing') {
    const ok = !!document.getElementById('harplus-spacing') && getComputedStyle(document.body || document.documentElement).letterSpacing !== 'normal';
    return ok ? { ok: true, detail: 'text spacing applied' } : { ok: false, detail: 'text spacing not applied' };
  }
  if (kind === 'width') return Math.abs(innerWidth - arg) <= 1 ? { ok: true, detail: `${innerWidth} px wide` } : { ok: false, detail: `viewport is ${innerWidth} px, expected ${arg}` };
  if (kind === 'rootFont') { const px = parseFloat(getComputedStyle(document.documentElement).fontSize); return px >= arg ? { ok: true, detail: `root font ${px} px` } : { ok: false, detail: `root font ${px} px, expected at least ${arg}` }; }
  return { ok: true, detail: 'not measured' };
}
```

**Unit test** (append to `test/capture-helpers.test.mjs`): stub `window`, `document`, `getComputedStyle` and `matchMedia`, then assert each kind's pass and fail:
- `nocss` with one enabled sheet → fail;
- `rtl` with `dir="ltr"` → "the page removed the RTL direction";
- `pseudo` with 5 of 10 restored → fail;
- `media` true/false;
- `width` 320 vs 1280;
- `rootFont` 32 ≥ 30.

- [ ] **Step 2: Keepers.** In each of `stripStyles(true)`, `flipDir(true)` and `pseudoText(true)`, start a `MutationObserver` on `document` (`subtree: true`, plus `childList`/`attributes`/`characterData` as needed). It re-applies only that view's change, increments `window.__harplusKeep.count`, and stores the observer on `window.__harplusKeep.observer`. Each `(false)` path disconnects and deletes `window.__harplusKeep` **before** restoring. Concretely:
  - **`stripStyles`:**
    - on added `<style>` or `<link rel~=stylesheet>` nodes, disable their sheet (`node.sheet && (node.sheet.disabled = true)`, retried on `load` for links) and push it onto `store.sheets`;
    - on an added or changed `style` attribute, move it to `data-harplus-style`;
    - inside open shadow roots, observing each root found at `on` time is enough.
  - **`flipDir`:** on an `attributes` mutation of `dir` on `<html>`, set it back to `rtl`.
  - **`pseudoText`:**
    - on `characterData` or added text nodes that pass `keep()`, record `[node, original]` in `window.__harplusPseudo` (if not already saved) and pseudo-localise them;
    - guard against reacting to its own writes with a `writing` flag;
    - `pseudoText(false)` already restores every saved original.

  Keep each helper self-contained: the observer callbacks live inside the function.
- [ ] **Step 3: Checks in the views.** Each in-place view's `run` returns `{ ...got, check }`, with the check taken just before its shot. Before the vision loop, store `const baseRoot = await this.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize), null, 'main').catch(() => 16);` for the text200 check.

  | View | Check |
  |---|---|
  | nocss | `viewProbe('nocss')` |
  | rtl | `viewProbe('rtl')` |
  | pseudo | `viewProbe('pseudo')` |
  | display (dark, forced, morecontrast, print) | `viewProbe('media', Q[id])` with `Q = { dark: '(prefers-color-scheme: dark)', forced: '(forced-colors: active)', morecontrast: '(prefers-contrast: more)', print: 'print' }` |
  | spacing | `viewProbe('spacing')` |
  | reflow | `viewProbe('width', 320)` |
  | text200 | `viewProbe('rootFont', baseRoot * 1.8)` |
  | breakpoints | `viewProbe('width', width)` |
  | devices | `viewProbe('width', VIEW_DEVICES[id].width)` |
  | nojs | `{ ok: true, detail: 'scripts disabled by the browser' }` once the reload completed |

  Evaluate each probe with `withTimeout(this.evaluate(viewProbe, …, 'main'), 3000, 'view check').catch(() => ({ ok: true, detail: 'not measured' }))`.

  **Order caveat:** probe **before** the `grab`/`grabFold`. `grab`'s full-page capture can resize the page, so a probe after it could falsely fail the width checks.
- [ ] **Step 4: Run the unit suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/browser/capture.js test/capture-helpers.test.mjs
git commit -m "Views: in-place views keep their change against page scripts and record a self-check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Report notes, and plugins skip unverified views

**Files:**
- Modify: `extension/ui/report.js` (the screens pane figures), `extension/ui/theme.css` (a small `.view-check` note style using the warning colour)
- Modify: `extension/plugins/a11y-views.js`, `extension/plugins/international.js`, `extension/plugins/resilience.js`
- Test: `test/report.test.mjs`, `test/a11y-views.test.mjs`, `test/international.test.mjs`, and the resilience test file (find it with `grep -l resilience test/*.mjs`)

**Interfaces:**
- Consumes: `capture.viewChecks`.

- [ ] **Step 1: Failing tests**

**Report:** build a reading (`load()` fixture) and set `capture.viewChecks = { protanopia: { ok: false, detail: 'colours unchanged (0% of pixels shifted)' }, nocss: { ok: true, detail: 'all styles off' } }`. Assert:
- the rendered output contains `May not reflect the setting — colours unchanged (0% of pixels shifted)` exactly once;
- it has no note for nocss;
- with no `viewChecks`, there is no `May not reflect` text at all (Review Focus 5).

**a11y-views:** `run({ reflow: { ...B, overflowX: 40, scrollsX: true } })` with `viewChecks.reflow = { ok: false, detail: 'viewport is 1280 px, expected 320' }`. Expect:
- no reflow finding;
- the info finding `Reflow 320 px view could not be verified — viewport is 1280 px, expected 320`. Use the view label `VIEW_LABELS.reflow`; adjust the expected title to whatever that label is.

**international:** `rtl` with `overflowX: 500, scrollsX: true` and a failed rtl check gives the info finding and no "Right-to-left layout scrolls sideways".

**resilience:** a failed noimages check means the noimages comparison is skipped, and the info finding is present.

**Older readings:** with no `viewChecks`, results are unchanged from today. Existing tests cover this; keep them passing.

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implement**

**Report:** add a helper,

```js
const checkNote = (c) => (c && c.ok === false ? html`<span class="view-check">May not reflect the setting — ${c.detail}</span>` : '');
```

Append `${checkNote(hp(reading).capture?.viewChecks?.[v])}` inside every view `<figcaption>` in the screens pane:
- device;
- resilience (nocss, noimages, nojs);
- international (rtl, pseudo);
- vision;
- display and WCAG;
- breakpoints.

**`theme.css`** (`@layer components`): `.view-check { display: block; font-size: 0.78rem; color: var(--ink-warning); }`.

**Plugins:** add a shared helper in `extension/core/views.js`:

```js
/** Views whose self-check failed: their measurements may not reflect the setting. */
export const failedChecks = (reading) => Object.entries(reading.log._harplus?.capture?.viewChecks || {}).filter(([, c]) => c?.ok === false);
```

In each plugin:
- treat a view whose check failed as absent: `const bad = new Set(failedChecks(reading).map(([id]) => id));` and `views[id]` → `bad.has(id) ? undefined : views[id]`;
- for each failed view it would have used, add `info: ${VIEW_LABELS[id] || id} view could not be verified — ${detail}`. Use the plugin's own category: `accessibility` for a11y-views, `international` for international, and the existing resilience category for resilience;
- to avoid three plugins repeating the same note, a plugin only reports the views it consumes:
  - a11y-views: `dark`, `forced`, `morecontrast`, `print`, `spacing`, `reflow`, `text200`, vision ids;
  - international: `rtl`, `pseudo`;
  - resilience: `nocss`, `noimages`, `nojs`.

- [ ] **Step 4: Run the tests**

Run: the four test files, then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/ui/report.js extension/ui/theme.css extension/core/views.js extension/plugins/a11y-views.js extension/plugins/international.js extension/plugins/resilience.js test/
git commit -m "Report and plugins: unverified views are labelled and not used for findings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: E2E fixtures that would have caught both bugs

**Files:**
- Create: `test/e2e/site/img/loop.webm` (generated once with ffmpeg; under 50 KB), `test/e2e/site/img/lazy-a.png` and `test/e2e/site/img/lazy-b.png` (tiny solid colours; any small PNG made with ffmpeg)
- Modify: `test/e2e/site/index.html`, `test/e2e/site/app.css`, `test/e2e/site/frame.html`, `test/e2e/run.mjs`, and `test/e2e/server.mjs` (only if it needs a content type for `.webm`)

- [ ] **Step 1: Assets**

```bash
ffmpeg -y -f lavfi -i "testsrc=size=160x90:rate=10:duration=2" -c:v libvpx-vp9 -b:v 40k -an test/e2e/site/img/loop.webm
ffmpeg -y -f lavfi -i "color=c=0x3366cc:s=64x64:d=1" -frames:v 1 test/e2e/site/img/lazy-a.png
ffmpeg -y -f lavfi -i "color=c=0xcc6633:s=64x64:d=1" -frames:v 1 test/e2e/site/img/lazy-b.png
```

Check that `server.mjs` serves `.webm` as `video/webm` and `.png` as `image/png`; add them to its type map if missing.

- [ ] **Step 2: Fixture markup.** Near the top of `<main>` in `index.html`, inside the first viewport so every fold shot includes it:

```html
    <div class="colour-test" aria-hidden="true"><span></span><span></span></div>
    <video class="loop" src="/img/loop.webm" autoplay muted loop playsinline width="160" height="90"></video>
    <img class="lazy" data-src="/img/lazy-a.png" alt="Lazy image A" width="64" height="64">
    <div class="lazy-bg" data-bg="/img/lazy-b.png"></div>
    <script>
      // A lazy loader that (re)sets images when they come into view — the old in-place no-images view lost to this.
      const io = new IntersectionObserver((es) => es.forEach((e) => {
        if (!e.isIntersecting) return;
        const t = e.target;
        if (t.dataset.src) t.src = t.dataset.src;
        if (t.dataset.bg) t.style.backgroundImage = `url(${t.dataset.bg})`;
      }));
      document.querySelectorAll('[data-src],[data-bg]').forEach((el) => io.observe(el));
      // A page that fights right-to-left: put dir back shortly after it changes.
      new MutationObserver(() => { if (document.documentElement.dir === 'rtl') setTimeout(() => { document.documentElement.dir = 'ltr'; }, 100); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['dir'] });
    </script>
```

In `app.css`:

```css
.colour-test { display: flex; width: 600px; height: 200px; }
.colour-test span { flex: 1; }
.colour-test span:first-child { background: #e00000; }
.colour-test span:last-child { background: #00b000; }
.lazy-bg { width: 64px; height: 64px; }
```

In `frame.html` (the second-origin iframe), add `<img src="/img/lazy-a.png" alt="Frame image" width="32" height="32">`. That covers Review Focus 2.

**Watch for fixture-wide effects.** The "fights RTL" observer keeps setting `dir="ltr"` after the right-to-left view's flip. The keeper must win, because that's the test.

Update existing e2e assertions that change only because of the new elements (counts of images, links, findings, "images without alt" and so on), and list each one in the report. Don't loosen anything else.

- [ ] **Step 3: Assertions** in `run.mjs`, near the screens and views assertions for reading 1. Decode shots the same way as the product, by importing `imageStats` in the viewer page:

```js
    const vc = r1.log._harplus.capture.viewChecks || {};
    for (const id of ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia', 'blurred', 'lowcontrast']) assert.equal(vc[id]?.ok, true, `${id} check: ${JSON.stringify(vc[id])}`);
    const statsOf = (view) => page2.evaluate(async ([shots, v]) => {
      const s = shots.find((x) => x.view === v && x.kind === 'viewport');
      const { imageStats } = await import('/core/view-checks.js');
      const bmp = await createImageBitmap(await (await fetch(`data:${s.mimeType};base64,${s.data}`)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
      const st = imageStats(g.getImageData(0, 0, bmp.width, bmp.height).data, bmp.width, bmp.height);
      return { sat: st.sat, edge: st.edge };
    }, [r1.log._harplus.screenshots.filter((x) => x.kind === 'viewport'), view]);
    const achro = await statsOf('achromatopsia');
    assert.ok(achro.sat <= 0.03, `achromatopsia shot is grey (saturation ${achro.sat})`);
    assert.ok((await statsOf('blurred')).edge < (await statsOf('desktop')).edge, 'blurred shot has softer edges than desktop');
    assert.equal(vc.noimages?.ok, true, `noimages check: ${JSON.stringify(vc.noimages)}`);
    const ni = r1.log._harplus.capture.views.noimages;
    assert.deepEqual([ni.imgPainted, ni.bgPainted, ni.mediaPlaying], [0, 0, 0], 'no image, background or video in the images-off load (Review Focus 1, 2)');
    assert.equal(vc.rtl?.ok, true, `rtl kept despite the page resetting dir: ${JSON.stringify(vc.rtl)}`);
    assert.match(vc.rtl.detail, /re-applied/);
    for (const id of ['nocss', 'pseudo', 'dark', 'forced', 'morecontrast', 'print', 'spacing', 'reflow', 'text200']) assert.equal(vc[id]?.ok, true, `${id} check: ${JSON.stringify(vc[id])}`);
```

If `page2` isn't a viewer page with module access at that point, use whichever extension page the test already uses for `getReading`.

**Also assert the tab is clean after views:**
- the existing `restoreCheck` assertions;
- `await page.evaluate(() => document.documentElement.dir)` is not `rtl`;
- the fixture video is playing again (`!document.querySelector('video.loop').paused`), after both reloads.

- [ ] **Step 4: Run everything**

Run: `npm test`, then `npm run test:e2e` three times.
Expected: all pass, 3 of 3.

**Prove the vision assertion bites:** temporarily restore `grabFold(id, false, 'css')` in the vision loop, run the e2e, and confirm the achromatopsia assertion fails. Then revert, and record both runs in the report.

- [ ] **Step 5: Commit**

```bash
git add test/e2e
git commit -m "E2E: colour block, looping video, lazy loader, an RTL-fighting page and an iframe image; view self-checks and pixel assertions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Calibration (controller, not a subagent)

- [ ] Run `node scripts/calibrate.mjs https://www.sdsu.edu/` and `node scripts/calibrate.mjs --all` from the worktree, in the background.
- [ ] For each site, list the view checks that failed, with their details.
- [ ] Look at sdsu.edu's no-images viewport and full-page shots:
  - no photo, circle background or video frame;
  - the vision shots visibly differ (achromatopsia grey, blurred soft).
- [ ] For any failing check, find the root cause. It is either a real page behaviour (record it in the ledger as known) or a capture bug (fix it with a test).
