# Calibration fixes — design

## Why

We took readings of ten real sites with `scripts/calibrate.mjs`: BBC, gov.uk, MDN, react.dev, Patagonia, Le Monde, Al Jazeera, NHK, Wikipedia and example.com. Overall scores were plausible, but several findings were false or inflated. Two of them moved scores noticeably: LCP measured after our own scroll, and readability scored over link lists.

This batch fixes what the triage found. **Success:** a re-run of the calibration no longer shows any of the false findings listed below, and the true findings are unchanged.

## Scope

| # | Problem seen | Fix |
|---|---|---|
| 1 | LCP and CLS include time after HAR-PLUS starts scrolling (Wikipedia 6.1 s, Al Jazeera 44 s, Le Monde CLS 0.82). "LCP image is lazy-loaded" follows the wrong element. | Only count entries from before the scroll starts |
| 2 | Readability treats a list of headlines as one sentence (gov.uk Flesch −23, Le Monde 3) | Split sentences on line breaks; score prose sentences only; "not enough prose" below a minimum |
| 3 | The duplicate `<title>` count includes SVG `<title>` (Al Jazeera 31) | Count only the document's own titles |
| 4 | "Focusable elements inside aria-hidden" counts elements that can't take focus | Count only elements that are really focusable |
| 5 | Contrast of 1.0:1 for white text over a CSS background image | Treat near-same colours as unknown; detect pseudo-element backgrounds |
| 6 | MDN reported as overflowing at 320 px, but a fresh load at 320 px doesn't | Wait for layout to settle; confirm the page really scrolls sideways |
| 7 | "Text clips at 200% size" fires on sideways scrolling alone | Report sideways scrolling as a separate, lower-severity finding |
| 8 | Patagonia served a bot-check / waiting page; nothing in the report said so | Detect interstitial pages and warn on the report |
| 9 | Short-line info finding on a homepage with few paragraphs | Line-length findings need at least 5 measured paragraphs |
| 10 | NHK refuses headless Chrome | Calibration runner: use asahi.com instead; add the interstitial verdict to the digest; commit the runner |

**Out of scope:**
- Page weight that includes content loaded during our scroll (Al Jazeera 11 MB). Weight is a transfer total, and scrolling is part of how the reading gathers lazy content.
- The head-order wording.
- Wikipedia's red links. Those 404s are real.
- The items parked from batch 4.

## Design

### 1. Performance timings stop where our scroll starts

**Marking the scroll start.** `scrollPage` in `extension/browser/capture.js` runs in the page's main world. It calls `performance.mark('harplus:scroll-start')` before its first `scrollTo`. If the page is captured more than once in the same document, the first mark wins.

**Vitals.** `vitals.collect()` reads `cut = performance.getEntriesByName('harplus:scroll-start')[0]?.startTime ?? Infinity`. Then:

- **LCP** is the last `largest-contentful-paint` entry with `startTime < cut`.
- **CLS** windows use only `layout-shift` entries with `startTime < cut`.
- **Long animation frames:** `loafs` (count and blocking time) use only frames whose `startTime < cut`.
- **The returned data** gains `cutAt: cut === Infinity ? null : Math.round(cut)`.
- **Detail lines** for LCP, CLS and blocking time end with "Measured up to <sec(cutAt)>, before HAR-PLUS scrolled the page." when `cutAt` is set.
- **No LCP entry before the cut** (the page painted nothing before then): `lcp` is `null`, as it already is when the browser reports no LCP.

**Images.** `images.collect()` applies the same cut when choosing the LCP image, so the "LCP image is lazy-loaded" finding follows the corrected element.

**Older readings.** Readings taken before this change have no mark, so `cut` is `Infinity` and the old behaviour holds.

### 2. Readability over prose only

**Splitting.** `splitSentences(text)` also splits on line breaks:

```js
text.split(/[.!?]+(?=\s|$)|[。！？]+|\n+/)
```

The content text comes from `innerText`, which puts block elements and `<br>` on new lines. Headlines, list items and nav labels therefore become separate fragments.

**`proseSentences(sentences, script)` (new, exported)** keeps a fragment when it has:
- at least 4 words, for scripts other than CJK; or
- at least 10 non-space characters, for CJK.

**Prose-only statistics.** In `analyze`, every readability statistic uses the prose sentences, counting words, syllables and letters within them only:
- Flesch, ARI, AARI and CJK characters per sentence;
- `avgSentence`, `longShare`, `buckets` and `hardest`.

`words`, `minutes` and the thin-content finding still use all the text.

