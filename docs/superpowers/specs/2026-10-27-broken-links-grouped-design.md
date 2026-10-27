# Broken links and assets, grouped, with where each comes from — design

Date: 2026-10-27. Status: draft for approval.

## Why

Today Link check emits one Content finding per broken link, up to 10 plus an "…and N more" line. Wikipedia's red links fill the Content list this way. The findings say what is broken but not where it is used, so the person fixing the site still has to hunt for each one.

The user wants:
- broken items grouped into **on this page**, **internal** (other pages or assets on the site) and **external**;
- pages and assets reported together inside each group, each labelled with its kind;
- every broken item showing **where it comes from**, so it can be corrected. In the user's words: "you want to know where the asset broken link comes from, that is the point, so they can be corrected."

The user confirmed this playback:
- three groups;
- kinds labelled;
- sources listed per item;
- one URL used in several places listed once, with every place.

The two guesses in the playback were not objected to: one finding per group, and broken assets moving out of Network. Choices below that the user did not make are marked **(my call)**.

**Goal:** someone reading the Link check panel can go straight from each broken item to the file and line (or the place on the page) that needs changing.

**Non-goals:**
- Checking assets by fetching them again. Assets come from the recording, which already holds their status.
- Following links to check other pages' links (no crawl).
- Changing the Accessibility checks for missing in-page anchors (a11y-basics).

**Anti-goals:**
- The same broken URL reported in two places, or in two areas' findings.
- A source that points to the wrong place. If the source isn't known, say so plainly; don't guess.
- Losing today's skipped, refused, timed-out, redirect and over-the-limit reporting.

## A. What counts as broken, and the three groups

**On this page.** These are `#fragment` links to the page's own URL whose id does not exist. Content already finds them (`data.links.missing`).

**Internal and external.** These are split by `siteOf` against the page's site, the same rule Content uses for links today.
- **Pages:** `<a href>` targets that Link check requests, with status ≥ 400, excluding 401, 403 and 429 (those stay "refused", as today).
- **Assets:** recorded HAR entries whose resource type is image, script, stylesheet, font, media or frame, with HTTP status ≥ 400 **(my call)**.
  - Not XHR, fetch, beacon, ping, websocket or the main document; Network keeps those.
  - Requests that failed with no status (DNS, blocked by an ad blocker) stay in Network's "requests failed" finding. Ad blockers make those noisy.
  - A recorded 401 or 403 on an asset counts as broken: the browser asked for it as a real visitor would.

**Kind label**, one of: page, image, script, stylesheet, font, media, frame.

**A link whose URL is also a recorded asset** takes the asset's kind, and its sources are merged (my call). The **recorded status wins**: the browser fetched the asset as a real visitor, with cookies, while Link check fetched it without. So:
- a recorded broken asset is listed even if Link check skipped that URL or saw it succeed;
- a URL that Link check saw broken but the browser loaded fine is not listed.

**Internal vs external** uses `siteOf` against the page's final URL, exactly as for links (my call). An asset on a CDN under another registrable domain is external. Its item shows the host, so the reader can see where it lives.

The on-this-page group holds only fragment links to the page's own URL. It doesn't overlap the internal group.

## B. Where each item comes from

Each broken URL appears once, with a list of **sources**. One source is one place that uses it. This applies to every group, including on this page.

**Links (`<a href>`).** For each source:
- the link text (or aria-label), trimmed to 80 characters;
- the page region: the nearest of `header`, `nav`, `main`, `aside`, `footer` or `form`, or their ARIA roles, else "body";
- a short CSS selector;
- the **line in the page's HTML source**, when the recording holds the HTML. Find it by looking for the link's `href` attribute value as written, including relative forms, in `content.text` of the main document entry.
  - The recorder keeps text bodies by default (`bodies: 'text'`, up to 1 MB each). Read them with har-util's body-text helper, which decodes base64.
  - There are three outcomes, kept distinct:
    - found: give the line;
    - the body is in the recording but the href is not in it: "added by a script";
    - no body was recorded: "source not in the recording" (my call).

Content's page-phase `collect` gathers the text, region and selector for each anchor read. The line is found in `run` from the HAR. That keeps `collect` self-contained, since it is serialised. The same href in several anchors gives several sources.

**Assets.** For each source, use the entry's recorded `_initiator`:
- `url` is the file that asked for it: the page, a stylesheet or a script. Show its path, or "this page" when it is the page.
- `lineNumber` is 0-based from CDP; show it +1.
- If there is no line, but the initiator's body is in the recording, find the line where the asset's URL (or its path or file name) appears in that text.
- If there is no initiator at all, the source is "unknown", stated plainly.
- Report the direct initiator as recorded, without walking the chain back (my call).
  - A script initiator reads "loaded by /js/gallery.js line 40", even when the script is minified.
  - A stylesheet initiator reads "/css/site.css line 212", which also covers fonts and `@import`.

The same broken asset requested from several places gives several sources. Merge by URL across entries.

