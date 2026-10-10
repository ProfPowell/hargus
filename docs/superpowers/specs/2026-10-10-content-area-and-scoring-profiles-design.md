# Content area, scoring profiles and honest scores: design

**Status:** approved in conversation on 2026-10-10. This spec is waiting for review.

## Goal

Today a single area, "Build & content", mixes how a page is constructed with what it says. This change splits it into two areas:

- **Build:** HTML, CSS and JS construction.
- **Content:** content quality, readability, metadata, information architecture and linking structure.

At the same time, the overall score must reflect what matters for a given kind of site, and it must not hide a failing area. Two problems show this today:

- ucsd.edu is in the bottom 2% of pages by carbon weight, yet it scored a "high F" for sustainability.
- Weak accessibility and international scores barely moved the overall grade.

The work has two parts. They ship in one branch, and Part 1 is built first.

1. **Scoring:** split the area, add weight profiles, add critical areas, and make low scores count fully.
2. **Content:** add a new `content` plugin (page phase) and a new `links` plugin (link check, enrich phase), move the `meta` plugin to Content, and fill in four metadata checks.

## Part 1: Scoring

### Areas

`AREAS` in `extension/core/score.js` goes from seven areas to eight.

| id | label |
|---|---|
| performance | Performance |
| accessibility | Accessibility |
| security | Security |
| content | Content |
| build | Build |
| infrastructure | Infrastructure |
| international | International |
| sustainability | Sustainability |

- The `build` label becomes "Build".
- `CATEGORY_AREA` changes `seo: 'content'` and adds `content: 'content'`. The `quality` category stays mapped to `build`.
- The `meta` plugin's `area` becomes `'content'`. Its findings route by category:

  | Category | Findings | Area |
  |---|---|---|
  | seo | title, description, canonical, noindex, h1, Open Graph, JSON-LD | content |
  | quality | viewport, favicon, quirks mode, charset | build |
  | performance | unsized images | performance |
  | security | form-over-HTTP findings | security |

- Old readings are re-routed the same way when they are viewed, because area routing happens at score time.

### Weight profiles

A profile defines a weight for each area and a set of critical areas. Profiles live in `score.js` as `PROFILES`. Critical areas are marked ✱.

| id | label | Perf | A11y | Security | Content | Build | Infra | Intl | Sustain |
|---|---|---|---|---|---|---|---|---|---|
| general | General | 18 | 18 | 18 | 12 | 10 | 9 | 8 | 7 |
| content | Brochure / content site | 18 | 20 | 8 | 22✱ | 10 | 6 | 8 | 8 |
| commerce | Commerce | 22✱ | 16 | 22✱ | 12 | 8 | 8 | 7 | 5 |
| webapp | Web app | 20 | 18 | 22✱ | 6 | 16 | 8 | 6 | 4 |
| public | Public sector / education | 14 | 24✱ | 10 | 14 | 6 | 6 | 14✱ | 12 |
| custom | Custom | user numbers | | | | | | | |

- `general` is the default. It has no critical areas.
- A custom profile stores `{ weights: { [area]: number ≥ 0 }, critical: [areaIds] }`. Missing weights fall back to the `general` weights.
- Weights need not sum to 100. The overall score is already normalized by the total weight of the measured areas.
- `scoreReading(reading, plugins, { profile })` takes a profile id or a custom profile object, and defaults to `general`. It returns `overall.profile = { id, label }`.
- `topFindings` sorts its tie-breaks by the active profile's weights.

**Settings:** `DEFAULTS.scoring = { profile: 'general', custom: { weights: {…general}, critical: [] } }` in `extension/browser/settings.js`.

**Options page:**
- A "Scoring" section with a profile picker that shows each preset's weights and critical areas, read-only.
- Custom shows one number input and one "critical" checkbox per area.

### Critical cap

- When a critical area that was measured has a score below 60 (an F), the overall score is reduced to `min(score, 69)`, which is a D at most.
- `overall.capped = { areas: [ids], from: originalScore }` records the cap, and is `null` when there is no cap.
- The report header shows: "Capped at D: Accessibility is failing (critical for Public sector)." If several critical areas fail, they are joined with "and".
- `summarize()` adds the cap sentence first when a cap applies.