**Minimum prose.** Below 5 prose sentences or 100 prose words:
- `reading.readability` is `'not enough prose'`;
- `flesch`, `grade`, `ari`, `aari` and `cjkCharsPerSentence` are `null`;
- there is no hard-to-read finding and no long-sentence finding.

The glance card and summary already handle missing values. The card's text becomes "Not enough prose to score".

**New field.** `reading.proseSentences` holds the count, so the UI can show "12 of 240 lines are prose".

### 3. Document titles only

`meta.collect()` counts `title` elements outside SVG:

```js
[...document.querySelectorAll('title')].filter((t) => !t.closest('svg')).length
```

Nothing else in the duplicate-tag logic changes.

### 4. Really-focusable elements inside aria-hidden

**Candidates.** The `focusable-hidden` check in `a11y-basics.js` takes these elements inside `[aria-hidden="true"]`:

```
a[href], area[href], button, input, select, textarea, summary, iframe, [contenteditable=""], [contenteditable="true"], [tabindex]
```

**Exclusions.** It keeps a candidate unless any of the following applies:
- its `tabindex` attribute parses to a negative number;
- it matches `:disabled`, or is an `input[type=hidden]`;
- it is inside `[inert]`;
- it is not rendered: `el.checkVisibility({ visibilityProperty: true })` is false, or, where `checkVisibility` is missing, it has no client rects or `visibility` isn't `visible`.

**Examples.** gov.uk's honeypot input (`tabindex="-1"`) drops out, and so does Wikipedia's hidden sticky header. A visible link inside an `aria-hidden` container is still reported.

### 5. Contrast: unknown instead of impossible ratios

**Pseudo-element backgrounds.** In `contrast.collect()`, `background(el)` also returns `null` (meaning unknown) when an element on the walk has a `::before` or `::after` with:
- a `background-image` other than `none`; and
- `content` other than `none` or `normal`.

**Same-colour pairs.** In `analyzeContrast`, a pair whose ratio is below 1.1 counts as unknown rather than failing. Text that is truly invisible against its background is almost always sitting over something we can't see, such as an image, a canvas or a sibling layer.

**Reporting.** The existing "N text elements over images or gradients could not be checked" info finding covers both kinds of unknown. Its wording becomes "…could not be checked (over images, gradients or layered backgrounds)".

### 6. Reflow at 320 px: settle, then confirm

**Settling.** After `Emulation.setDeviceMetricsOverride` to 320 px, the reflow view's fixed `sleep(600)` becomes a settle loop:
- read `document.documentElement.scrollWidth` every 250 ms;
- stop when two consecutive reads match and at least 600 ms have passed, or at 3000 ms;
- then call `grabFold`.

The text200 view uses the same loop after `Page.setFontSizes`. **New helper:** `settleLayout(maxMs)`, placed alongside `scrollPage` as an in-page function.

**Scroll test.** `measureView()` gains `scrollsX`, a boolean:
1. remember `scrollX` and `scrollY`;
2. `scrollTo(document.documentElement.scrollWidth, scrollY)`;
3. `scrollsX = scrollX > 0`;
4. restore the remembered position.

The test runs only when `overflowX > 0`; otherwise `scrollsX` is `false`.

**Findings.** In `a11y-views.js`, "Page scrolls horizontally at 320 px" requires `reflow.scrollsX !== false`, so older readings without the field still behave as before. When the overflow is real but no culprit element was found and the walk wasn't truncated, the detail says "No single element was found wider than the viewport; the extra width may come from margins or transforms."

### 7. 200% text: clipping vs sideways scrolling

**Splitting the finding.** In `a11y-views.js`, the text200 block separates two cases:
- `clips` (more clipped text boxes, at or above `A11Y_CLIP_EXTRA`) → **medium** "Text clips at 200% size (WCAG 1.4.4)". The detail reports the clipped count only.
- `scrolls` (not `clips`, but `newOverflow(big)` and `big.scrollsX !== false`) → **low** "Page scrolls sideways at 200% text size". The detail gives the overflow in px.

**Summary and check.**
- The summary rating is `poor` for `clips` and `needs-improvement` for `scrolls`.
- `checks` `text200` is `ok: grew && !clips`, so sideways scrolling alone is not a 1.4.4 failure.

### 8. Interstitial (bot-check / waiting-room) detection

**New pure module: `extension/core/interstitial.js`.**

```js
/** @returns {{ vendor: string, reason: string } | null} */
export function detectInterstitial(reading)
```

It works from data already in every HAR: the main document entry's status and response headers, every entry's request URL, `_harplus.target.title`, and the content plugin's `data.reading.words`. Because it needs no capture changes, it also works for imported and older readings.

**Signals, checked in order** (the first match wins):

