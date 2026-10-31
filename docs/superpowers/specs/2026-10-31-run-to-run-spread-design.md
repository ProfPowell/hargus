# Run-to-run spread

Status: draft for approval · 2026-10-31

## Why

Page timings vary from one load to the next: the network, the server and the machine all wobble. One reading
can land on a good or a bad run, so a grade, a class exercise or a sales comparison can rest on a fluke. Recording
the same page a few times and showing the spread does two things:

- **Students learn the habit:** one number is a sample, not the truth.
- **The numbers that matter become steadier:** the reading reports the middle run, not whichever one happened.

This is also groundwork for the comparison project, which comes next. A "win" that falls inside the noise should
read as a tie, and that needs stored samples.

The user skipped the questions for this item. The decisions below are my calls, and each one is marked **(call)**.

## Goals

- **Runs choice:** a reading can be taken with **1, 3 or 5 runs** of the same page. The default is 1, which
  behaves exactly as today.
- **Median everywhere:** with more than one run, the timing metrics show the **median**, together with the
  **range** (lowest to highest) and the run count. Ratings, findings, the Performance score and the Overview all
  use the median, so the reading states one value per metric.
- **Steady or varies:** each metric says whether it was steady or varied across the runs.
- **Per-run table:** the samples from every run appear in a small table that is closed by default.
- **Comparison data:** the samples are stored in the reading, so a later comparison can tell a real difference
  from noise.

## Non-goals

- **Ties in comparisons.** Marking "within the noise" belongs to the comparison project. This item only stores what
  that project needs.
- **Repeated runs of anything except page-load timing.** Views, screenshots, accessibility, content and the other
  plugins come from the full run only. They don't vary by run in any way worth the time.
- **Snapshot and record modes.** Runs apply to reload readings only.
- **Statistics beyond median and range.** There is no standard deviation, confidence interval or outlier removal.
  The audience is students and salespeople, and 3–5 samples don't support more.
- **Re-running old readings.** A reading taken with 1 run stays a 1-run reading.

## Anti-goals

- **Slowing down every reading.** The default stays 1 run. Extra runs must be quick timing-only reloads, not full
  readings: no views, no screenshots, no bodies.
- **Two values for one metric.** If the tile shows the median, the rating, the finding and the score all use the
  median too. They must never show one run's value while the score uses another.
- **Changing existing readings.** Any reading without runs scores exactly as before. The score check must show no
  differences.

---

## How it works

### Choosing runs

- **Popup:** a **Runs** select beside the existing capture options (throttle, device, cache), offering 1, 3 and 5.
  It is saved as `settings.capture.runs` and defaults to 1. It applies to **Take reading** only, and is disabled or
  hidden when snapshot or record is the action. **(call)**
- **Options:** the same setting, so it can be set once for a class.

### Capturing

- **The timing runs come first, and the full reading is the last run.** The full reading works exactly as today: page
  plugins, views, screenshots and analysis. Its HAR, page checks and timings all come from the same load. Runs
  1…N−1 are timing runs in the same tab. Each one:
  - uses the same device, throttle and cache settings as the full run, with the cache bypassed when `bypassCache` is on;
  - reloads the page and waits for idle;
  - collects only the vitals data that the vitals plugin already gathers (LCP, FCP, TTFB, CLS, blocking time,
    DOMContentLoaded, load);
  - keeps no request bodies, screenshots, views or other plugins.

  The timing runs go inside the capture session, before the full run's reload. They must run with the emulation and
  throttle of the full run, and their network traffic and console must not enter the reading.
- **Coverage stays off during the timing runs,** even when the coverage setting is on. Coverage changes the
  timings (it was measured last round). **(call)**
- **Progress:** the progress page shows "Timing run 2 of 3".
- **Failures:**
  - A timing run that fails or times out is skipped, with its reason recorded.
  - The spread needs at least 2 successful runs, counting the full run.
  - With fewer, the reading behaves as a 1-run reading and says "Only 1 of 3 runs succeeded" in Reading health.
  - A failed timing run never fails the reading.

### Stored data

The run data goes in `log._harplus.runs`:

```js
{
  requested: 3,
  samples: [            // one per successful timing run, in run order
    { run: 1, lcp, fcp, ttfb, cls, blockingTime, domContentLoaded, load },
  ],
  skipped: [ { run: 2, reason: 'timed out' } ],
  // the full run is run 3; its sample is the vitals plugin's own data, joined at analysis time
}
```