### Honest low scores

**Carbon on a continuous scale.**
- `CARBON_SCORE` (letter → points) is replaced by `carbonScore(grams)`.
- The score is piecewise-linear in log(grams), through these anchors:

  | g per visit | score |
  |---|---|
  | 0.040 | 100 |
  | 0.079 | 90 |
  | 0.145 | 80 |
  | 0.209 | 70 |
  | 0.278 | 60 |
  | 0.359 | 50 |
  | 1.795 | 0 |

- Values at or below 0.040 g score 100, and values at or above 1.795 g score 0.
- The metric input reads `results.carbon.data.grams`. Its label is "Carbon per visit".
- Readings without `grams` fall back to the letter rating's upper anchor; for example, F is 50.

**Worse input dominates.**
- When an area has both a findings score and a metric, the area score is `round((2 × min + max) / 3)`. Today it is the plain mean.
- With a single input, the area score is that input, as today.

**Index and library.**
- `indexRecord` stores the overall score and `profile` id at save time.
- When the profile setting changes, the options page re-scores every index record in the background and shows "Re-scoring N readings…". It loads each reading, scores it, and puts the new index record.

**Report and export.**
- The report header and the standalone HTML export show "Scored as <label>".
- `renderReport` takes the profile from `settings.scoring` and passes it to `scoreReading`.

**CLI.**
- `harplus` gains `--profile <id>`, which accepts any preset id. It defaults to `general`.
- The JSON output includes `overall.profile` and `overall.capped`.

**Docs:** `docs/PLUGINS.md` gets an updated scoring-formula section covering profiles, the cap, the carbon curve and the ⅔/⅓ blend.

## Part 2: Content

### `content` plugin (new, page phase)

- `extension/plugins/content.js`: `group: 'quality'`, `area: 'content'`, `phase: 'page'`, world `isolated`.
- Its `collect()` reads the live page. `run()` turns the collected data into findings, glance and render.
- It runs `after: ['meta']`, so it can use meta's data instead of collecting it again. For example, it uses the title and JSON-LD for the title/h1 check and breadcrumb detection.
- All findings use `category: 'content'`.

**Main text.**
- The source is the first of: `<main>`, the `[role=main]` element, the single `<article>`, or `<body>` without `nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo], script, style, noscript, template`.
- It takes the visible text (`innerText`).
- Paragraphs are `p, li, dd, blockquote` elements inside that source, keeping only those with at least 20 characters of text.

#### Reading

| Measure | Rule |
|---|---|
| Words | Count tokens split on whitespace. For text in Han, Hiragana, Katakana or Hangul, count characters ÷ 2 as words. |
| Reading time | words ÷ 230, rounded up to minutes (minimum 1). |
| Sentences | Split on `.`, `!`, `?`, `。`, `！` and `？` when followed by whitespace or the end of the text. Report the average sentence length and the share of sentences over 25 words. Finding: share > 30% → low, "Many long sentences (N% over 25 words)". |
| Paragraphs | Report the count and average words. Finding: paragraphs over 150 words → low, "N wall-of-text paragraphs", with the first 3 shown as 80-character excerpts. |
| Thin content | Under 250 words → info, "Thin content (N words)". |
| Readability (English only) | Applies when `document.documentElement.lang` starts with `en`; when `lang` is empty, it applies if the text is mostly ASCII letters. Syllables use a vowel-group heuristic with silent-e and `-le` handling. Flesch reading ease = 206.835 − 1.015 × (words/sentence) − 84.6 × (syllables/word). Flesch–Kincaid grade = 0.39 × (words/sentence) + 11.8 × (syllables/word) − 15.59. Findings: ease < 30 → medium, ease < 50 → low, "Hard to read (Flesch N, grade G)". Otherwise the result is "not applicable: page language is X". |
| Text vs markup | Divide the visible text byte length (UTF-8) of the whole `body` by the HTML document's byte size from the recording; `run()` reads the main document entry's content size. Finding: < 10% → low, "Mostly markup (N% text)". |

#### Structure and information architecture

