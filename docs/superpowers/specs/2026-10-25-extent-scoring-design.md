# Accessibility scores that count how much of the page is affected — design

Date: 2026-10-25. Status: draft for approval.

## Why

The Accessibility score counts problem types, not how many elements each one affects. It deducts per finding by severity (high 15, medium 6, low 2), capped per severity at 55, 30 and 15.

So a page with many distinct small problems scores lower than a page whose few problems hit a large share of its links. On the latest real-site run:
- Wikipedia's Web accessibility article scored **6**. It has 6 distinct high-severity axe rules covering 33 elements, and its worst real share is about 1% of its text.
- asahi.com scored **16**. It has 65 of its 819 links with no name (7.9%) and 77 of its 501 keyboard stops hidden behind the cookie banner (15%).

The user asked for scores that account for how many elements a finding affects.

The user skipped the questions for this round. Every design choice below is mine and marked **(my call)**. The formula comes from a research pass over the 12 calibration sites, evaluating six candidates. The research files are in the session scratchpad: `scoring/report.md` and its scripts.

**Goal:** an Accessibility score that reflects both:
- **breadth**: how many kinds of problem there are;
- **extent**: what share of the relevant elements they affect.

It should pass these sanity checks on the calibration sites.

**Non-goals:**
- Changing any other area's score. Performance, Security, Content, Build, Infrastructure, International and Sustainability keep today's formula exactly.
- Changing severities.
- Changing which findings exist, except the contrast grouping in C3.

**Anti-goals:**
- Parsing counts out of title text. The research showed titles like "Layout breaks at 1201 px" and "27.3% of selectors" would wreck the Build scores.
- Letting one bad element on a tiny page count as 100% of it.
- Scores the user can't add up from the report.

## A. The finding fields

Any finding may carry these optional fields:

```js
{ count: 65, of: 819, unit: 'links' }
```

- **`count`**: how many elements, or occurrences, the finding affects. Leave it out for page-level findings.
- **`of`**: the relevant population that `count` is out of. Set it only when the plugin already knows that total.
- **`unit`**: a plural noun for the UI, as in "65 of 819 links".

Rules:
- `count` and `of` must be positive integers. Invalid values are ignored, so the finding is treated as having no count.
- If `of` is less than `count`, `of` is raised to `count`.
- Document the fields in `docs/PLUGINS.md`, in the finding shape section.

**Who sets them.** All of these use data the plugins already collect.

| Plugin / findings | `count` | `of` / `unit` |
|---|---|---|
| axe violations | the rule's node count, `nodes` in the data | per rule family (my call): name and link rules → links or controls from a11y-basics stats when available; image rules → images; otherwise focusables; `unit` to match. **Page-level axe rules get no count.** These include landmark-one-main, page-has-heading-one, landmark-no-duplicate-\*, landmark-unique, bypass, document-title, html-has-lang, html-lang-valid, meta-viewport and region, because axe reports a single `<html>` node for them. |
| a11y-basics rules | `rules[].count` | the same stats: links, images, form fields, buttons |
| a11y-structure DOM checks | each bag's `.count` | links, focusables, headings or fields, whichever the check is about. possible-heading and possible-list get a count but no `of`. |
| keyboard (`analyzeKeyboard`) | the stop arrays it already builds | `of` = unique walk stops, including banner stops; `unit: 'keyboard stops'` |
| contrast | see C3 | `totals.checked`, `unit: 'text elements'` |
| a11y-map (alt verdicts, no-name) | the list length | images, `unit: 'images'` |

These page-level findings get no count, matching the research list:
- kb-no-skip-link, kb-skip-target, kb-trap and the kb-banner-\* findings;
- kb-confined and kb-stopped;
- no-main and multiple-main;
- the landmark-duplicate and landmark-indistinct findings;
- reflow and spacing scroll;
- dark and more-contrast "none";
- the views-unverified notes.

