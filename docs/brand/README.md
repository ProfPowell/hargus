# HARgus brand

HARgus is the product: the extension, the report and the CLI. A **reading** is what you take.
Readings are saved as **HAR-PLUS** files, the open format, which keeps its name.

Argus, the giant of Greek myth, had a hundred eyes and never closed them all at once. HARgus watches
a page's whole HTTP conversation, its HAR, with every check it runs. The mark is an eye whose iris
is a request waterfall.

## Writing the name

- Always **HARgus**: capital HAR, lower-case gus, one word.
- Never "Hargus", "HARGUS", "HAR-gus" or "HARGus".
- In the wordmark, "HAR" is set in IBM Plex Mono 600 and "gus" in Instrument Sans 700. In running
  text, write the name in the surrounding font.
- Tagline: "A hundred eyes on every request."

Wordmark markup (no image needed, the fonts are bundled):

```html
<span class="wordmark"><b>HAR</b>gus</span>
```

```css
.wordmark { font-weight: 700; letter-spacing: -0.01em; }
.wordmark b { font-family: var(--mono); font-weight: 600; letter-spacing: -0.04em; }
```

## Files

| File | Use |
|---|---|
| `hargus-mark.svg` | Tile mark for 64 px and up |
| `hargus-mark-small.svg` | Tile mark for 20–48 px, e.g. the 24 px app-bar mark (heavier strokes) |
| `hargus-mark-16.svg` | Tile mark for 16 px and the 2× toolbar (heaviest strokes) |
| `hargus-mark-inverted.svg` | Paper tile for dark surfaces |
| `hargus-mark-open.svg` | No tile; the eye uses `currentColor`. Report header, print, slides |
| `icons/icon-16.png`, `icon-32.png` | Toolbar at 1× and 2×; from `hargus-mark-16.svg` |
| `icons/icon-48.png` | `chrome://extensions`; from `hargus-mark-small.svg` |
| `icons/icon-128.png` | Install dialog and Web Store; 96 px artwork with 16 px transparent padding, per Chrome's guideline |
| `icons/icon-512.png` | Large uses; full bleed |
| `tokens.css` | New values for the tokens in `extension/ui/theme.css`, plus `@font-face` |
| `fonts/` | Instrument Sans (variable, 400–700) and IBM Plex Mono 400/500/600, Latin subsets, woff2; OFL licences included |

The icon PNGs replace `extension/icons/*.png` file for file; the manifest paths do not change.

## Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| Night ink (`--text`, `--primary`) | `#101826` | `#dce3ec` | Text, primary buttons, the tile |
| Paper (`--bg`) | `#f5f6f4` | `#0b111c` | Page ground |
| Surface (`--panel`) | `#ffffff` | `#121a27` | Cards, header bars |
| Muted (`--muted`) | `#586170` | `#8b97a8` | Secondary text |
| Teal (`--accent`) | `#0a7c71` | `#3ad3c1` | Links, focus, selection, progress, the waterfall bars |

Rules:

- **Teal marks what you can click.** It is never a grade.
- **Grade colours stay exactly as they are in `theme.css` today** (`--st-*`, `--ink-*`, `--band-*`).
  The toolbar badge uses the same status colours.
- The single primary button on a screen is night ink, inverted in dark mode (`--primary`, `--primary-ink`).
- Mark bars: `#3ad3c1` on the ink tile, `#0a7c71` on the paper tile.

## Type

- **Instrument Sans** 400–700 for the interface and report prose.
- **IBM Plex Mono** 400/500/600 for URLs, numbers, headers, code and the HAR in the wordmark.
- Both ship inside the extension (no font requests at run time). Characters outside the bundled
  Latin subsets fall back to the system fonts.

## Mockups

See `docs/superpowers/mockups/2026-10-11-hargus/`: static HTML (open in a browser) and PNG renders
of each popup state, the Options page and this brand sheet.
