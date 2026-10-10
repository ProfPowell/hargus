# Images, carbon and international — design

Date: 2026-10-10 · Status: approved in brainstorming, awaiting spec review

## Goal

Three new readings. Build them in this order:

1. **Images.** Measure how well each image is encoded and sized, using real re-encodes in the browser.
2. **Carbon.** Estimate CO₂ per page view with the Sustainable Web Design Model v4. Use the Green Web Foundation lookup to check green hosting.
3. **International.** Add translation and right-to-left checks, plus two in-place capture views: Right-to-left and Long text (pseudo-localized).

## Decisions made during brainstorming

| Topic | Decision |
|---|---|
| Scorecard | Two new areas: **International** and **Sustainability**. Images go into Performance. |
| Weights | Performance 20, Accessibility 20, Security 20, Build & content 15, Infrastructure 10, International 8, Sustainability 7 |
| Image savings | Measured by re-encoding in the browser, not by heuristics |
| Green hosting | Green Web Foundation lookup, on by default and disclosed (↗) |
| International views | Right-to-left and Long text views, on by default |

## Constraints

- No build step and no dependencies.
- Every lookup that leaves the machine has a `disclosure` and is skippable through the enrich phase or `--no-lookups`.
- In-place views follow the existing capture-views rules:
  - they run after `recorder.build()`;
  - each one is isolated and bounded;
  - each one restores the tab;
  - each commits its results only on success.
- Every interpolated value goes through the escaping `html` tag.
- Old readings must render. New areas show as "not measured".

## 0. Scorecard (`core/score.js`, `core/har-util.js`)

- `AREAS`, in this order, with these weights:

  | Order | `id` | Label | Weight |
  |---|---|---|---|
  | 1 | performance | Performance | 20 |
  | 2 | accessibility | Accessibility | 20 |
  | 3 | security | Security | 20 |
  | 4 | build | Build & content | 15 |
  | 5 | infrastructure | Infrastructure | 10 |
  | 6 | international | International | 8 |
  | 7 | sustainability | Sustainability | 7 |

- `CATEGORIES` gains `international` and `sustainability`. `CATEGORY_AREA` maps each of them to the area of the same name.
- `pluginArea` accepts the two new area ids.
- `metricInput('sustainability')`: when the `carbon` result is ok, blend 50/50 with the rating score.

  | Rating | A+ | A | B | C | D | E | F |
  |---|---|---|---|---|---|---|---|
  | Score | 100 | 90 | 80 | 70 | 55 | 40 | 25 |

  The input is labelled "Carbon rating".
- UI:
  - The sidebar lists seven areas.
  - The Overview area cards use `grid-template-columns: repeat(auto-fit, minmax(min(100%, 12.5rem), 1fr))`, which gives 4 + 3 at about 920 px.
  - The icon set gains `international` (a globe) and `sustainability` (a leaf).
  - The "Findings by area" bars list seven rows.
- Docs: the Scores section in PLUGINS.md gets the new weights and categories.

## 1. Images plugin (`extension/plugins/images.js`)

- **Plugin type.**
  - `id: 'images'`, `area: 'performance'`, `group: 'quality'`, `phase: 'page'`, `world: 'isolated'`.
  - It runs in the extension only. Like vitals, the CLI can't run it.
- **`collect()` (in the page).** Return up to 200 entries, one per `document.images` item, each with:
  - `src` (`currentSrc || src`);
  - `naturalWidth` and `naturalHeight`;
  - `displayWidth` and `displayHeight` from `getBoundingClientRect`;
  - `dpr`;
  - `loading`, `fetchpriority` and `decoding`;
  - `sized`: true when both `width` and `height` attributes exist, or the computed `aspect-ratio` is not `auto`;
  - `aboveFold`: true when the rect top is below `innerHeight`;
  - `inPicture`;
  - `alt` (present or not).

  `collect()` also returns the LCP element's `src`. Find it with `PerformanceObserver.getEntries` on a buffered `largest-contentful-paint` observer, or `performance.getEntriesByType('largest-contentful-paint')`. Take the last entry's `element?.currentSrc || element?.src || url`.
- **`run()` (in the service worker).** Join each image to its HAR entry by URL. The join gives `bytes = transferSize`, `mime`, and `format` from the MIME type or extension. Then re-encode the candidates:
  1. **Candidates:** raster images (jpeg, png, gif, webp, bmp) over 10 KB. Sort by bytes, descending, and take at most 20.
  2. **Fetch each candidate:** `ctx.fetch(url, { cache: 'force-cache' })`.
  3. **Encode:** run `createImageBitmap` on the blob. Then for each target size:
     - the target sizes are `needed = min(natural, round(display × dpr))`, plus the natural size;
     - draw onto an `OffscreenCanvas`;
     - `convertToBlob({ type: 'image/webp', quality: 0.8 })`;
     - try `{ type: 'image/avif', quality: 0.6 }` and keep the result only if `blob.type === 'image/avif'`.
  4. **Record per image:** `{ webpNeeded, webpNatural, avifNeeded | null, neededWidth, neededHeight }`.
  5. **Failures:** a per-image failure (CORS, decode, timeout) records `encodeError` and is skipped. The overall budget is 8 s.