**Other areas may set the fields** (for example images, or meta's "104 of 107 images"). They are shown in the report but don't change those areas' scores (see B).

## B. The formula

The formula applies only to the areas in `EXTENT_AREAS = ['accessibility']` **(my call)**. The list is explicit, not "any area where a finding has `of`", so a plugin adding `of` in Performance later doesn't quietly change that area's scoring. Opting another area in is a one-line change, made in its own reviewed batch.

For Accessibility:

```
breadth = BREADTH_SHARE × Σ over severities s of min(CAP[s], DEDUCT[s] × k[s])
          (today's formula, same constants, at most 60)

for each non-info finding with a valid count n and of N:
    share = n / (max(N, n) + EXTENT_SMOOTH)
    e     = EXTENT_WEIGHT[severity] × share

extent         = EXTENT_MAX × min(1, Σ e / EXTENT_FULL)
findings score = clamp(round(100 − breadth − extent), 0, 100)
```

Here `k[s]` is the number of findings of severity s.

| Constant | Value | Note |
|---|---|---|
| `BREADTH_SHARE` | 0.6 | |
| `EXTENT_MAX` | 40 | |
| `EXTENT_FULL` | 0.25 | a severity-weighted share of 25% earns the full 40 points |
| `EXTENT_SMOOTH` | 10 | so 1 of 1 link counts as 9%, not 100% |
| `EXTENT_WEIGHT` | high 1, medium 0.5, low 0.1, info 0 | |

- A finding with a count but no `of` counts toward breadth only.
- The metric blend with Lighthouse is unchanged: two thirds the lower score, one third the higher.
- The overall score, the critical-area cap at 69, and the profile weights are unchanged.
- All of this lives in `extension/core/score.js`, which stays pure.

**What `scoreReading` returns:**
- each deduction on an extent area gains `{ count, of, unit, share, breadth, extent }`;
- the area gains `{ breadth, extent, bySeverity: { high: { findings, raw, capped }, … } }`;
- areas outside the list keep today's data.

## C. Fixes that go with it

**C1. The report's cap text is wrong.** `extension/ui/report.js` says the high cap is 60, but the code has used 55 since the last batch. Generate that text from `CAP`, so it can't drift again.

**C2. The deductions table must add up to the score** (the anti-goal above). Today the rows ignore the caps. In the scoring details section of `report.js`:

- **Extent areas.** The rows show Finding · Severity · Affected · Breadth · Extent. For example:
  - `Links must have discernible text · high · 65 of 819 links (7.9%) · −9 · −12.5`
  - `77 keyboard stops are hidden behind the cookie banner · medium · 77 of 501 keyboard stops (15%) · −3.6 · −12.0`
- **Footer rows.** These make the table add up:
  - per-severity totals with the cap applied, for example "Low · 17 findings · −34, capped −15";
  - the ×0.6 breadth scaling;
  - the extent total, for example "Extent 0.19 of 0.25 → −31.1";
  - the findings score.
- **The explanatory sentence:** "Breadth: each finding deducts high 15, medium 6, low 2 (capped at 55, 30 and 15 per severity), scaled to 60%. Extent: up to 40 more for the share of elements affected." Build the numbers from the constants.
- **Areas outside the list** keep today's columns. They gain the same per-severity cap rows, so they add up too.
- The standalone export and print use the same markup.

**C3. One contrast finding.** Contrast emits one low finding per colour pair. asahi gets 8, which hits the low cap on contrast alone.
- Emit one finding instead: `"${failing} text elements fail contrast (${pairs} colour pairs)"`, with `count` = totals.failing, `of` = totals.checked and `unit: 'text elements'`.
- Its severity is the worst severity among the pairs (my call).
- The pairs move to evidence and the plugin's own table, which is unchanged.
- The finding id must stay stable. Keep the current id of the first pair finding if there is one; otherwise use `contrast:contrast-pairs`. The implementer checks the existing ids and updates the OVERLAP and REFERENCE rows.
- How it overlaps axe's color-contrast stays as it is today.

**Not in scope:** the links plugin's one-finding-per-broken-link (Content area), and possibly-false Wikipedia red links. Content doesn't use extent, so they don't affect this change. Note them as a follow-up.

## Acceptance

- **Unit tests in `test/score.test.mjs`:**
  - the formula with the constants above;
  - the smoothing case (1 of 1 → share 1/11);
  - invalid `count`/`of` ignored;
  - `of` < `count` raised;
  - info findings contribute nothing;
  - an area outside `EXTENT_AREAS` scores exactly as today, using a fixture copied from the current tests;
  - a test that the deductions table rows plus footer add up to the area's findings score.
- **Plugin tests** for the fields each plugin sets, including page-level axe rules having no count.
- **`npm test` and `npm run test:e2e` pass.** Never run e2e and calibration at the same time.
- **Real sites.** Re-run `node scripts/calibrate.mjs` and `--a11y`. Accessibility should land within ±5 of the research figures:

  | Site | Before | Expected after |
  |---|---|---|
  | GDS test page | 0 | 0 |
  | gov.uk | 96 | 97 |
  | BBC | 96 | 91 |
  | example.com | 88 | 91 |
  | Patagonia | 82 | 89 |
  | MDN | 71 | 81 |
  | thymecare | 78 | 66 |
  | react.dev | 49 | 65 |
  | Al Jazeera | 53 | 47 |
  | Wikipedia | 6 | 37 |
  | Le Monde | 22 | 19 |
  | asahi | 16 | 18 |

  The C3 contrast grouping will move asahi and Le Monde a little. Hard checks:
  - GDS is the lowest;
  - Wikipedia is above asahi;
  - gov.uk is in the top two;
  - no other area's score changes, except through C3's effect on the overall score.
- **Record before and after** in the calibration memory.

## Left to the builder

- Exact wording of the footer rows and the Affected cell, plain and counts first.
- Where the per-family `of` for axe rules comes from when a11y-basics stats are missing: fall back to focusables, else no `of`.
- Rounding in the table: one decimal for the breadth and extent columns, so the footer adds up to the rounded score within 1.