| Measure | Rule |
|---|---|
| Heading outline | The list of `{level, text}` for `h1–h6` in document order, shown as an indented tree. |
| Skipped heading levels | A heading more than one level deeper than the one before it → low, listed. |
| Empty headings | → medium, listed. |
| Long headings | Over 120 characters → info. |
| Title vs h1 | Info when the title equals the first h1's text. Also info when the title is only the site name, meaning it equals `og:site_name` or holds no words other than the host's brand label. |
| Navigation | For each `nav` / `[role=navigation]`: link count and the deepest nesting of `ul` / `ol` inside it. Finding: total nav links > 60 → low, "Menu overload (N links in navigation)". |
| Breadcrumbs | Present when a `nav` has an aria-label or class matching `/breadcrumb/i`, or when JSON-LD contains `BreadcrumbList`. Finding: absent when the URL path depth ≥ 2 → info. |
| URL shape | Path depth, length, uppercase letters, underscores, and session-like parameters (`sid`, `sessionid`, `jsessionid`, `phpsessid`, case-insensitive). Finding: depth > 4, length > 100, or any of the others → info, listing which ones. |

#### Links on the page

The plugin collects every `a[href]` and resolves it to an absolute URL. Each link gets one kind:

| Kind | Rule |
|---|---|
| internal | same registrable host, ignoring `www.` |
| external | any other host |
| mailto | `mailto:` URL |
| tel | `tel:` URL |
| fragment | same page with a `#…` part |
| other | anything else |

| Measure | Rule |
|---|---|
| Counts | Count each kind and the distinct destinations, plus links per 1,000 main-text words. Finding: > 100 per 1,000 words when there are 200 or more words → low. |
| Vague link text | Trimmed, lowercased text (falling back to `aria-label`) that is exactly one of: "click here", "here", "read more", "learn more", "more", "click", "this", "link", "details", "continue". Any match → low, "N links with vague text", listing up to 10 with their href. |
| Same text, different places | The same non-empty link text pointing to 2 or more distinct destinations, ignoring fragments → low, listed. |
| Broken in-page anchors | A fragment link whose id/name is missing from the document, ignoring `#` and `#top` → medium, listed. |

The plugin's data includes the deduplicated list of internal and external URLs for the `links` plugin, with fragments removed. It holds up to 500 entries, in document order.

### `links` plugin (new, enrich phase)

- `extension/plugins/links.js`: `group: 'quality'`, `area: 'content'`, `phase: 'enrich'`, `after: ['content']`.
- Disclosure: "Requests each linked URL on this site (HEAD, no cookies). External links only when enabled."
- Options:

  | Key | Label | Type | Default |
  |---|---|---|---|
  | `external` | Also check external links | checkbox | false |
  | `max` | Most links to check | number | 150 |

- `timeoutMs`: 180 000.

**Targets.**
- The targets are the `content` plugin's internal URLs, plus its external URLs when `external` is on.
- The page's own `og:image`, read from meta's data, is added for the Open Graph image check below.
- Targets are capped at `max`, in document order.
- Skipped, with the reason recorded:
  - non-http(s) URLs;
  - URLs whose path or query matches `/log-?out|sign-?out|logoff|delete|remove|unsubscribe/i`.

**Requests.**
- Up to 6 requests run at a time, with a 10 s timeout each, using `credentials: 'omit'` and `redirect: 'follow'`.
- Each URL gets a `HEAD` request first. If it returns 405 or 501, or the network fails on HEAD, it is retried once with `GET`; that body is cancelled after the headers arrive.
- Each result records `{ url, status, finalUrl, redirected, ms, error?, skipped? }`. The redirect comes from `response.redirected` and the final URL from `response.url`.

**Progress.**
- The plugin host gains `ctx.progress(text)`. It calls `env.onProgress({ plugin, name, status: 'running', text })`.
- The reading tab's checklist shows that text on the running plugin's row, for example "Checking links 42/120".
- `progress-view.js` renders a row's `text` when it is present.

**Findings.**

| Condition | Severity | Title |
|---|---|---|
| status ≥ 400 | medium | "Broken link: <status> <path>" |
| redirect from https to http | medium | "Link redirects to insecure HTTP" |
| other redirects | low, grouped into one finding | "N links redirect — update them to their final URL", listing up to 10 |
| timeouts and network errors | info, grouped | "N links timed out or failed to load", listing up to 10 |
| 401, 403, 429 | info, grouped | "N links refused the check (401, 403 or 429)" (decided during implementation: cookieless requests and rate limits make these false positives). |

