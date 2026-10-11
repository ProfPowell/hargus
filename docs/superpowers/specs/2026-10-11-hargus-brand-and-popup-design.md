# HARgus: rename, brand, popup, presets and Options — design

**Status:** approved in conversation on 2026-10-11 (design canvas reviewed). This spec is waiting for review.

## Goal

The extension has outgrown its name. HAR-PLUS is the file format; what the extension does now is
take a scored, explained reading of a site. This change:

1. **Renames the product HARgus.** The file format stays HAR-PLUS, and a reading stays a reading.
2. **Applies a brand:** mark, wordmark, palette and bundled fonts.
3. **Rebuilds the popup** around one action:
   - a reading-type switch;
   - one Setup line that names a preset;
   - the site's last reading;
   - a progress view and a result view.
4. **Adds presets:** Quick check, Check-up, Deep dive and Private. They replace the 17 view checkboxes
   and 35 plugin checkboxes the popup shows today.
5. **Reorganises Options:** a section menu, preset cards, views grouped by purpose, and a checks summary.
6. **Shows the last grade on the toolbar icon** for the site in the active tab.

## References

- **Mockups:** `docs/superpowers/mockups/2026-10-11-hargus/`.
  - `popup-ready`, `popup-setup`, `popup-working`, `popup-done`, `options`, `brand`.
  - Each comes as `.html` (open it in a browser and read the markup) and `.png`.
  - Their inline styles are the visual reference. Build them with `theme.css` tokens and classes, not inline styles.
  - The numbers in the mockups illustrate; real counts and times are computed (see §4 and §5).
- **Brand assets and rules:** `docs/brand/README.md`, `docs/brand/tokens.css`, `docs/brand/*.svg`, `docs/brand/icons/`, `docs/brand/fonts/`.
- **Design canvas** (owner access only): https://claude.ai/artifact/7ts6skZCMYT8HiiidwGAq8

## Decisions made in conversation

| Topic | Decision |
|---|---|
| Product name | **HARgus**, written exactly so. HAR-PLUS remains the format name. |
| Rejected names | Plumb (name and mark), Vor, Datum, SiteDx, Tarsi. Argus, Surveyor and Assay were ruled out by clashes, and Mimir by Grafana Mimir. |
| Mark | An eye whose iris is a three-bar request waterfall, on a night-ink tile. |
| Palette | Night ink and paper. Teal (the current accent, darkened for contrast) marks interactive elements. Grade colours are unchanged. |
| Type | Instrument Sans and IBM Plex Mono, bundled. |
| Popup | One primary action. A Reload / As it is / Journey switch drives its label. One Setup line names a preset. |
| Presets | Quick check, Check-up (default), Deep dive, Private. The user's own words "check-up" and "deep dive" became preset names. |
| Shortcut | Stays Alt+Shift+H. |
| Toolbar | Badge text shows the last grade for the tab's site. Progress codes take over while a reading runs. |

## Constraints

- No build step and no runtime dependencies (unchanged rule).
- **Existing readings and settings must keep working.** These identifiers do **not** change:
  - IndexedDB name `harplus` and its stores;
  - `chrome.storage` keys;
  - runtime message types `harplus:*`;
  - the format block `log._harplus`;
  - `data-harplus-*` attributes;
  - the Cache Storage name `harplus-reference-data`;
  - the `harplus-analysis:*` lock names;
  - the plugin and remote-plugin contracts;
  - the `.plus.har` extension.
