# Calibration round 2: design

## Why

Round 2 took readings of 13 new sites:

| Site | Type |
|---|---|
| usa.gov | US government |
| ikea.com | Commerce |
| stripe.com | SaaS |
| github.com/microsoft/vscode | App-like page |
| ynet.co.il | Hebrew, right-to-left |
| habr.com | Russian |
| naver.com | Korean |
| asahi.com | Japanese |
| smashingmagazine.com | Blog article |
| docs.python.org | Documentation |
| spiegel.de | German news |

Each suspicious finding was checked against its stored reading, a live probe, or curl. Five checks produced false findings, and one is true but reports no culprit.

The user also set two directions:

- **"An F is an F."** The carbon rating stays as computed, with no softer default. Any grading curve would be an explicit, tuneable setting, and it is not part of this batch.
- **"All links need to be checked if possible."** The link checker must not skip links by default, must not misreport working links, and must say clearly which links it could not verify.

**Success:** a re-run of all 23 calibration sites shows none of the false findings below. The true findings are unchanged, and the link checker covers every link it can reach.

## Scope

| # | Problem (evidence) | Fix |
|---|---|---|
| 1 | Working links reported broken. GitHub returns 400 unless the request accepts HTML. asahi.com returns 503 to HEAD and 200 to GET. | Send a browser-like `Accept`; retry GET on any HEAD result ≥ 400 |
| 2 | Links skipped: same-site only by default, a 150-link cap, and links not reached within the time budget are only listed in the table | Check every link by default, with per-host limits; report what wasn't verified |
| 3 | Elements hidden by an ancestor count as visible. Spiegel's 18 "buttons without a name" are carousel arrows inside a `display:none` wrapper. | Visibility checks the rendered state, ancestors included |
| 4 | SVG logo names missed. Stripe's 30 "links without a name" contain `<svg role="img" aria-label="OpenAI">`. | Accessible-name computation includes labelled descendants |
| 5 | "robots.txt blocks all crawlers" fires when the page itself is allowed. Naver has `Disallow: /` plus `Allow: /$`. | Reword and downgrade when the page is allowed |
| 6 | Scroll-only overflow is reported as a medium failure. ynet's text-spacing view says "0 more clipped; 81 px overflow", and its pseudo-localisation view flags a 2 px overflow. | Split clipping (medium) from sideways scrolling (low); set a minimum overflow |
| 7 | Right-to-left overflow names no culprit. usa.gov reports 17,984 px, IKEA 9,999 px, Smashing Magazine 999 px. | Find leftward culprits in right-to-left mode; name them; suggest logical properties |
| 8 | The runner timed out on ynet, habr and asahi waiting for `load` | Commit the runner's switch to `domcontentloaded` (already in the working tree) |