- Units match `vitals.data`: milliseconds, and CLS without a unit.
- A metric a run couldn't measure is `null` and is left out of that metric's median.
- `log._harplus.capture.runs` records the number of successful runs. The comparison project needs it to tell like
  from like.
- The library index record gains `runs` (the successful count), so a card can show "×3".

The **median** and **range** are worked out at analysis time from `samples`, not stored. They can then be
recomputed whenever the rules change, the same way plugins replay today.

### Vitals plugin

When `runs.samples` has 2 or more entries, the vitals plugin works on the median of each metric instead of the full run's
value. That covers:

- ratings (`ratings`);
- findings (the same `LIMITS` and `BLOCKING` thresholds);
- the glance tiles;
- the `metricInput` the Performance score uses (via `ratings`).

For readings with no runs, or one sample, nothing changes.

The LCP element, the CLS sources and the resource lists still come from the full run. Help says so
once. **(call)**

- **Steady or varies (call):** a metric **varies** when its runs fall into more than one rating band, or when the
  range is more than 25% of the median. Otherwise it is **steady**.
  - The 25% figure is a starting value. Blocking time and CLS are often near 0, so for them only the band rule
    applies.
  - TTFB, load and DOMContentLoaded have no bands, so for them only the 25% rule applies, with a floor of 100 ms on
    the range.
- **Findings:** when a metric varies and its runs straddle a band edge, the finding's evidence says so ("2 of 3 runs
  were poor"). Severity still follows the median. No new finding is added for variance alone. It is information,
  not a problem with the site. **(call)**

### Showing it

- **Glance tiles** (LCP, CLS, FCP, TTFB, blocking time):
  - The value is the median, and the note reads "1.9–2.6 s · 3 runs" with **steady** or **varies** in words.
  - The meter shows the median. A min–max range drawn on the meter is a nice-to-have, left to the builder, if
    `h.meter` can take it cleanly in the static export.
- **Vitals panel:** a closed "Each run" section with a table of run, LCP, FCP, TTFB, CLS, blocking time and load,
  with the median row last. Skipped runs are listed with their reasons.
- **Overview "At a glance":** LCP and CLS show the median, with "median of 3" in the note.
- **Library card:** "×3" beside the mode or device when `runs` is greater than 1.
- **Help:** a short section, "Runs", with about 60 words:
  - timings vary between loads;
  - several runs report the middle one;
  - "varies" means the runs disagree enough that one reading could mislead;
  - only timings are repeated, and the element details come from the full run.

  It stays within the Help word cap: trim elsewhere, or raise the cap by the amount added.
- **Labels:** say "median" and "runs" in plain words, and never use "p50" or "σ".
- **Export:** the static export shows all of the above without script, as it does today.

### Tooling

- **`scripts/calibrate.mjs --runs N`:** it passes `runs` into the capture settings. Output files are unchanged, one
  per site.
- **calibrate per-capture timeout:** this follow-up came out of the last round, because a capture once hung for over
  an hour. Add a per-capture timeout that skips the site with a logged reason. Multi-run captures make a hang more
  likely, so it belongs in this build. **(call)**
- **Live check:** record 5–6 of the calibration sites with `--runs 3`. The report lists, per site and metric, the
  range as a percentage of the median. This is the evidence for the 25% starting value. It also gives the wall-clock
  cost per extra run, and Help should state the cost honestly ("each extra run adds about N seconds").

---

## Constraints

- No change to any reading without `runs`. `score-check --compare` must show "no differences".
- The project's hard rules still apply:
  - `theme.css` contains no `<` outside comments, and its media queries use only min-width and max-width;
  - plugins draw only through the `h` helpers;
  - the export runs without script;
  - `places` keys are whitelisted and hold locations only;
  - capped lists store true counts.
- Timing runs share the tab and the session rules of the full run. A second capture in the same tab is still refused
  while runs are in progress.
- e2e covers a 3-run reading against the local test page:
  - `runs.samples.length` is 3, or 2 or more with a recorded skip;
  - the tiles show a range;
  - the "Each run" table renders.

## Left to the builder

- Where the timing runs go in the capture flow: inside the session before the views, or after it.
- How to get vitals-only data for a timing run (reuse the vitals page collector).
- Whether the meter gets a range mark.
- How median handles an even sample count (2 runs succeeded): use the mean of the middle two.

## Open after this item

- The comparison project uses `runs.samples` to mark ties. This spec only guarantees the data.
- If the live check shows that the 25% rule flags almost everything, or almost nothing, retune it then. It is a
  named export, like the other thresholds.
