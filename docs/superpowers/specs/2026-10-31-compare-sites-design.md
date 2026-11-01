# Comparing sites

Status: draft for approval · 2026-10-31

## Why

People compare sites with HARgus all the time:

- the user compares Harvard against UCSD in class;
- students hand in screenshots of their findings;
- salespeople and project managers set a customer's site against 3–6 competitors.

Today each report has to be read separately, panel by panel, to see which site wins. The overall winner is easy to
see, but the details are hard to see. The comparison view does that reading:

- **The verdict:** who wins overall.
- **The areas:** who wins each area, and why.
- **The metrics:** a metric-by-metric face-off underneath.
- **Each site's standing:** its key strengths and weaknesses within the group.

A group of sites can be saved as a **set**, recorded from a list of URLs, and recorded again later to show **before and
after**.

The user's words and choices:

- the layout is "area by area, who wins each" with the screenshot header and its strengths and weaknesses (mockup C2);
- many sites switch to the compact strip (mockup C3);
- sites are entered as a list most of the time, but readings taken one by one can also be grouped;
- sets are recorded again later to show before and after.

Everything else marked **(call)** is my decision.

## Goals

- **Compare view:** compare 2–8 readings on one page. It shows the overall winner, a winner per area with a reason, a
  metric face-off, and two strengths and two weaknesses per site.
- **Ties:** a difference that falls inside run-to-run noise, or under a small threshold, reads as a **tie** and never as
  a win.
- **Sets:** a named group of URLs with its readings, kept in the library.
- **Record a list:** paste URLs and HARgus records each in turn, with the same settings.
- **Same-conditions warning:** when the readings were not taken alike, the page says how, in plain words.
- **Before and after:** record a set again, and compare any two rounds: each site's grade then and now, its area
  changes, and its rank change.
- **Export:** the comparison exports as one standalone HTML file with no script, like a report, and prints cleanly.

## Non-goals

These are the ideas marked **No** on 2026-10-30, and they stay out:

- head-to-head sentences;
- lists of shared and unique issues;
- ranking against a reference group;
- presenter mode;
- class bundles;
- spot the problem;
- thresholds in CI.

The short "why" notes and the strengths and weaknesses are labelled facts ("Fastest LCP (2.0 s)"). They are never
sentences that argue for one side.

Also out:

- **Postponed items:** more than one page per site, and company context.
- **Automation:** scheduled re-recording, and cloud sync or sharing of sets.
- **Branding:** the user adds any branding outside HARgus, so exports stay HARgus.
- **Statistics:** nothing beyond the median and range that runs already give.

## Anti-goals

- **A winner declared from noise:** a "win" by 0.05 s on a single run is a failure, even if the arithmetic is right.
- **Comparing unlike readings silently:** mobile against desktop, or throttled against unthrottled.
- **A comparison that needs every report opened:** recording a list must not leave the user opening six reading tabs
  by hand to finish them.
- **Changing single reports:** no change to how a single reading is scored or shown. `score-check --compare` must
  show "no differences".

---

## How it works

### The compare page

`ui/compare.html` is a new extension page, like the library and the reading page. It opens from the library and from
a set. Its URL names the readings (`?ids=a,b,c`) or the set (`?set=<id>`), so a reload or a bookmark shows the same
comparison.

`compare.html?set=<id>` is also **the set's page**: it holds the round picker, and while a round is recording it shows
the round's progress list above the comparison of whatever is done so far. There is no separate set page. The Sets tab
in the library lists sets and links here. **(call)**

**What can be compared:**
- Reload and snapshot readings can be compared.
- Readings taken in **record** mode, which can cover several pages, can't be compared yet. Their library checkbox is
  disabled, with the title "Recordings of several pages can't be compared yet". **(call)**
- Two sites on the same host are labelled with host and path. **(call)**

From top to bottom:

1. **Conditions warning**, when one applies (see below).
2. **Verdict line**, for example "Overall: harvard.edu · wins 4 areas · ucsd.edu 2 · stanford.edu 2 · 1 tie". An overall
   tie reads "Overall: tie between harvard.edu and stanford.edu".
