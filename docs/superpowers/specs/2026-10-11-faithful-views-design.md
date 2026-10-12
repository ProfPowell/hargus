# Faithful views: design

## Why

A HARgus reading of sdsu.edu showed two views that didn't show what they claim to.

1. **The vision views barely change.**
   - The protanopia, deuteranopia, tritanopia, achromatopsia, blurred-vision and reduced-contrast shots look like the normal page.
   - Measured: the achromatopsia shot's colour saturation is 0.235, the same as the desktop shot. It should be about 0.
   - **Root cause** (verified by probes):
     - Vision views are shot with a `clip` rectangle (`grabFold(id, false, 'css')`).
     - Through `chrome.debugger`, a clipped `Page.captureScreenshot` skips Chrome's vision-deficiency filter (saturation 0.238). An unclipped one applies it (saturation 0).
     - Playwright's own CDP session applies the filter either way, which is why no test caught this.
2. **The no-images view still shows images.**
   - **Video keeps playing.** `stripImages` only moves `poster` aside, so sdsu.edu's hero video paints frames, and so does a YouTube embed.
   - **The page can put images back.** `stripImages` edits the live DOM once: it swaps `<img src>` and adds a `background-image: none !important` style. Lazy loaders and page scripts can re-insert images afterwards, especially when the full-page screenshot makes everything "visible". The user's sdsu.edu full-page shot still showed the circle photos.

**The broader lesson:** several views edit the live page and assume the edit holds until the screenshot. Nothing checks that it did. This batch fixes the two broken views and gives every view a **self-check**. A view records whether it really showed what it claims; when it didn't, the reading says so, rather than a misleading screenshot passing silently.

**Success:**
- On sdsu.edu and the calibration sites:
  - the achromatopsia shot is greyscale;
  - the blurred shot is blurred;
  - the no-images shots show no photos, background images or video frames;
  - every view carries a passing self-check.
- When a self-check fails, the report labels that view "may not reflect the setting". Tests pin each self-check.

## Scope

| # | Change |
|---|---|
| 1 | Vision views: take the shot without a clip, so the vision filter is captured |
| 2 | No-images view: a real images-off load, with Image and Media requests blocked at the network level, then a reload; the tab is restored afterwards |
| 3 | Media frozen during views: videos paused and animations held, so views are comparable and video can't mask the setting |
| 4 | A self-check for every view, recorded in `capture.viewChecks[id]` and shown in the report |
| 5 | Re-applying DOM-edit views: no-CSS, right-to-left and pseudo-localisation keep their edit in place until the shot, and verify it |
| 6 | Tests: unit tests for the pure checks, plus e2e fixtures that would have caught both bugs (video, lazy-loaded image re-insertion, a colour block for the vision pixel check) |

**Out of scope:**
- Presets.
- Changing which views exist.
- Making the full-page screenshots cheaper.

## Design

### 1. Vision views without a clip (`extension/browser/capture.js`)

- **Unclipped shot.** In the vision views, `grabFold(id, false, 'css')` becomes an unclipped viewport shot: `grabFold(id, false)` without the `scale: 'css'` path. The shot is taken at the device pixel ratio, like the other fold shots.
- **Report scaling.** The report already handles `dpr` on fold shots, so the stored `scale` field is dropped for vision shots. Check how `shotView` and the screens pane size vision shots, and keep their displayed size unchanged.
- **Wait for the filter.** Keep `settled(500)`. Then wait two animation frames in the page, so a frame with the filter is committed before the shot: a `requestAnimationFrame` ×2 evaluate, with the 50 ms tick fallback as in `settleRender`.

### 2. A real images-off load (`capture.js`)

The no-images view follows the same pattern as no-JS: change a setting, reload, capture, undo the setting, reload.

