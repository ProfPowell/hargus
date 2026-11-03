# Punch list and recheck — design

Date: 2026-11-03. Phase 1 of the site audit (roadmap item 4). Phase 2 (pages linked from the page) and the drift CLI for CI/CD are separate projects that build on this one.

## Why

The user ran HARgus on sites they own — decently built ones — and it turned things up. Sites drift: over time it is easy to skew things and make a mess. What they want in hand at that moment is not another report but a **list of things to fix**, written so Claude (working in the site's source) or a human can work through it.

HARgus's role is a **superhuman QA tester**: it reports *where* a problem shows up and *what* the deficiency is. It cannot see the source, so it never says how or where in the code to fix it — that is up to whoever has the source (usually Claude Code in the site's repo).

The user also wants to **close the loop**: after fixes, re-run HARgus and see what is fixed, what remains and what is new. Rechecks normally run **locally, before deploy**.

## Goals

1. **Export punch list** from any reading: a Markdown work order of the findings worth fixing, one QA-style item per problem.
2. **Stable item IDs**, so the same problem gets the same ID on every recording of that page (on any host).
3. **Recheck** command, run headlessly from a terminal (Claude Code), that records the page again and rewrites the list with each item's status, plus anything new.
4. **Page vs Deploy** tagging, so a local recheck never claims a deploy-dependent item is fixed or still there.

## Non-goals (phase 1)