**Order and cap (my call):**
- Items are sorted by number of places (most first), then by status, then by URL.
- Sources are kept in the order they were found.
- At most 20 sources per item, then "and N more places".

## C. Findings

There is one Content finding per non-empty group, all **medium** (my call: today every broken link is medium). The title counts first:
- `3 broken links on this page` (anchors);
- `7 broken internal links and assets (5 pages, 2 images)`;
- `4 broken external links and assets (4 pages)`.

Each finding also has:
- **Detail:** the first three items, each as `404 /path — image, used in /css/site.css line 212` and, with more places, `…and in 2 more places`.
- **Evidence:** the item URLs, up to 10.
- **Extent fields** (`count`, `unit` such as `'broken links and assets'`). Content is not an extent area, so these are stored but not scored.

The per-link `Broken link: …` findings and the `…and N more broken links` finding go. Today's other Link check findings are unchanged: redirects, insecure redirects, refused, timed out, time budget, rate limited, over the limit, and Open Graph image.

**Content's own `links to missing in-page anchors` finding** moves to Link check's "on this page" group, keeping today's rule: it is emitted only when a11y-basics did not run, because a11y-basics reports the same thing under Accessibility. When a11y-basics did run, the panel still lists the group, but no Content finding is made. Link check supersedes Content's finding (see the hand-over below).

**Network's broken assets** move to Link check through the same hand-over, so they are reported in one place. Network's panel table still lists every error. This changes Network's area score on pages with broken assets. That is intended: the problem moves to Content instead of being counted twice.

**How the hand-over works (my call).**

Content and Network run before Link check: Content in the page phase, Network in analyze, Link check in enrich. They can't know whether Link check will succeed. So:
- **Content** keeps emitting its missing-anchors finding exactly as today.
- **Network** splits its error finding in two:
  - `N asset requests returned HTTP errors`, for the A asset types;
  - `N other requests returned HTTP errors`.
- **Link check's result** carries `supersedes: [findingId, …]`, naming the Content and Network findings its groups now cover.
- **A pure helper in core** (for example `activeFindings(results)`) drops a superseded finding only when the plugin that supersedes it has status `ok`. Both `score.js` and the report use it, so scores and lists always agree.

What this means:
- If Link check is off, skipped, failed or timed out, the old findings stay and count.
- Saved readings keep their stored results, so they re-score the same way on reload.
- Older readings have no `supersedes` field and are unchanged.
- Document the `supersedes` field in `docs/PLUGINS.md`.

## D. The Link check panel

At the top is a **Broken** section, with three sub-sections in the order on this page, internal, external. Each one is hidden when empty.

Each item is a row: status · kind · URL (as a link) · number of places. The row expands, using `<details>`, to its sources:

```
404  image  /img/hero-old.jpg        2 places
   ├ /css/site.css line 212
   └ this page line 88 · main › section.hero > img
404  page   /about/team              3 places
   ├ “Our team” · nav · line 41
   ├ “Meet the team” · main · line 230
   └ “Team” · footer · added by a script
```

Below that is today's full checked-links table, unchanged. The standalone export and print use the same markup, with the sources shown expanded when printing.

## E. Data

`links` result `data` gains a `broken` object:

```js
broken: {
  page:     [item],
  internal: [item],
  external: [item],
}
// item = { url, status, kind, sources: [source], moreSources: n }
// source = { file?, line?, text?, region?, selector?, script?: true, unknown?: true }
```

Content's `linkTargets` gains a per-target `sources` list, capped like the targets. Older readings without it show items with no link sources; asset sources still work from the HAR.

## Acceptance

- **Unit tests:**
  - Grouping: anchor, internal and external pages and assets; `siteOf` subdomains count as internal.
  - Kinds, and a link whose URL is also an asset, which merges.
  - Sources from the initiator line (+1), a line found in CSS text, "added by a script", and unknown.
  - The same URL from 3 places gives one item with 3 sources; the 20-source cap.
  - Titles and details as in C.
  - 401, 403 and 429 links are still refused, not broken.
  - Link check's anchor finding is emitted only without a11y-basics.
  - Network splits asset and other errors.
  - `activeFindings` drops a superseded finding only when the superseding plugin is `ok`; it keeps it when Link check is skipped, errored or absent.
  - The score and the report agree.
  - A reading without `supersedes` scores exactly as before.
- **e2e:** the fixture page gets a broken internal image referenced from a stylesheet, a broken internal link used twice, and a missing anchor. Assert the panel shows each item with its sources and lines.
- **`npm test` and `npm run test:e2e` pass.** Never run e2e and calibration at the same time.
- **Calibration:** re-run `node scripts/calibrate.mjs`. Record each site's Content and Network scores before and after in the calibration memory. Check Wikipedia's red links come out as one grouped internal finding with sources.

## Left to the builder

- The selector's shape (short, stable, at most about 4 steps).
- How relative href forms are matched in the HTML source.
- Exact markup and CSS for the expandable rows, within the report's existing style.
- The name and location of the `activeFindings` helper, and how finding ids are matched.