**Block (run):**
1. Call `Fetch.enable` with `patterns: [{ resourceType: 'Image' }, { resourceType: 'Media' }]` on the main session. When `Target.setAutoAttach` is on, also call it on every attached child session (OOPIF iframes such as a YouTube embed), and on child sessions that attach while the block is active.
2. Handle `Fetch.requestPaused` in `onEvent` while `this.blockingImages` is true: `Fetch.failRequest({ requestId, errorReason: 'BlockedByClient' }, sid)`. Any other paused request (none expected) gets `Fetch.continueRequest`.
3. `reloadQuiet()`, then `settle(15_000)`, as nojs does. If the page didn't finish loading, the view fails with "page did not finish loading without images".
4. Freeze media (§3), then `grab('noimages')`, which takes viewport and full-page shots as today.

**Restore:** set `this.blockingImages = false`, call `Fetch.disable` on every session that was enabled, then `reloadQuiet()` and `settle(15_000)`.

**Ordering:** the no-images view moves to run immediately before nojs, so the two reload-based views sit together at the end, after every in-place view. The views that edit the page in place (nocss, rtl, pseudo) no longer run after a reload.

**Traffic:** view traffic is already discarded (`viewsRunning`). Blocked requests must not reach the recorder's reading, and must not count as busy in `waitForIdle`. Failed requests finish at once, so they don't.

**`stripImages` is removed,** along with its `data-harplus-src` / `-srcset` / `-poster` attributes and its error guard.

### 3. Media frozen during views (`capture.js`)

A new in-page helper, `freezeMedia(on)`, is self-contained because it is serialised into the page.

- **on:**
  - for every `<video>` and `<audio>` (light DOM and open shadow roots), remember `paused` and `currentTime`, then `pause()`;
  - `document.getAnimations().forEach((a) => a.pause())`, remembering which were running;
  - store all of this on `window.__harplusFrozen`.
- **off:** resume exactly what was playing and running, then delete the store.

`captureViews` calls `freezeMedia(true)` once before the first in-place view, and `freezeMedia(false)` in its own `finally`, before the reload-based views. Pausing doesn't change layout or page state, so `restoreCheck` is unaffected.

### 4. A self-check for every view

Each view records `{ ok: boolean, detail: string }` in a separate map, `capture.viewChecks[id]`, carried in the views patch. It is kept out of `capture.views`, because `layout`, `resilience`, `a11y-views`, `international` and the report treat every `capture.views` entry as a measurement.

**Checks:**