1. **Strong header:** the main document has `cf-mitigated: challenge` (Cloudflare) or an `x-datadome` header together with status 403 (DataDome).
2. **Strong URL:** any request URL matches one of these patterns, which appear only on challenge pages:

   | Pattern | Vendor |
   |---|---|
   | `/botfailover|sitefailover/i` | Akamai |
   | `/captcha-delivery\.com/` | DataDome |
   | `/px-captcha/` | HUMAN |

   Some vendor URLs also load on normal protected pages, so they are **hints only** (they name the vendor but never trigger detection): `_Incapsula_Resource` (Imperva), `queue-it.net` (Queue-it's client script), `perimeterx.net` (HUMAN's sensor), and `challenges.cloudflare.com` and `/cdn-cgi/challenge-platform` (Cloudflare Turnstile).

3. **Title plus thin page:** the title matches `/just a moment|attention required|access denied|are you a (robot|human)|verify(ing)? you are (a )?human|security check|hang tight|you are (now )?in (the )?(queue|line)|waiting room|pardon our interruption|request unsuccessful/i` and the page has fewer than 300 words. The vendor is `unknown`, unless a hint names it: `cf-ray` or `server: cloudflare`, `x-datadome`, an Akamai `server` header, or one of the URLs above.
4. **Error status plus thin page:** the main document's status is 403, 429 or 503 and the page has fewer than 300 words.

`reason` is a short phrase such as "a request to …/botfailoveroriginal_files/…" or "title “Just a moment...”".

**Report.** When the function returns a result, `ui/report.js` renders an alert card above the overview hero: "**This looks like a bot check or waiting page (<vendor>), not the real page.** The findings and scores describe that page. Detected from <reason>." The card uses the existing warning styling, with a new `.card.alert` class in theme.css that uses the warning status colour.

**Scoring.** Scores are not altered. The reading is honest about what it captured.

**Calibration digest.** Each entry gains `interstitial`, and `digest.md` prints it under the site heading.

### 9. Line-length findings need enough paragraphs

The "Lines are long" and "Lines are short" findings require `lineLength.count >= 5`. The summary row and glance stat still show whatever was measured.

### 10. Calibration runner

- `scripts/calibrate.mjs` is committed.
- NHK is replaced with `https://www.asahi.com/` (Japanese).
- The digest includes `interstitial` (see §8).
- `test/e2e/out/` is already gitignored, so outputs stay out of git.

## Testing

**Unit tests** (`node --test`, extending the existing files):
- **`splitSentences` and `proseSentences`:** line-break splitting; the 4-word and 10-character CJK thresholds; a headline list giving "not enough prose" with null scores and no hard-to-read finding; a real article's Flesch unchanged within ±2 of the current value for prose without line breaks.
- **Line length:** no finding when `count < 5`.
- **`analyzeContrast`:** a 1.0:1 pair counts as unknown and not as failing; a 1.2:1 pair still fails.
- **`a11y-views`:** reflow overflow with `scrollsX: false` gives no finding; a missing `scrollsX` still gives a finding; text200 overflow without clipping gives the low "scrolls sideways" finding, and `checks.text200.ok` is true; clipping gives the medium finding.
- **`detectInterstitial`:**
  - the Patagonia-shaped reading → Akamai;
  - a `cf-mitigated` header → Cloudflare;
  - a "Just a moment..." title with 40 words → detected;
  - the same title with 2,000 words → `null`;
  - a normal page loading the Turnstile `challenges.cloudflare.com` → `null`;
  - a 403 with 50 words → detected;
  - a 403 with 1,000 words → `null`.

**E2E fixture** (`test/e2e`). The fixture page gains:
- an inline SVG with a `<title>`; the duplicate-title finding is absent;
- an `aria-hidden` container holding an `input tabindex="-1"` and a `visibility:hidden` link (no finding), and a separate `aria-hidden` container with a visible link (finding present);
- white text in a box whose `::before` carries a background image; it is counted as unknown and not failing.

Vitals: the e2e asserts `vitals.data.cutAt` is a number and `lcp.time <= cutAt`.

**Calibration re-run.** Run `node scripts/calibrate.mjs` and compare with the earlier digest. Expected:
- no duplicate-title finding on BBC, MDN, gov.uk or Al Jazeera;
- gov.uk and Le Monde show "not enough prose" or a plausible score with no medium hard-to-read finding;
- no focusable-hidden finding on gov.uk or Wikipedia;
- no 1.0:1 contrast pair on Al Jazeera;
- LCP below the scroll start on all sites;
- MDN has no reflow finding;
- no medium text200 finding on MDN or Wikipedia;
- Patagonia is flagged as an interstitial (if it still serves one).

Any site that still shows one of these needs investigation before merge; it does not get waved through.