**Out of scope:**
- Carbon grading.
- Exempting script-handled anchors (GitHub's `#readme-ov-file` tabs stay reported).
- Readability for Hebrew.
- Thin-content detection on homepages.

## Design

### 1. Browser-like link requests (`extension/plugins/links.js`, `check`)

- Every request sends `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`. The existing `credentials: 'omit'` and `redirect: 'follow'` stay.
- HEAD first, as today. If HEAD gives a **status of 400 or above** (not only 405 or 501), or a non-timeout network error, retry with GET, cancel the body, and report the GET result.
- A timed-out or aborted HEAD is still not retried.
- The result records `method: 'HEAD' | 'GET'` so the table can show which request decided it.

### 2. Check every link, and say what wasn't verified (`links.js` `run`, options)

- **External links on by default.** The `external` option defaults to `true`; the label stays "Also check external links".
- **No count cap by default.** The `max` option defaults to `0`, meaning unlimited. A positive value still caps the list. `(Number(ctx.options.max) || 150)` becomes "`> 0` ? cap : all".
- **Per-host limits.** A shared queue with `CONCURRENCY = 12` overall and at most `PER_HOST = 4` requests in flight to the same host. A worker skips over URLs whose host is at its limit and takes the next eligible one, so one slow host doesn't stall the others.
- **The budget stays.** `BUDGET_MS = 150_000` and the plugin's 180 s timeout are unchanged. Links not started before the deadline are `skipped: 'time budget'`, as today.
- **Nothing disappears silently.** The existing `refused` (401/403/429) and `failed` (status 0) info findings stay. A new info finding reports links not reached:
  `${n} links not checked (time budget)`. Its detail lists the first 10 URLs and says: "Raise the time budget or check again; they were not tested."
- **The link limit.** "Check every link" means up to 5000 targets per list (internal, external): Content caps each `linkTargets` list at 5000 and records the true counts of unique http(s) targets as `linkTargets.totals = { internal, external }`. When the number of links found exceeds the number queued, because of that cap or a positive `max`, an info finding reports the rest: `${n} links not checked (over the ${limit} link limit)`, where `limit` is `max` when it applies and 5000 otherwise. Unchecked links are reported, never hidden.
- **Private-network links are not contacted.** A link whose host is loopback (`localhost`, `127.0.0.0/8`, `::1`), RFC 1918 (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254/16`, `fe80::/10`), or ends in `.local` or `.internal` is `skipped: 'private network'` and still counts in `M`. When the page's own host is private, such links are checked.
- **Summary row.** The `Link check` value becomes `${ran.length} of ${total} checked · ${broken.length} broken · ${redirects…} redirects`, where `total` is the number of http(s) links found, from `linkTargets.totals` when present (older readings fall back to the list lengths). Links skipped for not being http(s), or for looking destructive, still count as skipped with their reason.
- **Disclosure text** (shown before the plugin contacts anything) becomes: "Requests every link on the page, on this site and elsewhere (HEAD, then GET if HEAD fails; no cookies), and the page's Open Graph image."

### 3. Visibility includes ancestors (`extension/plugins/a11y-basics.js` `visible`)

Today `visible(el)` checks only the element's own `display` and `visibility`, plus `[hidden]` and `[aria-hidden]` ancestors. The new version is:

```js
const visible = (el) => {
  if (el.closest('[hidden],[aria-hidden="true"]')) return false;
  if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true });
  const cs = getComputedStyle(el);
  return el.getClientRects().length > 0 && cs.visibility !== 'hidden';
};
```

`checkVisibility` returns false when the element or any ancestor is `display: none`, or (with `visibilityProperty`) `visibility: hidden`. Every rule in `a11y-basics` that uses `visible` benefits: buttons, links, labels, images, frames. Rules that report **hidden** problems (`focusable-hidden`) keep their own logic.

### 4. Names from labelled descendants (`a11y-basics.js` `name`)

The descendant step `[...el.querySelectorAll('img[alt], svg title')]` becomes:

```js
[...el.querySelectorAll('img[alt], svg title, [role="img"][aria-label], svg[aria-label], [aria-labelledby]')]
  .map((i) => i.getAttribute('alt') ?? i.getAttribute('aria-label') ??
    (i.hasAttribute('aria-labelledby') ? byIds(i.getAttribute('aria-labelledby')).map(text).join(' ') : i.textContent))
  .join(' ').trim()