- Pages linked from the page (phase 2, own brainstorm after this ships).
- CI/CD drift monitoring, thresholds, baselines across builds (later; reuses this project's IDs).
- Anything about source files, frameworks or code locations beyond what HARgus sees from outside (script/CSS URLs and lines it already reports are fine).
- Driving the user's own Chrome via Claude in Chrome. Checked on 2026-11-02: Claude in Chrome refuses `chrome-extension://` pages and cannot trigger extension shortcuts, and a manual Alt+Shift+H on a tab it controlled did not record. Rechecks use the headless route instead (Playwright Chromium with the unpacked extension, as `scripts/calibrate.mjs` and e2e already do).
- Scores, grades, charts or readout numbers in the punch list.

## Anti-goals

- A list padded with noise: info findings, or one item per element for a rule that hits 40 elements.
- A recheck that says "fixed" when it simply could not check (headless-skipped plugin, deploy-only item on localhost, timing on localhost).
- IDs that change between two recordings of an unchanged page — that makes every recheck look like "all fixed, all new".

## The punch list (Markdown)

Exported from the reading page's export menu as **Punch list (Markdown)**, next to the existing brief (`toMarkdown`) exports. File name `<stem>.punchlist.md`. Built by a pure function in `extension/core/` so the browser export and the recheck script share it.

### Header

- Title: page title, then the page URL.
- Recorded: local date/time; device (desktop/mobile), throttling, runs — the capture settings the recheck will reuse.
- Counts: N items (high / medium / low).
- One line telling the reader how to recheck: `node <path-to-hargus>/scripts/punchlist.mjs --recheck <this file> --url <url>`.
- A machine-readable block the recheck reads back (settings, original URL, list of item IDs with their status). Builder's call on its form; it must survive a human or Claude ticking checkboxes and editing prose around it. An HTML comment holding JSON at the end of the file is one option.

### Which findings

- **Included:** severity high, medium and low. **Excluded:** info (stays in the report).
- Only active findings (after `supersede`), the same set the Issues pane shows.
- Sections in order: **High**, **Medium**, **When you have time** (low). Within a section, the report's existing order.
- One finding = one item. A finding's many places stay inside that item (already how findings work: one rule, many places). Places are capped for readability with a true "…and N more" count, as `issueMarkdown` does today.

### Each item

```
- [ ] **Low-contrast text** · high · Page · `HG-3f9c2a`
  - **Where:** https://example.com/pricing
    - `.cta > a.btn` “Sign up” (2.9:1)
    - …and 4 more places
  - **What's wrong:** 5 text elements are below the contrast minimum.
  - **Expected:** Normal text at least 4.5:1 against its background; large text at least 3:1.
  - **Reference:** WCAG 1.4.3 Contrast (Minimum) — <https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html>
```

- **Title**, **severity**, **tag** (Page / Deploy), **ID**.
- **Where:** the page URL plus the finding's places (selector, visible text, request URL, header, file and line — whatever the plugin records). Conditions where relevant (e.g. found in the mobile or dark-mode view) when the finding carries them.
- **What's wrong:** the finding's title/detail as HARgus states it today — what it saw.
- **Expected:** what correct looks like, stated as a target, not a code change. Omitted when not knowable.
- **Reference:** WCAG or standard link where one exists.
- Console findings keep today's privacy rule: titles and line numbers only, never message text.

### "Expected" text

- Accessibility findings already have fix-it reference text (`core/a11y-reference.js`: what / why / fix / WCAG). Reuse it; "fix" becomes Expected (reword only where it describes code rather than outcome).
- Every other rule that can produce a high/medium/low finding needs a short Expected line (one sentence, outcome-shaped: "Header present with max-age of at least one year"). This is the largest single piece of work. Store it as data beside the rules (one table keyed by plugin + finding id), not inside the export code.
- A rule with no Expected text still exports; the line is simply omitted. A unit test lists rules still missing it so the gap is visible, but does not fail the build.

### Page vs Deploy

Each rule is tagged once in data:

- **Page** — can be checked on any server, including localhost: markup, accessibility, content, images, links, page scripts and styles present, international.
- **Deploy** — depends on the real server/CDN: security headers, HTTPS/TLS/certificates, compression, caching headers, HTTP version, redirects, CDN, DNS lookups.

- **Timing** — the finding depends on measured speed (vitals, load, blocking time, slow requests, PageSpeed). Judged only against a non-local URL.

Default by area (Accessibility, Content, International → Page; Security, Infrastructure → Deploy); Performance, Build and Sustainability are sorted rule by rule by the builder. When unsure, tag **Deploy** — the cost of a wrong Deploy tag is "verify after deploy", the cost of a wrong Page tag is a false "fixed". The punch list shows the tag on each item.

## Stable IDs

**Rule ids first (decided after the builder check).** Most findings carry no `id` today: on the 21 calibrate readings, 668 of 802 non-info findings have none (meta, security, network, links, content, a11y-structure, contrast and ~20 more plugins). Every finding-producing rule gets a stable, slug-shaped `id` (e.g. `security/missing-hsts`), set in the plugin where the finding is made. Titles are never used as keys — they embed counts and hosts.

- This adds an `id` field to stored findings. Scores and every other finding field must stay identical: run score-check, confirm the only differences are added `id`s, then rewrite the baseline once and record that in the commit. A rule that already has an id keeps it.
- The same rule id keys the rule data (Expected text, tag).

**Item ID.**
- Format `HG-` + short hash (builder's call on length).
- Built from: plugin id + rule id + the page's **path and query** taken from the reading's original target URL (not scheme or host, so production and localhost match) + a **discriminator** only when one rule legitimately emits several findings on one page (e.g. one per third-party host, one per view). The discriminator is a stable value the plugin supplies (a host, a view name, a header name) — never a count, timing, size, ratio, selector list or place.
- A finding's places never enter the ID: one finding = one item, and "5 places" becoming "3 places" is the same item, still there.
- If two findings still hash the same, sort them by discriminator then title and suffix `-2`, `-3`; the builder reports any rule where this happens on the calibrate readings, and gives it a proper discriminator.
- Must be identical across two recordings of an unchanged page, including with runs = 3. Builder verifies against real readings (two calibrate readings of the same site) and reports any unstable rule.

## Recheck

`node scripts/punchlist.mjs --recheck <file.md> --url <url> [--out <file>]`

1. Reads the machine-readable block: original URL, capture settings, items.
2. Records `--url` (default: the original URL) headlessly with the unpacked extension and the same settings — reusing calibrate's launch and capture code, not a copy of it. Per-capture timeout as calibrate has. "Same settings" means the HARgus capture settings the reading recorded (device, throttling, runs, views, cache): the script writes them into the extension's settings before recording, as calibrate already does for runs and coverage. A setting the headless route cannot apply is reported, and items found only in that view become **can't check headlessly**.
   - If the new recording is an interstitial (`detectInterstitial`: login wall, bot check, error page) or fails, stop with exit 2 and leave the file untouched.
   - IDs use the path of the URL being rechecked if `--url` is given, else the original's. If the recorded final path differs from it (a redirect), warn in the summary line but carry on.
3. Builds the new item list and matches by ID.
4. Rewrites the file (in place unless `--out`), keeping the same item layout:
   - **fixed** — ID gone and the item was checkable here. Checkbox ticked, "fixed <date>".
   - **still there** — ID present; What's wrong updated to what HARgus sees now.
   - **verify after deploy** — Deploy item (or timing item) and `--url` is local.
   - **can't check** — the rule's plugin did not finish with status `ok` in this run (skipped headlessly like coverage or translation, or a lookup that errored or timed out), so absence proves nothing. The note says why.
   - **New since last check** — a section for IDs not on the list. On a local URL, new Deploy and timing findings are left out (localhost lacks HTTPS, compression, etc.).
5. Prints a one-line summary (e.g. `12 items: 7 fixed, 3 still there, 2 verify after deploy; 1 new`).
6. Exit code: 0 when nothing is still there and nothing is new; 1 otherwise; 2 when the recording itself failed.

**Local** means host `localhost`, `127.0.0.1`, `[::1]`, or ending `.localhost` / `.test`, or `--local` given. Against a non-local URL everything is judged, which closes out Deploy items.

The machine-readable block is the source of truth for which items are on the list and their last status; visible checkboxes are output only. Items whose visible entry was deleted from the file stay deleted (the recheck drops them from the block too); items ticked by hand but still present come back unticked and marked still there. A missing or unreadable block stops the recheck with exit 2 and a message saying to export a fresh list.

## Where things live (builder may adjust)

- `extension/core/punchlist.js` — pure: findings → items, IDs, Markdown out, Markdown in (parse the block), merge old list + new reading → statuses.
- Rule data (Expected text + Page/Deploy tag) — one data module, a11y entries derived from `a11y-reference.js`.
- `scripts/punchlist.mjs` — CLI; shares capture code with `scripts/calibrate.mjs` (extract a shared module if needed).
- Reading page export menu — one new entry.
- Help — one short paragraph on the punch list and recheck.

## Constraints

- No change to scoring: scores identical in `score-check`; the only finding change allowed is the added `id` (see Stable IDs).
- No new `manifest.json` permissions.
- Exported Markdown contains no console message text and no response bodies.
- Readings recorded before this ships have findings without rule ids: the export works on them only after their analyze plugins re-run (as score-check does), or else is disabled with "Record this page again to export a punch list" — builder's call.
- Record-mode readings (several pages): the punch list covers the page currently being viewed.

## Success

- Exporting a punch list from a real reading of one of the user's sites gives a list a person can act on without opening the report.
- Handing that file to Claude Code in the site's repo, Claude can fix items and run the recheck itself until the list is clear or only Deploy items remain.
- Two recordings of an unchanged page give identical IDs and a recheck of "0 fixed, all still there, 0 new".

## Left to the builder

File and function names, hash length, the machine-readable block's exact form, places cap, wording of Expected lines (outcome-shaped, one sentence), how calibrate's capture code is shared.