3. **Site headers.**
   - With **2–4 sites**, each site is a column headed by its favicon (when the reading has one, otherwise its initial),
     host, viewport thumbnail, overall score and grade, and a ★ on the winner.
   - Under that come up to **two strengths** (green) and **two weaknesses** (red).
   - With **5–8 sites**, the headers become a **compact strip** of chips: favicon, host, score and grade, ★. The
     strengths and weaknesses then move to a "Strengths and weaknesses" block right after the area table, with one row
     per site. **(call: the cut-off at 4, and where the bullets go)**
4. **Area table.** It has one row per area in `AREAS` order:
   - the area name;
   - the winner (or "tie");
   - each site's area score as a bar with the number, with ★ on the winner;
   - a short **why**: the metric with the largest relative gap between the winner and the last-placed site in that area,
     as "LCP 2.0 s vs 3.4 s".

   An area a site could not measure shows "not measured" for that site, and that site takes no part in the area.
5. **Metric face-off.**
   - A summary line, for example "24 metrics: ucsd.edu wins 11, harvard.edu 8, stanford.edu 3, 2 ties".
   - Then one table row per metric, grouped under area subheadings. Each row shows each site's value, with the best in
     green, the worst in red, and the winner (or "tie").
   - It is open on screen, and print opens it too.
6. **Links.** Each site's host links to its own report. In the export, which has no script, the hosts are plain text.

The page works in light and dark, and at narrow widths: the table scrolls sideways inside its own box, not the page.

### Who wins

All readings are **scored again at view time** with the current scoring profile (`scoreReading`), so every site is
judged by the same weights. The page names the profile in a note ("Scored with the Public sector / education profile").
**(call)**

**Overall and area winners**
- The highest score wins.
- When the top two are within **3 points** (`TIE_POINTS = 3`), it is a tie between every site within 3 points of the
  top. **(call: 3 points is about one low-severity finding and a half)**

**Metric winners**
- Each metric has a direction: lower is better, or higher is better.
- **Timings, both sites with 2 or more runs:** the top two tie when their run ranges (min–max) overlap.
- **Otherwise:** the top two tie when they are within **10%** of the better value (`TIE_PCT = 0.10`). There is also an
  absolute floor per unit (100 ms for timings, 0.02 for CLS, 1 for counts, 10 kB for sizes). Values equal at display
  precision always tie.
- **Single-run note:** when any timing in the comparison comes from a 1-run reading, the face-off carries one note:
  "Some timings are single runs; record with 3 runs for firmer results." **(call)**
- **Missing values:** a site with no value for a metric is left out of that metric. A metric that fewer than 2 sites
  have is not shown.

**Strengths and weaknesses for each site, up to two of each**
- **Strength:** a metric where the site is the outright winner, not a tie, ordered by margin over the runner-up.
- **Weakness:** a metric where the site is outright last, ordered by margin.
- If there are fewer than two, area wins and losses fill in ("Best Accessibility (90)").
- If there are none, the site shows "No clear strengths in this group" or "No clear weaknesses in this group".
- **Labels** are short and fixed per metric, for example "Fastest LCP", "Lightest page", "Fewest third-party
  requests", "Most contrast failures", with the value in brackets.

### The metrics

The face-off uses values already in a reading, with no new plugin work. The starting list, by area:

| Area | Metrics (direction) |
|---|---|
| Performance | LCP, FCP, TTFB, CLS, blocking time, load (all lower is better), as medians when runs exist |
| Performance | Page weight (bytes transferred) and requests (lower) |
| Accessibility | Accessibility findings, high plus medium (lower), and contrast failures (lower) |
| Security | Security findings, high plus medium (lower), and security headers present out of the checked set (higher) |
| Content | Content findings (lower) |
| Build | Third-party requests (lower), and JS bytes and CSS bytes (lower) |
| Infrastructure | Infrastructure findings (lower) |
| International | International findings (lower) |
| Sustainability | Carbon per visit in grams (lower) |

Each metric is a small, named, pure extractor (`reading → number | null`) in one module, so the list can grow without
changing the page. The builder may swap a metric for a better source already in the reading, but must keep the
list short: about 20–25 rows, not a dump of every number. **(call)**