- Broken links get one finding per URL for the first 10, then one more finding: "…and N more broken links".
- In the extension, CORS doesn't apply under `<all_urls>`. In the CLI, Node's `fetch` has no CORS.

**Glance:** "N checked · B broken · R redirects".

**Render:** a table of status, URL, final URL and ms, sorted broken, then redirected, then ok, then skipped.

### Metadata additions (`meta` plugin)

| Check | Rule |
|---|---|
| Description quality | When the description equals the title (case- and whitespace-insensitive), or is 1–49 characters → low, "Meta description is too short or repeats the title". |
| Twitter card | A missing `twitter:card` → low, "No Twitter card tag" (category `seo`). |
| Structured data types | Collect every `@type`, including inside `@graph`, and show it in the meta card as "Structured data: Organization, BreadcrumbList". Finding: no JSON-LD at all → info, "No structured data (JSON-LD)". |
| Open Graph image | The `links` plugin fetches `og:image` with GET and reads the image's natural size via `createImageBitmap` on the blob. In the CLI the size is unchecked and only the status is reported. Findings: fails to load → medium; smaller than 1200×630 → low, "Open Graph image is W×H (1200×630 recommended)". These findings belong to `links` with category `content`. |

### Content in the report

The Content area groups these cards:
- `meta` (metadata);
- `content`, with reading stats, structure and links on the page;
- `links`, the link check.

**Content render:**
- reading stat tiles: words, reading time, average sentence length and paragraphs;
- a readability gauge using the Flesch ease ring, when English;
- a sentence-length bar chart with buckets 1–10, 11–15, 16–20, 21–25, 26–35 and 36+ words, using the existing `h.bars` helper;
- the heading outline tree;
- a navigation summary;
- the vague-link and duplicate-text lists;
- a text-vs-markup bar.

**Content glance:** "N words · M min · Flesch F" (Flesch only when English), "I internal · E external links".

### CLI

- Both plugins run in the CLI.
- `content` needs a live page, so in the CLI it only runs when it was recorded in the reading. It is a page-phase plugin, the same as `meta`.
- `links` runs in the CLI's enrich phase using Node's `fetch`. `--no-link-check` disables it.

## Testing

**Unit tests (`node --test`):**
- `PROFILES` weights. A custom profile with missing weights falls back to `general`.
- Overall scoring with a profile.
- Critical cap: below 60 caps to 69; a non-critical F doesn't cap; an unmeasured critical area doesn't cap.
- `carbonScore` at each anchor, between anchors, and at both clamps.
- The blend `(2 × min + max) / 3`.
- `CATEGORY_AREA` routes `seo` to content.
- Content `run()` on fixed collected data:
  - word counts, including CJK;
  - sentences and paragraphs;
  - Flesch on a known passage (expected value within ±2);
  - skipped levels and empty headings;
  - vague links, same text with different destinations, broken anchors;
  - the URL shape rules.
- `links` with a stub `fetch`:
  - HEAD → GET fallback on 405;
  - a 404 finding;
  - grouped redirects;
  - an https→http redirect;
  - skipped logout URLs;
  - the `max` cap;
  - progress callbacks.
- The four meta additions.

**E2E (`npm run test:e2e`).** The mock site gets a content page with:
- a skipped heading;
- a "click here" link;
- a broken internal link (404) and a redirecting link (301);
- a missing anchor;
- an `og:image` sized 600×315.

The test asserts:
- the Content area appears with a grade;
- the `links` plugin reports 1 broken and 1 redirect;
- the reading tab's checklist showed "Checking links" text;
- switching the profile in Options to Public sector changes the overall score shown in the library after re-scoring.

## Out of scope

- Text that only appears with JavaScript. The `resilience` plugin already reports it, and it stays in Build.

- Crawling beyond the current page's links.
- Readability formulas for languages other than English.
- Critical findings that cap their own area. This was considered and not chosen.
- A per-reading profile switcher in the report.