- Every interpolated value still goes through the escaping `html` tag.
- The popup stays at 360 px wide and at most 600 px tall (Chrome's popup limit).
- The interface is accessible as drawn:
  - real buttons, inputs and labels;
  - the segmented controls are a `role="group"` with a label, holding buttons with `aria-pressed`;
  - controls are at least 40 px tall;
  - focus shows as a visible teal ring;
  - status changes are announced through the existing `aria-live` output.
- Text meets 4.5:1 contrast. The tokens in `docs/brand/tokens.css` meet it in both modes.
- No numbers are hard-coded in the interface (check counts, view counts, lookups, times). They are computed from the plugin list, the active preset and past readings.

## 1. Naming

| Where | Now | Becomes |
|---|---|---|
| `manifest.json` `name`, `short_name` | HAR-PLUS, HAR+ | HARgus, HARgus |
| `manifest.json` `description` | "A tricorder for web pages…" | "Take a reading of any web page: what it’s built with, how it scores, and what to fix first. Saves the full HTTP conversation as HAR-PLUS." |
| `action.default_title` | HAR-PLUS — take a reading | HARgus — take a reading |
| `chrome.action.setTitle` prefix in `background.js` | `HAR-PLUS — ` | `HARgus — ` |
| Page titles (popup, library, reading, options) | `… — HAR-PLUS` | `… — HARgus` |
| App-bar brand markup (popup, library, reading, options, `report.js` export) | `<img> HAR<small>+</small>` | inline mark SVG + wordmark (see §2) |
| `report.js` export `<title>` / `<meta name="generator">` | `… — HAR-PLUS report` / HAR-PLUS | `… — HARgus report` / HARgus |
| `core/harplus.js` `CREATOR.name` (HAR `log.creator`) | HAR-PLUS | HARgus. `_harplus.version` is unchanged. |
| `plugins/vitals.js` note | "before HAR-PLUS scrolled the page" | "before HARgus scrolled the page" |
| `browser/store.js` blocked-upgrade message | "another open HAR-PLUS page … HAR-PLUS tabs" | "another open HARgus page … HARgus tabs" |
| `background.js` console helper | `globalThis.harplus` | keep it, and add `globalThis.hargus` as the same object |
| `package.json` | `name: har-plus`, `bin: { harplus }` | `name: hargus`, `bin: { hargus, harplus }`, both pointing at `cli/harplus.mjs` (the file name stays) |
| CLI usage text | `harplus …` | `hargus …`, with a note that `harplus` still works |
| Reading-page export menu | "HAR-PLUS file (everything)" | unchanged: this names the format |
| README, `docs/*.md` | product called HAR-PLUS | product called HARgus. The format sections keep HAR-PLUS. Add the "Writing the name" rule from `docs/brand/README.md`. |
| `docs/FORMAT.md` creator example | `"name": "HAR-PLUS"` | `"name": "HARgus"`, plus one line: readers must not rely on `creator.name` |

Comments that describe the format keep "HAR-PLUS". Comments that describe the tool say "HARgus".

## 2. Brand

- **Icons:** copy `docs/brand/icons/icon-{16,32,48,128,512}.png` over `extension/icons/`. Manifest paths do not change.
- **Fonts:** copy `docs/brand/fonts/*.woff2` to `extension/ui/fonts/`, plus both OFL licence files.
  - Put the `@font-face` rules from `docs/brand/tokens.css` at the top of `theme.css`, before `@layer`.
  - No network font requests.
- **Tokens:**
  - In `theme.css` `@layer tokens`, replace the values of `--bg`, `--panel`, `--panel-2`, `--line`, `--text`, `--muted`, `--accent`, `--accent-soft`, `--accent-ink`, `--font` and `--mono` with those in `tokens.css`.
  - Add `--accent-hover`, `--primary`, `--primary-ink`, `--segment`, `--radius-lg` and the three `--mark-*` tokens.
  - **Do not touch** `--st-*`, `--ink-*`, `--band-*`, `--track`, `--c1`…`--c8`, `--high`, `--medium`, `--low`, `--info`, `--ok` or `--amber`.
- **Buttons:** `.btn.primary` uses `--primary` / `--primary-ink`. Links and focus rings use `--accent`. Hover uses `--accent-hover`.
- **App-bar brand**, shared by every page:

  ```html
  <a class="brand" href="library.html">
    <svg class="mark" viewBox="0 0 32 32" width="24" height="24" aria-hidden="true">…hargus-mark-small.svg paths…</svg>
    <span class="wordmark"><b>HAR</b>gus</span>
  </a>
  ```

  - Inline the SVG, so it inherits nothing and needs no request.
  - In the popup the brand is a `<span>`, not a link.
  - Library and Options add a page name after the wordmark in `--muted`: "Readings", "Options".
- **Report export** (`report.js`): the same brand markup, using the open mark (`hargus-mark-open.svg`, `currentColor`) so it prints well.
- The library and reading pages change only their brand, fonts and colours through the tokens. Their layout does not change in this work.

## 3. Presets

### Model

A new pure module, `extension/core/presets.js`, is used by the popup, Options, the service worker and the reading tab.

```js
export const PRESET_ORDER = ['quick', 'checkup', 'deep', 'private'];
export const DEFAULT_PRESETS = {
  quick:   { label: 'Quick check', views: [], lookups: false },
  checkup: { label: 'Check-up', views: ['desktop', 'mobile', 'nojs', 'nocss'], lookups: true },
  deep:    { label: 'Deep dive', views: ALL_VIEW_TOGGLES, lookups: true },
  private: { label: 'Private', views: ['desktop', 'mobile', 'nojs', 'nocss'], lookups: false },
};
```

- **View toggles** are the 17 user-facing switches:
  - `desktop`, `tablet`, `mobile`, `breakpoints`;
  - `nojs`, `nocss`, `noimages`;
  - `vision`, `forced`, `morecontrast`, `dark`, `spacing`, `reflow`, `text200`;
  - `rtl`, `pseudo`;
  - `print`.

  `vision` expands to `vision` plus the six simulation keys (`protanopia` … `lowcontrast`) when building `capture.views`.
- **Settings:** `DEFAULTS` gains `presets: DEFAULT_PRESETS` and `preset: 'checkup'`. Users can edit `views` and `lookups` on any preset and rename it.
  - "New preset" adds `custom-N`, copied from the selected one.
  - Built-in presets can be reset to their defaults but not deleted.
- **Migration:** on the first `getSettings()` that finds no `presets` key, defaults are written.
  - If the stored `capture.views` differs from the old all-on default, the user changed it. Their selection becomes a preset `custom-1` labelled "My views" (lookups on), and that preset is active.
  - Otherwise `checkup` is active.
  - `capture.views` is then ignored, apart from that migration.

### Resolution (pure functions)

- `activePreset(settings)` returns `{ id, label, views, lookups }`. It falls back to `checkup` when the id is unknown.
- `captureOptions(settings)` returns `{ ...settings.capture, views: { [key]: boolean } }` built from the active preset, plus `preset: { id, label, lookups }`.
- `pluginRunsOffline(plugin)` is true when `!plugin.disclosure || plugin.offlineOptions`.
- `presetPlugins(plugins, settings, preset)` lists the plugins enabled in settings. When `preset.lookups === false`, only those for which `pluginRunsOffline` is true are kept. A plugin that runs offline because of `offlineOptions` has those options merged over its own for this run.
- `presetSummary(plugins, settings, preset)` returns `{ views, checks, lookups, offline }`. The popup, the Setup panel and the Options cards all read their counts from this.

### Plugins

- `tech` gains `offlineOptions: { fingerprintDb: false }`, so Quick check and Private still detect the stack from the built-in signatures.
- Every other plugin with a `disclosure` is skipped when lookups are off. That includes `baseline`, which needs its downloaded data.
- `docs/PLUGINS.md` documents `offlineOptions`.

### Format

- `_harplus.capture.preset = { id, label, lookups }` is recorded on every new reading. Document it in `docs/FORMAT.md`.
- The reading tab's analysis honours `preset.lookups` from the reading, not the current settings. "Re-run analysis" does the same. A reading taken as Private never contacts an outside service later, even if the user's preset has changed since.
- Older readings have no `preset` and behave as today.

### Time estimates

- `indexRecord` adds `preset` (the id) and `durationMs` (`_harplus.capture.durationMs`).
- `estimateMs(records, presetId)` is the median `durationMs` of the last five index records with that preset.
- Where the mockups show "≈ 25 s", show the estimate, rounded to 5 s, or nothing when there is no history. Never show a guessed constant.

## 4. Popup

One page, `ui/popup.html`, with four sections toggled with the `hidden` attribute: `#ready`, `#setup`, `#working` and `#done`. No new HTML files. Mockups: `popup-*.png`.

The popup's current "Capture options" and "Plugins" sections, and the separate Record and Snapshot buttons, are removed. Their settings live in Setup (preset, device, network, scoring profile) and in Options (everything else).

### Header (all views)

- **Ready:** brand (mark and wordmark), then a "Readings" text button (opens `library.html` in a tab) and an icon-only Options button (`aria-label="Options"`, opens the options page).
- **Setup:** a back button and the title "Setup", with the host on the right in `--mono` and `--muted`.
- **Working and done:** brand, with the host on the right.

### Ready

1. **Site:**
   - the tab's favicon (`tab.favIconUrl`, 40 px rounded tile), falling back to the first two letters of the host on `--panel-2`;
   - the page title, on one line with an ellipsis;
   - the host in `--mono`.
2. **Last reading:** a card shown when the index has a reading whose `host` equals the tab's host. It holds:
   - a grade tile (letter and score, coloured with `--band-*` and `--ink-*` by status);
   - "Last reading: {relative time}";
   - "{n} findings · scored as {profile label}";
   - an "Open" link to `reading.html?id=…`.

   With no match, show one muted line instead: "No readings of this site yet."
3. **Reading type** (label above a three-button segmented control). The choice persists to `settings.capture.mode`.

   | Button | `mode` | Primary label | Help line |
   |---|---|---|---|
   | Reload | `reload` | Take a reading | Reloads the page and records everything from the first request. The most complete reading. |
   | As it is | `snapshot` | Read as it is | No reload. Keeps form input and sign-in state. Network detail is rebuilt, so it is approximate. |
   | Journey | `record` | Start recording | Records every page you visit until you press Stop. For sign-ups, checkouts and other flows. |

4. **Primary button:** full width, 52 px, `--primary`, with the label from the table.
   - When an estimate exists, the time follows the label in `--mono` at lower contrast.
   - Journey shows a red dot before the label (recording is the one red outside grades).
5. **Setup line:** a full-width button that opens `#setup`. It shows:
   - "Setup: {preset label}";
   - "{Device} · {n} views · {m} checks · {profile label}";
   - "{k} checks contact outside services ↗", or "Nothing leaves this machine" when lookups are off.
6. **Footer:** the actual shortcut, from `chrome.commands.getAll()` for `take-reading`, rendered as `<kbd>` keys plus "takes a reading of any tab". It is hidden when no shortcut is set.

**Blocked pages** (the existing `BLOCKED` regex) replace items 2–5 with the existing message. The Setup line stays available.

### Setup

- **Preset:** a radio list (`fieldset`/`legend`), one card per preset in `PRESET_ORDER`, then custom presets.
  - Each card shows the label, the estimate, and a summary from `presetSummary`, e.g. "4 views · 32 checks · lookups on ↗".
  - The selected card has a 2 px `--accent` border.
- **Read as:** a segmented control (Desktop / Tablet / Phone) bound to `settings.capture.device` (`desktop` | `tablet` | `mobile`).
- **Network:** a select (Full speed / Slow 4G, 4× CPU / 3G, 4× CPU) bound to `settings.capture.throttle`.
- **Score as:** a select of the `PROFILES` labels, plus Custom when one is defined, bound to `settings.scoring.profile`.
- **Link:** "Edit presets, views and checks in Options ↗" opens `options.html#presets`.
- Changes save at once (as today). Back returns to `#ready` with the Setup line updated.

### Working

Shown while the tab is busy, in place of `#ready`, including when the popup is reopened mid-reading.

- **Title and timer:** "Taking a reading" with elapsed time (`formatElapsed`), updated each second.
- **Progress bar:** steps done ÷ steps expected, with `role="progressbar"`.
  - Expected steps are `loading`, `scrolling` (if `scroll`), `collecting`, `screenshot`, `bodies`, `sensing`, `views` (if any views), `saving` and `analyzing`.
- **Step list:** an `<ol>` built from `status.steps` (`addStep`) using `STAGES` labels.
  - Done steps show a check icon (text alternative "Done") and their duration.
  - The current step is highlighted in `--accent-soft`; for views it shows "{n} of {N}".
  - Steps not yet reached show a hollow circle (text alternative "Waiting").
  - The lookups step reads "Lookups ↗" with the number of services, or "Lookups skipped" when the preset is offline.
- **Note:** "You can close this popup. The reading keeps going and the report opens when it is done."
- **Buttons:**
  - **Stop:** in record mode, sends the existing `harplus:record-stop`. In reload and snapshot modes, sends a new `harplus:cancel`, which calls `discard(tabId)`, clears the status, resets the badge and **reloads the tab if the `views` stage had started**. Views change the page in place; for example, no-CSS removes styles until a reload.
  - **Watch in a tab:** focuses the progress tab, as the current "Show" link does.

### Done

Shown when a `harplus:progress` message with stage `done` arrives for this tab while the popup is open. It is also shown on open when the tab's latest reading finished less than 2 minutes ago and has not been dismissed.

- **Grade tile:** 64 px, letter and score. Beside it the status word ("Needs work") and "{n} findings · {duration} · scored as {profile}".
- **Area bars:** all eight areas from `scoreReading(reading, plugins, { profile })` in two columns. Each shows its label, score and a 4 px bar coloured by status.
- **Fix these first:** `topFindings(scores, 3)`, with a severity icon (with a text alternative) and the title. Paths and URLs are set in `--mono` and may break anywhere.
- **Buttons:** "Again" returns to `#ready`; "Open the report" (primary) focuses or opens the reading tab.

## 5. Toolbar badge

- A new pure helper, `core/badge.js`, exports `gradeBadge(record)`. It returns:
  - `text`: the grade exactly as `grade()` returns it, e.g. "C" or "D−" with U+2212 (at most 2 characters);
  - `color`: the `--st-*` value for `record.status`: good `#0ca30c`, warning `#fab219`, serious `#ec835a`, critical `#d03b3b`. Status `none` (no score) clears the badge;
  - `textColor`: `#101826`, or `#ffffff` for critical;
  - `title`: `HARgus — last reading {grade} ({score}) · {relative date}`.
- `store.js` gains `latestForHost(host)`: the newest index record with that `host`, or `null`.
- The service worker updates the badge for a tab:
  - on `chrome.tabs.onActivated`;
  - on `chrome.tabs.onUpdated` (`status === 'complete'` or a URL change);
  - after `done`;
  - after the reading tab reports analysis complete;
  - after a reading is deleted (library or Options).

  While a capture or recording runs, the existing progress codes win. With no record, the badge text is cleared.
- Badge text colour uses `chrome.action.setBadgeTextColor` (Chrome 110+; the manifest already requires 125).
- A setting `ui.gradeBadge` (default `true`), in Options under "Your data", turns the grade badge off. Progress codes are unaffected.
- The lookup is local only (IndexedDB). Nothing is sent anywhere.

## 6. Options

Mockup: `options.png`. The page becomes a two-column layout: a section menu, then the content, `flex-wrap` so the menu stacks on narrow windows. The menu is not sticky.

| Section | Holds (old place) |
|---|---|
| **Presets** | Four built-in preset cards (label, Default tag on the active one, device, view count, check count, lookups or "Nothing leaves this machine", estimate), custom presets, and "New preset". Clicking a card selects it for editing below, and it can be made the default (`settings.preset`). |
| **Views** | "Views in {preset}": the 17 toggles in five groups, each with a one-line description (exact copy in the mockup). Devices: desktop, tablet, phone, breakpoint edges. Resilience: no JS, no CSS, no images. Accessibility: vision simulations, forced colours, more contrast, dark mode, text spacing, 320 px reflow, 200% text. International: right-to-left, long text. Output: print. Replaces "Capture defaults → Views". |
| **Checks** | Three counts (on this machine, lookups ↗, off, with names) and the existing per-plugin list behind "Choose checks". Checks are global, not per preset. The line under the heading says Quick check and Private skip the lookups. Replaces "Plugins". |
| **Scoring** | Unchanged content. |
| **Capture** | The rest of "Capture defaults": response bodies, max body size, network idle, max wait, full-page screenshot, scroll for lazy content, focus-style check, bypass cache, and the DoH resolver. "Mode" and "Device" move to the popup (still saved in the same settings). |
| **Services and keys** | API keys (unchanged). |
| **Remote checks** | Remote plugins (unchanged content, renamed heading). |
| **Your data** | Usage, "Open reading when done", "Show the last grade on the toolbar icon", "Delete all readings". |

Each section has an `id` matching its menu link, so the popup can deep-link to `options.html#presets`.

## 7. Testing

- **`test/presets.test.mjs`:**
  - defaults;
  - `vision` expansion;
  - `captureOptions` views map;
  - offline filtering (a plugin with `disclosure` is skipped; `tech` runs with `fingerprintDb: false`);
  - `presetSummary` counts against the real plugin list;
  - unknown id falls back to Check-up;
  - migration: unchanged views give Check-up; changed views give "My views";
  - `estimateMs` median, last five, by preset.
- **`test/badge.test.mjs`:** `gradeBadge` for each status, plus/minus grades, missing record.
- **`test/core.test.mjs`:**
  - `indexRecord` includes `preset` and `durationMs`;
  - `CREATOR.name === 'HARgus'`;
  - a reading with `preset.lookups === false` runs no plugin with a `disclosure` in `runPlugins`, apart from those with `offlineOptions`.
- **Existing tests** that assert "HAR-PLUS report" (`report.test.mjs`) and the vitals note (`vitals.test.mjs`) change to HARgus.
- **E2E** (`test/e2e/run.mjs`):
  - **Popup:** shows the wordmark; switching to "As it is" changes the primary label to "Read as it is"; the Setup line opens `#setup` and lists four presets.
  - **Quick check reading** of the test site: no views captured, and no plugin result lists a contacted host other than the test server.
  - **Badge:** after a reading, `chrome.action.getBadgeText({ tabId })` equals the reading's grade.
  - **Options:** has eight sections, five view groups and the Presets cards.
  - **Older reading:** a reading saved before this change (fixture) still opens and scores.
- **Visual check:** compare the popup and Options against the mockup PNGs at 1× and 2×, in light and dark mode.

## Out of scope

- Redesigning the reading report or library beyond brand, fonts and colours.
- Renaming storage, message types, the CLI file or the format.
- Chrome Web Store listing copy and screenshots.
- Domain and trademark registration for "HARgus".
- Switching the toolbar icon for dark browser themes (Chrome offers no `theme_icons`).