```

Descendants inside `[aria-hidden="true"]` don't contribute: filter with `!i.closest('[aria-hidden="true"]')`, unless that `aria-hidden` is the link or button itself, in which case it is already excluded by `visible`.

### 5. robots.txt: the page can still be allowed (`extension/plugins/well-known.js`)

When `robots.everyone === 'blocked'`, compute the generic verdict for this page from the parsed file: `robotsAllowed(groupFor(file.groups, '*'), path)`. Named crawlers such as Googlebot do not stand in for `*`: a file that allows Googlebot but disallows `*` still blocks all other crawlers.

- **If the generic verdict is allowed:** the page is allowed by a more specific rule, such as `Allow: /$`. Replace the medium finding with a **low** one: `robots.txt blocks crawlers from most of the site (Disallow: /), but allows this page`, with the detail naming the allowing rule.
- **Otherwise:** keep the medium `robots.txt blocks all crawlers (Disallow: /)`.

The `siteBlocked` suppression of per-crawler findings, which follows on the next line, uses the same generic verdict: it suppresses only when the page is blocked for `*`.

### 6. Text spacing and pseudo-localisation: clipping vs scrolling

This mirrors the 200% text split from round 1, using the view's `scrollsX`. `undefined` on older readings means "may scroll".

**Text spacing** (`extension/plugins/a11y-views.js`):

| Case | Severity | Finding | Detail |
|---|---|---|---|
| Clipping: `extraClipped(spacing) >= A11Y_CLIP_EXTRA` | medium | `Text clips with WCAG text spacing (1.4.12)` | `${extra} more clipped text boxes.` |
| Scrolling only: no clipping, `newOverflow(spacing)`, `spacing.scrollsX !== false`, and `overflowX - base.overflowX >= 8` | low | `Page scrolls sideways with WCAG text spacing` | `Content is ${overflow} px wider than the viewport.` |

The summary rating is `poor` for clipping and `needs-improvement` for scrolling. `checks.spacing.ok` is `!clips`.

**Pseudo-localisation** (`extension/plugins/international.js`): "Longer text makes the page scroll sideways" requires `pseudo.scrollsX !== false` and an overflow of at least **8 px** beyond the base view. It stays medium, because translated text that forces sideways scrolling is a real localisation bug. The 8 px floor removes sub-pixel and scrollbar noise such as ynet's 2 px.

**Shared constant:** `A11Y_MIN_OVERFLOW = 8` in `extension/core/views.js`, used by both.

### 7. Right-to-left culprits (`extension/browser/capture.js` `measureView`, `international.js`)

**Culprits on the left.** In `measureView`'s overflow walk, an element is a candidate when it sticks out on either side:
- `r.right > innerWidth + 1`, as today, or
- **in a right-to-left document**, `r.left < -1`.

For leftward culprits, `over` is `Math.round(-r.left)`. The existing clipped-ancestor and `position: fixed` exclusions apply to both sides: an ancestor clips when `overflowX` isn't `visible` and its box lies inside the viewport. The direction comes from `getComputedStyle(document.documentElement).direction === 'rtl'`. The `rtl` view sets `dir="rtl"`, so this applies there and on real right-to-left pages.

**Each culprit records `side: 'right' | 'left'` and `offscreen`.** `offscreen` is true when the element is fully outside the viewport, so `r.right <= 0` or `r.left >= innerWidth`. That is typically a skip link or `sr-only` helper positioned with `left: -9999px`.

**International finding.** "Right-to-left layout scrolls sideways" keeps medium. Its detail now names the first culprit:
- **An offscreen culprit:** `${selector} sits ${over} px off-screen (positioned with left/right). In a right-to-left page it pushes the layout sideways — position it with inset-inline-start instead.`
- **Otherwise:** `${selector} is ${width} px wide …`, as reflow does.
- **No culprit found:** keep the current wording.

**Floor.** The finding needs `rtl.scrollsX !== false` and an overflow of at least `A11Y_MIN_OVERFLOW`.

### 8. Calibration runner

Commit `scripts/calibrate.mjs`'s `page.goto(url, { waitUntil: 'domcontentloaded', … })`, which is already in the working tree, with its one-line comment. Add the round-2 sites to a second list, `SITES_2`, and an argument `--round 2` that selects it. `--all` runs both lists.

## Testing

**Unit tests** (`node --test`):

- **links.js**, against a `fetch` mock:
  - HEAD returns 400 and GET returns 200, so the link counts as ok with `method: 'GET'`;
  - HEAD returns 503 and GET returns 200, so the link counts as ok;
  - HEAD returns 404 and GET returns 404, so the link counts as broken;
  - a HEAD timeout is not retried;
  - every request carries the `Accept` header;
  - `external` defaults to true and `max` defaults to unlimited, so 200 links are all queued;
  - per-host concurrency never exceeds 4 for one host while another host's links proceed (use a mock that records concurrent in-flight requests per host);
  - links skipped for the time budget produce the info finding, and the summary row shows `N of M checked`.
- **well-known**: `Disallow: /` with `Allow: /$` on the homepage gives the low "allows this page" finding and no medium one; `Disallow: /` alone gives the medium one.
- **a11y-views**: text spacing with `scrollsX: true` and 81 px of new overflow and no clipping gives the low finding with `checks.spacing.ok` true; clipping gives the medium finding; 5 px of overflow gives nothing; `scrollsX: false` gives nothing.
- **international**: pseudo-localisation at 2 px gives nothing and at 40 px with `scrollsX` gives medium; right-to-left with an offscreen culprit gives the "inset-inline-start" detail; right-to-left below the floor gives nothing.

**E2E fixture** (`test/e2e/site`):

- a `<button>` inside a `display:none` wrapper → not counted in "Buttons without an accessible name";
- a link containing only `<svg role="img" aria-label="Partner">` → not counted in "Links without an accessible name";
- an offscreen skip link at `left: -9999px` → the right-to-left finding names it with the inset-inline-start detail;
- a local route that returns 400 to HEAD and 200 to GET (in `test/e2e/server.mjs`) → not reported broken.

**Calibration:** run `node scripts/calibrate.mjs --all` and compare with the round-1 and round-2 digests.

Expected:
- no broken links on GitHub `/marketplace` or `/projects`, or on asahi.com's 503 URLs;
- Spiegel's hidden-button count and Stripe's logo-link count are gone;
- naver.com's robots.txt finding is low;
- ynet's text-spacing finding is low or absent, and its 2 px pseudo-localisation finding is gone;
- the right-to-left findings on usa.gov, IKEA and Smashing Magazine name their culprits;
- link coverage: ynet checks its external links too, and every site's `Link check` row shows `checked of total`.

All other findings are unchanged, apart from timing-dependent values.