- **Savings for an image.**
  - `best = min(bytes, webpNeeded, avifNeeded ?? Infinity)`.
  - `saving = bytes − best`.
  - `oversized`: `naturalWidth × naturalHeight > 2 × neededWidth × neededHeight` and `saving ≥ 50 KB`.
- **Findings** (category `performance`):

  | Finding | Severity |
  |---|---|
  | "N images are larger than they're shown" (oversized; detail lists the top 5 as `file natural → needed`) | low; medium if total oversized saving ≥ 300 KB |
  | "Modern formats would save X" (JPEG/PNG where WebP or AVIF saves ≥ 25 % and ≥ 20 KB) | low; medium if total ≥ 500 KB |
  | "N images without width and height" (count of images with `sized === false`) | low |
  | "The largest image (LCP) is lazy-loaded" | medium |
  | "The LCP image has no fetchpriority=high" (only when the LCP image is above the fold) | info |
  | "Animated GIF of X — use a video" (gif ≥ 200 KB) | low |
- **Summary.**
  - `{ label: 'Images', value: 'N · X total', headline: true }`
  - `{ label: 'Potential savings', value: 'X (Y%)', rating }`. The rating is good if savings are below 10 % of image bytes, needs-improvement if below 40 %, and poor otherwise.
  - `{ label: 'Formats', value: 'jpeg 12, webp 3, …' }`
- **Glance.**
  - Stat tiles for image weight, potential savings and oversized count.
  - A `stackBar` of bytes by format.
  - An `hbars` of the top 8 images by saving, each labelled with the filename and displayed as `X → Y`.
- **Render.** A table of every measured image: file, format, natural, needed, bytes, WebP, AVIF, saving.

## 2. Carbon plugin (`extension/plugins/carbon.js`)

- **Plugin type.**
  - `id: 'carbon'`, `area: 'sustainability'`, `group: 'other'`, `phase: 'enrich'`.
  - `disclosure: 'Sends each hostname to api.thegreenwebfoundation.org to check for green hosting.'`
  - `options: [{ key: 'greenCheck', type: 'checkbox', default: true, label: 'Check green hosting' }]`
- **Bytes.** Sum `transferSize` per host across the HAR entries.
- **Green check.**
  - Request `GET https://api.thegreenwebfoundation.org/api/v3/greencheck/{host}` for each distinct host, at most 25 hosts by bytes, with 4 requests in parallel.
  - `green = json.green === true` and `hostedBy = json.hosted_by`.
  - A failed lookup sets `green: null` (unknown) and the host is treated as not green.
  - Hosts that are IP addresses or private are skipped and treated as not green.
- **Model:** Sustainable Web Design Model v4, per page view.
  - The page is treated as a new visitor with no cache. Readings bypass the cache, so this is the conservative, first-visit figure, and the report says so.
  - Energy intensity in kWh/GB:

    | Segment | Operational | Embodied |
    |---|---|---|
    | Data centre | 0.055 | 0.012 |
    | Network | 0.059 | 0.013 |
    | Device | 0.080 | 0.081 |

  - Grid intensity: 494 g/kWh, the global average (Ember 2022).
  - For each host: `GB = bytes / 1e9`.
    - `dc_op = GB × 0.055 × 494 × (green ? 0 : 1)`
    - `dc_emb = GB × 0.012 × 494`
    - `net = GB × (0.059 + 0.013) × 494`
    - `dev = GB × (0.080 + 0.081) × 494`
  - Sum over hosts to give the grams per view, plus the segment totals.
- **Rating** (g per page view, SWDM v4 digital carbon ratings):

  | Rating | A+ | A | B | C | D | E | F |
  |---|---|---|---|---|---|---|---|
  | At most | 0.040 | 0.079 | 0.145 | 0.209 | 0.278 | 0.359 | more than 0.359 |