| View | Check | Passes when |
|---|---|---|
| Vision (6) | `imageStats(shot)` on the decoded viewport shot, in the service worker (`createImageBitmap` + `OffscreenCanvas`): mean saturation, edge energy (mean absolute luminance difference between neighbours) and luminance spread (p95 − p5), compared with the base desktop shot's stats | achromatopsia: saturation ≤ 0.03. protanopia, deuteranopia, tritanopia: the mean colour shift from base is at least 2% of pixels changed by more than 8/255 in some channel. blurred: edge energy ≤ 0.75 × base (calibrated: blurred shots measure 31–60% on real sites, unblurred 93–95%). lowcontrast: luminance spread ≤ 0.8 × base. If base saturation < 0.02 (an already-grey page), the colour checks pass with the detail "page has no colour to change" |
| No-images | In-page after load: `{ imgPainted, bgPainted, mediaPlaying }`, where `imgPainted` is `<img>` with `complete && naturalWidth > 0`; `bgPainted` is elements whose computed `background-image` contains `url(` and whose resource loaded (`performance.getEntriesByType('resource')` with `initiatorType` `css` or `img`, `transferSize > 0` or `decodedBodySize > 0`, started after the view's reload); `mediaPlaying` is `<video>` with `readyState >= 2` | all three are 0 |
| No-JS | The browser enforces `Emulation.setScriptExecutionDisabled`, so this check confirms the reload finished with the setting on | the reload completed; detail "scripts disabled by the browser" |
| No-CSS | In-page before the shot: every `document.styleSheets[i].disabled` is true, no adopted sheets in the document or open shadow roots, and no element has a `style` attribute | all hold. Re-apply (§5) runs first |
| Right-to-left | `document.documentElement.dir === 'rtl'` and computed `direction` of `<body>` is `rtl` at shot time | both |
| Pseudo-localisation | The share of saved text nodes still connected with their pseudo text, at shot time | ≥ 0.9 |
| Display media (dark, forced, more contrast, print) | `matchMedia` of the emulated feature is true in the page at shot time | true |
| Spacing | `getComputedStyle(document.body).letterSpacing` is not `normal` and the spacing style is attached | both |
| Reflow, text200, breakpoints, devices | The viewport width or font size the view set is in effect at shot time (`innerWidth`, or root font size double the base) | true |

**On failure:**
- the view keeps its shot;
- `check.ok` is `false` and the detail says what failed (for example "2 images still painted", "the page removed the RTL direction");
- a capture warning is added.

**Report** (screens pane, `report.js`): a view with `check.ok === false` shows a small amber note on its thumbnail: "May not reflect the setting — {detail}". Older readings without `check` show nothing.

**Findings:** `a11y-views`, `international` and `resilience` already skip missing views. They also skip a view whose check failed, because its measurements may be wrong, and add an info finding naming the view: "{View} view could not be verified — {detail}".

### 5. DOM-edit views keep their edit (`capture.js`)

no-CSS, right-to-left and pseudo-localisation run in place. Pages can undo them: a framework re-render restores text, a script re-adds a stylesheet or resets `dir`.

- **Watcher.** Each one's `on` step starts a `MutationObserver` (stored on `window.__harplusKeep`). It re-applies only the view's own change:
  - **no-CSS:** newly added `<style>`, `<link rel=stylesheet>` or `style` attributes are disabled or moved to `data-harplus-style`, exactly as `stripStyles` does;
  - **right-to-left:** a changed `dir` is set back to `rtl`;
  - **pseudo-localisation:** new or changed text nodes are pseudo-localised, with the original recorded so `off` restores it.
- **Stopping.** The `off` step disconnects the observer before restoring.
- **Counting.** The number of re-applications goes in `check.detail` ("re-applied 3 times") and doesn't fail the check.
- **Self-contained.** The observer code stays inside the helpers.

### 6. Tests

**Unit tests:**
- `imageStats` and `visionCheck(view, stats, baseStats)` are pure and exported from a new `extension/core/view-checks.js`:
  - synthetic RGBA buffers: grey vs colour saturation, a sharp vs blurred edge, wide vs narrow luminance spread;
  - each view's pass and fail thresholds;
  - the already-grey base case.
- `report.js`: the amber note for `check.ok === false`; nothing for older readings.
- `a11y-views` and `international`: a failed-check view is skipped and gets the info finding.

**E2E fixture** (`test/e2e/site/index.html` and the server):
- A 600×200 block split into pure red and green halves, near the top so it's in every fold shot. The vision pixel checks must pass. **Assert:**
  - the achromatopsia shot's saturation is at most 0.03, measured in the test with the same `imageStats`;
  - the blurred shot's edge energy is lower than the desktop shot's;
  - every vision view's `check.ok` is true.
- A small looping `<video autoplay muted loop>` served by the test server (`/img/loop.webm`, a few frames generated once into `test/e2e/site/img/`, under 50 KB). In the no-images view it must not play. **Assert** that `capture.viewChecks.noimages.ok` is true, and that the no-images measurement reports `mediaPlaying: 0`.
- A lazy loader: a script that, on `IntersectionObserver`, sets `img.src` from `data-src` and `el.style.backgroundImage` from `data-bg`. **Assert** that in no-images `imgPainted` and `bgPainted` are 0. That would have failed with the old in-place stripping.
- A script that re-adds `dir="ltr"` to `<html>` 100 ms after it changes. **Assert** that the right-to-left view's `check.ok` is true and its detail mentions re-application.
- Existing e2e assertions still pass, including the screens list, `restoreCheck` and the closed-tab case.

**Calibration:** re-run sdsu.edu and the 20 calibration sites.
- Every vision `check.ok` is true.
- sdsu.edu's no-images view shows no photo, circle background or video frame (check by eye), and its check passes.
- List any failing checks with their details, then root-cause them or record them as known page behaviour.

## Notes

- The no-images reload adds about one page load plus one restore load per reading, comparable to nojs.
- Blocking at the network level also covers `<picture>`, `srcset`, `image-set()`, `mask-image`, `border-image`, `list-style-image`, CSS `content: url()`, SVG `<image>` and favicons, which the in-place edit never handled.