### Sets

A **set** is stored in a new IndexedDB store `sets`, with the database moving to version 3:

```js
{
  id, name, createdAt,
  urls: ['https://…', …],          // in the order given
  settings: { device, throttle, bypassCache, runs, coverage },  // what "Record again" reuses
  rounds: [                         // oldest first
    { at, readings: [ { url, id: '<reading id>' | null, error: 'reason' | null } ] },
  ],
}
```

- **Readings stay ordinary readings.** They live in `readings` and `index` as today. A reading can belong to more
  than one set.
- **Deleting a set** leaves its readings.
- **Deleting a reading** that a set uses leaves a gap, shown in the comparison as "reading deleted".
- **Making a set from the library:** select 2–8 readings, then choose **Compare** or **Save as set**. The library gets
  checkboxes on cards for this. A set made this way has one round, holding those readings. Its `settings` come from
  the first reading's capture settings. **(call)**
- **Adding to a set:** a library card's **Add to set** menu adds that reading to a set's **latest round**:
  - if its URL is already in the set, it replaces that URL's reading in that round;
  - otherwise the URL is added to the set's `urls` and to the round.

  The set's `settings` stay as they are, so the conditions warning shows any difference. **(call)**
- **Making a set from a list:** the library gets a **Sets** tab. **New set** asks for a name and a box of URLs, one per
  line. Pasting works, and so does typing them one at a time.
  - Lines that are not http(s) URLs are pointed out, and repeated URLs are dropped.
  - A list holds 1–8 URLs. A single URL is allowed, for before and after of one site. **(call)**
  - A bare host such as `ucsd.edu` gets `https://` in front.
  - The capture settings come from the current settings, which the user can change on the same form.
- **Each set** shows its name, its sites' favicons, its number of rounds, and the date of its last round, with
  **Compare**, **Record again** and **Delete**.
- **Library cards** of readings in a set show the set's name as a chip, which links to the set.

### Recording a list

- **Starting:** **Record** (for a new set) or **Record again** (for an existing one) starts a round.
- **The window:** HARgus opens **its own window** holding one working tab, and takes a normal reload reading of each
  URL in turn, in list order, with the set's settings. Device, throttle, cache, runs and coverage are the same for
  every site. **(call)**
- **Keeping it visible:** a hidden or covered tab loses timing runs and views, so the progress list says "Keep the
  recording window visible until the round ends". A site whose runs were skipped because the tab was hidden shows
  that in its own reading health and in the conditions warning ("stanford.edu: 1 of 3 runs"). The round does not
  pause. **(call)**
- **Bringing tabs forward:** `ui.openWhenDone` is ignored during a round, so finished reading tabs never come to the
  front over the working tab.
- **One site at a time:** the next site starts only when the previous reading's analysis has finished, so lookups don't
  pile up. **(call)**
- **Reading tabs** finish their analysis in the background as today. During a list recording, each one **closes itself
  when its analysis is done**, so the user is left with the working tab and the set's progress view, not a tab per
  site. The readings are in the library, linked from the comparison. **(call)**
- **Progress:** the set's page shows the round as a list, for example "Site 3 of 5: stanford.edu, analysing". Each site
  has a state: waiting, recording, analysing, done, or failed with its reason.
- **Failures:** a site that fails, or doesn't finish within the calibrate-style deadline (300 s × runs), is recorded as
  `error` and the round moves on. A failed site shows in the comparison as "not recorded: <reason>".
- **Stopping:** the round can be stopped. The sites done so far are kept, and the round is marked incomplete.
- **One round at a time:** while a round is running, starting another round is refused.
- **When it ends:** the compare page opens for the new round.

The service worker can be restarted mid-round. The round's state must be stored (in the set record) so that the set
page can show where it stopped. Resuming is not required: the user can start a new round, and the incomplete one is
kept. **(call)**

### Same conditions

The comparison compares each reading's capture settings. When they differ, a warning sits above the verdict, one line
per difference, in plain words:

- device: "ucsd.edu was recorded on mobile, the others on desktop";
- throttle;
- cache bypass;
- runs: "harvard.edu used 1 run, the others 3";
- coverage on or off;
- mode, snapshot against reload;
- capture dates more than **7 days** apart: "Recorded between 3 Oct and 30 Oct". **(call: 7 days)**

The warning never blocks the comparison. The export carries it too.

### Before and after

- **Incomplete rounds** can be picked; their missing sites show "not recorded".
- **Which rounds:** a set with 2 or more rounds shows a round picker: **Compare round** [latest] **against**
  [previous]. The default is the latest against the one before. Any two rounds can be picked.
- **The view:** the before-and-after view keeps the same layout, with each site's figures showing their change:
  - **Headers:** the grade then → now, and the rank change, for example "3rd → 1st".
  - **Area table:** each score with its change ("88 ▲14"), or "no change" when the change is within `TIE_POINTS`.
  - **Face-off:** each metric then → now, using the same tie rules to decide "no change".
  - **Verdict line:** for example "ucsd.edu improved most (+9); stanford.edu fell (−5)". This reports a change; it is
    not a head-to-head sentence. **(call)**
- **Sites in one round only:** a site in one round but not the other shows "new in this round" or "not in this round".
- **One site:** a set of a single URL recorded twice is a plain before and after of one site, for the "did my fix
  help?" case. The compare page allows 1 site when two rounds are being compared.

### Export

**Export** on the compare page saves one standalone HTML file:

- the same layout, with the CSS inlined, thumbnails as data URLs, and **no script**;
- the conditions warning, and a footer with the date of each reading and the profile used.

**Print** gives a clean PDF in landscape, with the face-off opened.

The export reuses the report's standalone machinery (inlined CSS and fonts, `h` helpers). **(call)**

### Help

A short "Comparing sites" section in the Help, about 70 words, covering:

- what wins means: the highest score, with ties within 3 points or within run noise;
- that all sites are scored with the same profile;
- what the conditions warning means;
- how to record a set again for before and after.

It stays within the word cap: trim elsewhere, or raise the cap by the amount added.

---

## Constraints

- The project's hard rules apply to the compare page and its export:
  - `theme.css` contains no `<` outside comments, and its media queries use only min-width and max-width;
  - drawing goes only through the `h` helpers;
  - the export has no script;
  - `places` keys are whitelisted;
  - capped lists store true counts.
- **No change to single readings:** no change to scoring or to the single report. `score-check --compare` shows "no
  differences".
- **No new permissions:** no new extension permissions. Tab groups are not used.
- **Migration:** the IndexedDB upgrade to version 3 only adds `sets`, and existing stores are untouched. Opening the
  library with an older page open still gives the existing "close other HARgus tabs" message.
- **Pure logic:** winner, tie, strength and metric logic lives in pure modules (`core/compare.js`, `core/metrics.js`)
  with unit tests. The page only draws.
- **e2e:** record a set of 2 local test pages with the list recorder, then check that:
  - the round finishes with 2 readings and no reading tabs left open;
  - the compare page renders the verdict, the area table and the face-off;
  - a mobile reading added to the set with **Add to set** raises the conditions warning;
  - **Record again** creates a second round, and the before-and-after view renders.
- **Screens:** `scripts/screens.mjs` gains compare shots: 3 sites, 6 sites (strip), dark, narrow, before and after,
  and the export.

## Left to the builder

- **How the working tab is driven:** it reuses `capture()` per URL. The builder decides how to wait for "analysis
  done", since the reading tab already reports `harplus:analysis` with stage `done`.
- **How a reading tab knows to close itself:** for example a `close=1` query on the progress tab URL.
- **The favicon source:** the HAR's favicon response, or the page's icon link when its body was kept; otherwise the
  host's initial.
- **The bar drawing:** reuse the meters or bars from `charts.js` if they fit.
- **The exact metric extractors:** where each value lives in the reading, within the list above.

## Open after this item

- **Retuning:** if `TIE_POINTS` or `TIE_PCT` calls too many or too few ties in real use, retune them. They are named
  exports.
- **Postponed items:** more than one page per site, and company context, can build on sets later.
