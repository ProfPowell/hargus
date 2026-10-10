# Content and sharing: design

**Status:** approved in conversation on 2026-10-10 as batch 4, the last batch of the Polypane gap work. This spec is waiting for review.

## Goal

1. Add stricter metadata checks, plus a "missing tags" panel with a paste-ready snippet.
2. Draw seven share and search previews from the page's tags: Google, X, Facebook, LinkedIn, Slack, Discord and Bluesky.
3. Give an indexing verdict for this page per crawler, using Google-compatible robots.txt matching, plus the `X-Robots-Tag` header.
4. Report readability in every language: Flesch for English, ARI for other alphabetic scripts, AARI for Arabic, characters per sentence for Chinese, Japanese and Korean, and the hardest sentences.
5. Report line length (characters per rendered line).

## 1. Metadata extras (`meta` plugin)

**Collect additions**, in `meta`'s page `collect()`:
- `counts`: the number of `title` elements, `meta[name=description]` and `meta[name=viewport]`;
- `dupProps`: the `og:*`/`twitter:*` property or name values that appear more than once, up to 10;
- `ogRaw`: the raw `content` attribute of `og:image`, `twitter:image` and `og:url`, unresolved;
- `themeColor` (already collected).

**New findings** (category `seo`):

| Condition | Severity | Title |
|---|---|---|
| `og:url` and the canonical are both present and differ after normalisation: lowercase host, no trailing slash, no hash, no `utm_*`, `fbclid` or `gclid` params | low | `og:url differs from the canonical URL` |
| raw `og:image` or `twitter:image` isn't absolute (`^https?://`) | low | `Share image URL is relative (og:image / twitter:image must be absolute)` |
| `counts.title > 1`, `counts.description > 1`, `counts.viewport > 1`, or `dupProps.length ≥ 1` | low | `Duplicate meta tags: <list>`, e.g. `2 viewport, og:title ×2` |
| `links.data.ogImage.bytes > 5_242_880` (5 MB) | low | `Share image is <n> MB (X limits images to 5 MB)` |

The `og:image` size finding is raised by the `links` plugin, which already fetches the image. That plugin records `bytes` from `content-length` or the blob size.

**Missing tags.** A pure function `missingTags(metaData, target)` returns:
- `[{ tag, html }]` for each recommended tag that's absent: `og:title`, `og:description`, `og:image`, `og:url`, `og:type`, `og:site_name`, `twitter:card`, `meta description` and `link canonical`;
- a combined `snippet` string.

How the snippet is filled:
- **Known values come from the page:** title → `og:title`; description → `og:description`; canonical or final URL → `og:url`/`canonical`; host → `og:site_name`; `website` → `og:type`; `summary_large_image` (if `og:image` is present, otherwise `summary`) → `twitter:card`.
- **Unknown values** become a `…` placeholder.
- **Escaping:** HTML attribute values are escaped.

The `meta` render shows a "Missing tags" sub-section with a `<pre>` holding the snippet, plus a copy button (`data-copy`) in interactive reports. It isn't a finding.

## 2. Share previews

**Image thumbnail.** When `links` fetches the `og:image` and `createImageBitmap` exists:
- it draws the image onto an `OffscreenCanvas` scaled to at most 600 px wide, keeping the aspect ratio;
- it stores `ogImage.thumb = 'data:image/webp;base64,…'`, using `convertToBlob({ type: 'image/webp', quality: 0.7 })`, plus `ogImage.width`, `ogImage.height` and `ogImage.bytes`;
- it skips the thumbnail when the image is over 10 MB (existing cap) or decoding fails;
- the CLI has no decoder, so it stores no thumbnail.

**Pure module `extension/ui/previews.js`:**
- **`previewModel(metaData, { target, ogImage })`** resolves the fields each platform uses:

  | Platform | Fields |
  |---|---|
  | Google | title (`<title>`), description (`meta description`), url, favicon |
  | X | `twitter:card`, title (`twitter:title` → `og:title` → `<title>`), description (`twitter:description` → `og:description` → description), image (`twitter:image` → `og:image`), domain |
  | Facebook, LinkedIn, Slack, Discord, Bluesky | `og:*` → title/description fallbacks, `og:site_name` → host, `og:image` |
  | Discord | also `themeColor` |