- **Findings** (category `sustainability`):

  | Finding | Severity |
  |---|---|
  | "Carbon rating C (X g per visit)" | low |
  | Rating D or E | medium |
  | Rating F | high |
  | "Main site isn't on green hosting" (when the first-party main host has `green === false`; `null`, i.e. unknown, doesn't count) | low |
- **Summary.**
  - `{ label: 'CO₂ per visit', value: 'X g · rating R', rating, headline: true }`. The rating maps A+, A and B to good; C and D to needs-improvement; E and F to poor.
  - `{ label: 'Green hosting', value: 'N of M hosts', headline: true }`
- **Data.** `{ model: 'SWDM v4', gridIntensity: 494, grams, rating, segments: { dataCentre, network, device }, hosts: [{ host, bytes, grams, green, hostedBy }], assumptions: 'first visit, no cache, global grid average' }`
- **Glance.**
  - A large stat: "X g CO₂ per visit", rating R, with the note "first visit · global grid average".
  - A stat: "10,000 visits / month ≈ Y kg CO₂ / year", where `Y = grams × 10000 × 12 / 1000`.
  - A `donut` of the three segments.
  - A `checklist` of the top 8 hosts by bytes, with the label `host · bytes`, `ok = green === true` and the note `hostedBy`. When `green` is null, show "unknown". To support that, the checklist gets an optional `ok: null` state, shown with the `info` icon and the title "unknown".

## 3. International

### 3a. Views (extend capture views)

- **View ids.** Add `rtl` and `pseudo`, both in a new `INTERNATIONAL_VIEWS` list, to `core/views.js`.
  - Labels: "Right-to-left" and "Long text".
  - `VIEWS` becomes the device views, then the resilience views, then the international views.
  - Settings: add `views.rtl: true` and `views.pseudo: true`, plus their checkboxes in the popup and Options.
- **`rtl` view (in place).** Save the `dir` value of `<html>`, set `dir="rtl"`, sleep 400 ms, shoot and measure, then restore the original `dir`, or remove the attribute if there wasn't one.
- **`pseudo` view (in place).**
  - Walk the text nodes under `body`. Skip text inside `script`, `style`, `noscript`, `textarea`, `code`, `pre`, `svg` and `[translate="no"]`, and skip whitespace-only nodes.
  - Store the originals in `window.__harplusPseudo` (an array of `[node, text]`).
  - Replace each node's text with `pseudo(text)`:
    - map ASCII letters to accented look-alikes (for example a→á, e→é, i→í, o→ó, u→ú, n→ń, c→ć, s→ś, z→ź, y→ý, A→Á, …);
    - then append `' ' + '·'.repeat(Math.ceil(len × 0.4))` for nodes of 3 or more characters.
  - Sleep 400 ms, shoot and measure, then restore the originals.
- **Order.** These run after the no-images view and before no-JS, so the no-JS restore reload cleans up anything left over in reload mode.
- **`measureView` additions.**
  - `overflowX`: `max(0, document.documentElement.scrollWidth − innerWidth)`.
  - `clipped`: the count of elements with non-whitespace direct text where `scrollWidth > clientWidth + 1` and `overflow-x` or `text-overflow` hides the overflow (`hidden`, `clip` or `ellipsis`), or where `scrollHeight > clientHeight + 1` with `overflow-y` `hidden` or `clip`. Cap the walk at 3,000 elements.
  - `rtlChars`: the share of letters in the Hebrew (U+0590–05FF) or Arabic (U+0600–06FF, U+0750–077F, U+08A0–08FF, U+FB50–FDFF, U+FE70–FEFF) ranges in `innerText`, from 0 to 1, rounded to 3 places.
  - `dir`: `document.documentElement.dir || getComputedStyle(document.documentElement).direction`.

### 3b. Plugin (`extension/plugins/international.js`)

- **Plugin type.**
  - `id: 'international'`, `area: 'international'`, `group: 'other'`, `phase: 'analyze'`.
  - It runs offline: in the CLI it uses whatever the reading contains.
- **Inputs.**
  - `capture.views`: base, `rtl` and `pseudo`.
  - `ctx.results.css?.data.usage.properties`: counts per property.
  - `ctx.results.meta?.data`: `lang`, `dir` and `hreflang`.
  - It skips only when none of the three inputs exists.
- **Physical vs. logical CSS.**
  - Physical properties:
    - `margin-left`, `margin-right`;
    - `padding-left`, `padding-right`;
    - `left`, `right`;
    - `border-left`, `border-right`, and their `-width`, `-color` and `-style` variants;
    - `border-top-left-radius`, `border-top-right-radius`, `border-bottom-left-radius`, `border-bottom-right-radius`.
  - Logical properties: every property that starts with `margin-inline`, `padding-inline`, `inset-inline` or `border-inline`, or that matches `border-(start|end)-(start|end)-radius`.
- **Language-tag validity.** Test with the regex `^[a-zA-Z]{2,3}(-[a-zA-Z]{4})?(-([a-zA-Z]{2}|\d{3}))?(-([a-zA-Z0-9]{5,8}|\d[a-zA-Z0-9]{3}))*$`. `x-default` is also allowed in hreflang.
- **Findings** (category `international`):

  | Finding | Severity |
  |---|---|
  | `pseudo.clipped − base.clipped ≥ 3`: "Text gets cut off when translated" | medium |
  | `pseudo.overflowX > 0 && base.overflowX === 0`: "Longer text makes the page scroll sideways" | medium |
  | `rtl.overflowX > 0 && base.overflowX === 0`: "Right-to-left layout scrolls sideways" | medium |
  | `base.rtlChars ≥ 0.05` and the direction isn't RTL: "Right-to-left text without dir=\"rtl\"" | medium |
  | `physical ≥ 20 && physical > 3 × logical`: "Layout CSS uses left/right instead of logical properties", with detail "N physical vs M logical" | low |
  | Invalid `lang`: "lang \"X\" is not a valid language tag" | low |
  | hreflang problems: invalid codes, no entry pointing at the page itself (compare against the canonical, or the final URL), no `x-default` when there are 3 or more alternates | low each, one finding listing the issues |
- **Summary.**
  - `{ label: 'Long text', value: 'N clipped · scrolls sideways | fits', rating, headline: true }`. Good when nothing new clipped and no overflow; needs-improvement when 1–2 new clipped; poor otherwise.
  - `{ label: 'Right-to-left', value: 'fits | scrolls sideways' }`
  - `{ label: 'Logical CSS', value: 'M logical · N physical' }`
  - `{ label: 'Language', value: 'lang · dir · K hreflang' }`
- **Glance.**
  - A `checklist` with these rows:
    - `lang` valid;
    - direction matches script;
    - hreflang OK;
    - logical CSS (not mostly physical);
    - long text fits;
    - RTL fits.
  - A `stackBar` of logical vs. physical declarations.

### 3c. Screens page

Add a third section, **International**, with the same switch and chips as Resilience. Its tiles are As designed, Right-to-left and Long text.

- Chips for `rtl`: "fits" (good) or "scrolls sideways" (poor).
- Chips for `pseudo`: `"+N clipped"`, which is good when N = 0, needs-improvement when N is 1–2, and poor when N ≥ 3. Add "scrolls sideways" (poor) when it applies.

## 4. Testing

- **`test/images.test.mjs`.** Run `run()` with a fake `ctx.collected` and a fake HAR. Mock `ctx.fetch`, and inject fake `createImageBitmap`/`OffscreenCanvas` through a small seam: `images.js` exports `encodeWith(env)`, which uses `globalThis` by default. Cover:
  - candidate selection and the join;
  - the savings maths;
  - each finding and its thresholds;
  - AVIF unsupported (`blob.type` is png) → `null`;
  - a per-image fetch failure.
- **`test/carbon.test.mjs`.** Use a mocked fetch. Cover:
  - a worked example of 1 MB first-party green plus 1 MB third-party not green, with expected grams computed in the test from the constants;
  - the rating boundaries (0.040, 0.0401, 0.359, 0.360);
  - unknown green status;
  - IP hosts;
  - findings and summary;
  - the per-year arithmetic in the glance.
- **`test/international.test.mjs`.** Use fake views, CSS counts and meta. Cover:
  - each finding at its boundary;
  - the language-tag regex;
  - hreflang problems;
  - skipping when there are no inputs.
- **`test/score.test.mjs`.** Update for the new weights. Add sustainability blending.
- **`test/views.test.mjs`.** Cover the view list order and the new default settings.
- **`test/report.test.mjs`.** Cover:
  - seven area panes and sidebar links;
  - the International screens section and its chips;
  - old readings without the new views.
- **End-to-end test site additions:**
  - `/img/big.jpg`: a 2400×1600 JPEG shown at 300 px wide, without width or height attributes. Generate it once with a script in `scripts/` and commit the file.
  - A `<div style="width:120px;overflow:hidden;white-space:nowrap">Free shipping on orders over fifty</div>` that clips under Long text.
  - `.promo { margin-left: 2rem }` in app.css.
  - `<p>مرحبا بالعالم — شحن مجاني</p>` without `dir`.
  - A `/__mock/greencheck/` route that answers `{ green: true, hosted_by: 'Test Host' }` for `127.0.0.1`.
  - The carbon plugin gets an `endpoint` option, default `https://api.thegreenwebfoundation.org/api/v3/greencheck/`, so the test can point it at the mock route.
- **End-to-end assertions:**
  - `images` is ok, with an oversized finding naming `big.jpg`;
  - `carbon` is ok, has a grams value, and its rating is one of A+ to F;
  - `international` is ok, with findings for cut-off text and RTL text without `dir` (the physical-CSS finding is covered by unit tests only);
  - all eight views are present;
  - the screens section shows "International".

## Out of scope

- Fetching the alternate pages to check that hreflang links point back (reciprocity).
- Detecting text baked into images.
- Detecting concatenated or untranslatable strings.
- Per-region grid intensity, or caching ratios for returning visitors.
- Re-encoding images in the CLI.