- **`renderPreviews(model, h)`** returns the HTML for 7 cards:

  | Card | Layout |
  |---|---|
  | Google | site name and breadcrumb URL; title cut at 60 characters; description cut at 155 characters |
  | X `summary_large_image` | image on top (1.91:1 crop), domain, title (70) |
  | X `summary` | 1:1 thumbnail left; title and description (125) |
  | Facebook | image (1.91:1), upper-case domain, title (88), description (110) |
  | LinkedIn | image, title (70), domain |
  | Slack | site-name line, linked title, description (150), image (small) |
  | Discord | left border in `themeColor` (validated `#hex`; otherwise the default), site name, title, description (350), image |
  | Bluesky | image, title (70), description (150), domain |

  - Truncation adds `…`.
  - With no image, the card shows a neutral "no image" block.
  - The image is the thumbnail data URL when present. Otherwise it's the absolute `og:image` URL in the interactive report only (`interactive: true`). In the standalone export it's the placeholder, so the export never loads remote content.
  - All text is escaped through `h.html`.
- **Where it shows:** the `meta` plugin gains a `glance` that renders a "Share previews" section using `ctx.results.links?.data?.ogImage`. Glances already receive `ctx.results`.
- **Styling:** CSS in `theme.css` under `.previews` and `.pv-*`. The cards approximate each platform's layout and don't copy brand assets; the platform name is shown as text.

## 3. Indexing verdict (`well-known` plugin)

**Parser.** `parseRobots(text)` is replaced by a Google-compatible version. It's still exported, with the old return fields kept:
- **Groups:** consecutive `user-agent` lines share a group. A group ends at the next `user-agent` that follows rules.
- **Rules:** `allow` and `disallow` with paths, plus `sitemap`. Recorded: unknown directives (anything except `user-agent`, `allow`, `disallow`, `sitemap`, `crawl-delay`, `host`, `noindex`), `crawl-delay`, `noindex` lines, and duplicate user-agent tokens across groups.

**Pure helpers:**
- **`groupFor(groups, ua)`:** picks the group whose agent token is the longest case-insensitive prefix match of the crawler's product token. If none matches, the `*` group. If there's no `*` group either, none, meaning allowed.
- **`allowed(group, path)`** follows Google's rules:
  - `*` matches any run of characters, and a trailing `$` anchors the end;
  - the longest matching pattern wins, with `allow` winning a tie;
  - an empty `disallow` matches nothing;
  - `path` includes the query string.

**Verdict.**
- **Crawlers:** for the page path (the final URL's pathname + search), compute crawl allowed or blocked for each of these, using the token shown:

  | Crawler | Token |
  |---|---|
  | Googlebot | `googlebot` |
  | Bingbot | `bingbot` |
  | GPTBot | `gptbot` |
  | ClaudeBot | `claudebot` |
  | Google-Extended | `google-extended` |
  | CCBot | `ccbot` |
  | PerplexityBot | `perplexitybot` |
  | Applebot-Extended | `applebot-extended` |

- **Index:** blocked if `meta.data.robots`, the `googlebot` meta, or the main document's `X-Robots-Tag` header contains `noindex`.
- **Agent-scoped headers:** a header such as `X-Robots-Tag: googlebot: noindex` applies only to the named agent. Parse `agent: directives` prefixes.

**Findings:**

| Condition | Severity | Category | Title |
|---|---|---|---|
| Googlebot or Bingbot can't crawl this page (one finding per crawler) | medium | seo | `This page is blocked for <Googlebot\|Bingbot> by robots.txt` |
| `X-Robots-Tag` contains `noindex` (unscoped, or scoped to `googlebot`) | medium | seo | `X-Robots-Tag header asks search engines not to index this page` |
| a `noindex` line in robots.txt | low | seo | `robots.txt uses noindex, which search engines ignore` |
| `crawl-delay` present | info | seo | `robots.txt sets crawl-delay (Google ignores it)` |
| unknown directives ≥ 1 | info | seo | `robots.txt has <n> unrecognised directives` (detail: the names) |
| duplicate user-agent tokens | info | seo | `robots.txt lists <agents> in more than one group` |
| any AI crawler (GPTBot, ClaudeBot, Google-Extended, CCBot, PerplexityBot, Applebot-Extended) blocked for this page | info | intel | `robots.txt blocks <n> AI crawlers from this page` (replaces the site-wide AI finding) |
| `ai.txt` present (fetched with the other well-known files) | info | intel | `Publishes ai.txt` |

The existing "robots.txt blocks all crawlers (Disallow: /)" finding stays as it is, for the site-wide case.

**Render:** an "Indexing" table with one row per crawler: Crawl (allowed or blocked, plus the matching rule) and Index (allowed or noindex, with its source).

## 4. Readability in every language (`content` plugin)

`analyze()` adds the following. These are pure helpers, exported.

**Script detection** (`scriptOf(text)`): from letter counts in the main text, the dominant script out of `latin`, `cyrillic`, `greek`, `arabic`, `cjk` (Han, Hiragana, Katakana, Hangul), `hebrew` and `other`.

**Formulas:**

| Script | Formula | Scored? |
|---|---|---|
| English | Flesch (unchanged) | yes, as today |
| `latin` (non-English), `cyrillic`, `greek` | **ARI** = `4.71 × (letters/words) + 0.5 × (words/sentences) − 21.43`, rounded to a grade; letters are `\p{L}` and `\p{N}` | yes |
| `arabic` | **AARI** = `3.28 × letters + 1.43 × (letters/words) + 1.24 × (words/sentences)`, where letters are Arabic-script letters, after Al-Tamimi et al., 2014 | no, shown only, because there are no validated thresholds |
| `cjk` | average **characters per sentence** | no, shown only |
| `hebrew`, `other` | none: "not applicable: <script>" | — |

**ARI findings** (category `content`):
- ARI > 16: medium, `Hard to read (ARI grade <g>)`;
- ARI > 12: low, `Hard to read (ARI grade <g>)`.

**Hardest sentences:** for every script, the 5 sentences with the most words (or the most characters for `cjk`). Each is `{ text: first 120 characters + '…', words, chars }`, stored in `reading.hardest`.

**Data:** `reading` gains `script`, `ari`, `aari`, `cjkCharsPerSentence` and `hardest`. `readability` names the formula used.

**Glance and render:**
- the glance's readability ring shows Flesch (English) or ARI grade (others, ring value `max(0, 100 − (ari − 6) × 8)`); otherwise it shows a text tile;
- render lists the hardest sentences.

## 5. Line length (`content` plugin)

**Collect.** For up to 200 visible `p` elements in the main text root, with at least 80 characters each:
- `lines` = the number of distinct `top` values among `getClientRects()` of a `Range` spanning the paragraph's text (rounded to whole pixels);
- `cpl` = characters ÷ lines.

The output is `lineLengths: [cpl…]`.

**Analyze:**
- **Data:** `lineLength = { median, ideal: share in 45–75, count }`.
- **Findings** (category `content`):
  - median > 80: low, `Lines are long (median <n> characters)`;
  - 0 < median < 35: info, `Lines are short (median <n> characters)`.
- **Glance:** a "Line length" stat showing the median and `<p>% in 45–75`.

## Testing

**Unit tests:**
- **`missingTags`:** filled values and HTML escaping.
- **New meta findings:** `og:url` normalisation (trailing slash and utm differences don't count), relative images, duplicates.
- **`previewModel` fallbacks** for each platform.
- **`renderPreviews`:** truncation; the `themeColor` hex check; placeholder vs thumbnail vs remote image (by `interactive`); no `undefined`/`NaN`; escaping.
- **Robots:**
  - `groupFor` specificity: `googlebot-news` vs `googlebot` vs `*`;
  - `allowed` with `*`, `$`, longest match, allow-wins-tie, empty disallow and query strings, using Google's documented examples;
  - unknown, `crawl-delay`, `noindex` and duplicate detection;
  - an agent-scoped `X-Robots-Tag`;
  - the verdict findings.
- **Readability:** `scriptOf`; ARI on a known passage (hand-computed); the AARI value; CJK characters per sentence; hardest sentences; ARI thresholds.
- **Line length:** median and ideal share from `lineLengths`; thresholds.
- **`links` image:** the `bytes` finding; no thumbnail in Node.

**E2E.** The test site's `robots.txt` gains:

```
User-agent: GPTBot
Disallow: /
User-agent: *
Disallow: /private/
Crawl-delay: 5
```

`X-Robots-Tag` handling is covered by unit tests only. The e2e asserts:
- the indexing table: Googlebot allowed, GPTBot blocked;
- the crawl-delay info finding;
- previews: 7 `.pv-card` elements rendered on the Content area, including one with an `<img src="data:image/webp`;
- `ogImage.thumb` present;
- the readability section names a formula;
- `lineLength.median > 0`.

## Out of scope

- Dark-mode previews.
- The other four Polypane platforms.
- Links to each platform's debugger.
- Readability formulas for Hebrew and other scripts.
- `noindex` from `<meta name="bingbot">`.
