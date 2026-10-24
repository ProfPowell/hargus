# HARgus

HARgus takes a **reading** of any web page. Readings are saved as **HAR-PLUS** files, the open format
behind it, which keeps its name. Point HARgus at a page and it records the full HTTP conversation (HAR),
screenshots, and runs a stack of plugins that read the page, analyze the traffic and look things up —
metadata, Web Vitals, accessibility, tech stack, security headers and TLS, DNS, WHOIS, IP and
hosting, exposure, well-known files and more. Readings are searchable and exportable.

A reading is a valid **HAR 1.2** file with one extra field, `log._harplus`, so it still opens in
Chrome DevTools or any HAR viewer. That is the whole idea: HAR is the conversation; HAR-PLUS is
the conversation plus everything you learned about it.

```
extension/   Chrome extension (MV3): capture, plugins, popup, viewer — no build step, no dependencies
cli/         Node CLI: turn any HAR file into HAR-PLUS with the same plugins
examples/    Remote plugin example (Lighthouse over HTTP)
docs/        FORMAT (the file format), PLUGINS (authoring), ARCHITECTURE (how it fits together)
test/        node:test unit tests + Playwright end-to-end test
```

## Install (unpacked)

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → choose the `extension/` folder.
3. Pin **HARgus** to the toolbar.

axe-core is bundled and the **axe-core audit** plugin is on by default. `sh scripts/vendor-axe.sh [version]` upgrades the bundled copy.

## Take a reading

Open a page, click the toolbar button (or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>):

| Mode | What happens | Use it for |
|---|---|---|
| **Take reading** | Reloads the page and records everything until the network goes idle, scrolls to trigger lazy content, then captures | The normal case |
| **Record** | Records from now until you press Stop — across navigations | Multi-page flows, SPAs, checkout or login journeys |
| **Snapshot** | No reload; rebuilds approximate traffic from Resource Timing | Pages you cannot reload (posted forms, fragile state) |

Capture options (popup or Options): desktop / mobile / tablet emulation, network + CPU throttling,
cache bypass, full-page screenshot, extra views (desktop / tablet / phone, no JavaScript / no CSS / no images), which response bodies to keep.

While capturing, Chrome shows a *"HARgus started debugging this browser"* bar — that is the
`chrome.debugger` API at work. It disappears when the reading is done.

## What's in a reading

The reading page groups plugins by purpose. "Leaves your machine?" says what each one sends where.

**How it's built** — for students of site composition

| Plugin | What it reads | Leaves your machine? |
|---|---|---|
| HTML composition | semantic vs. generic markup, landmarks, class conventions (BEM, utility-first, CSS Modules, CSS-in-JS), web components and shadow DOM, media, forms, inline styles/handlers, obsolete markup | no |
| CSS composition | every stylesheet parsed by the browser (incl. cross-origin and shadow roots): layers, nesting, container queries, specificity, `!important`, custom properties, palette, typography, framework signals | no |
| Technology stack | CMS, frameworks, servers, CDN, analytics, ads, marketing… built-in table plus the community Wappalyzer-format database (~7,600 technologies) | downloads the database from GitHub (weekly); nothing about the page |
| JavaScript & build | bundler/build fingerprints, modules, minification, legacy transpilation, public source maps, `eval`/`document.write`, compromised CDNs, platform API references | no |
| Platform features (Baseline) | every HTML/CSS/JS/HTTP feature detected, labelled Widely / Newly / Limited available (W3C web-features) | downloads web-features data (weekly); nothing about the page |

**Quality, performance & accessibility**

| Plugin | What it reads | Leaves your machine? |
|---|---|---|
| Page metadata | title, description, canonical, OG/Twitter, JSON-LD organization, outline, links, forms, social profiles, contacts | no |
| Web vitals | LCP, CLS, FCP, TTFB, blocking time, render-blocking resources | no |
| Accessibility basics | alt text, labels, names, lang, zoom, headings, landmarks | no |
| axe-core audit | full WCAG audit (bundled; includes needs-review results) | no |
| Network | weight, mix, hosts, protocols, compression, caching, errors, redirects | no |
| HTML validation | W3C Nu Html Checker errors and warnings | page HTML → validator.w3.org (or your own) |
| CSS validation | W3C CSS Validation Service on first-party stylesheets | CSS → jigsaw.w3.org (or your own) |
| PageSpeed Insights | Lighthouse scores + real-user Core Web Vitals (Chrome UX Report); needs a free Google API key | URL → Google, which loads the page |
| Images | sizes, formats, loading hints and savings measured by re-encoding | re-downloads up to 20 images from their own hosts (no page data sent elsewhere) |
| Link check | broken links, redirects, HTTPS → HTTP downgrades, Open Graph image size | requests every linked URL, on this site and elsewhere, from its own host (HEAD, then GET if HEAD fails; no cookies); private-network links are skipped |

The link check covers external links by default. To check only links on the page's own site, turn off
the Link check option "Also check external links". It checks up to 2,500 links by default; set "Most links to check"
to 0 for no limit.

**Security**

| Plugin | What it reads | Leaves your machine? |
|---|---|---|
| Security | HTTPS/HSTS, TLS certificate, security headers, CSP, cookie flags, mixed content, version disclosure | no |
| Mozilla Observatory *(off)* | security-header grade | hostname → Mozilla, which scans the site |
| Exposure (Shodan) | open ports, CVEs, tags for first-party IPs | IPs → internetdb.shodan.io |
| Reputation | AbuseIPDB, VirusTotal, GreyNoise (needs your keys) | IP/domain → those services |

**Infrastructure & intel**

| Plugin | What it reads | Leaves your machine? |
|---|---|---|
| DNS | A/AAAA, CNAME chain, NS, MX, TXT, CAA, DNSSEC, SPF/DMARC/DKIM/MTA-STS/BIMI, verified SaaS | hostname → DoH resolver |
| WHOIS (RDAP) | registrar, dates, status, registrant — RDAP, falling back to WHOIS for TLDs without it (e.g. `.edu`) | domain → rdap.org / registries; who-dat.as93.net fallback |
| IP & hosting | reverse DNS, ASN, netblock owner, location, hosting/CDN provider | IPs → DoH (Team Cymru), rdap.org, ipinfo.io |
| Well-known files | robots.txt + AI-crawler policy, security.txt, sitemap, ads.txt, llms.txt, app links, manifest | the site itself only |
| History & popularity | Wayback Machine first/last capture and change frequency, Tranco rank | hostname → web.archive.org, tranco-list.eu |
| CT subdomains *(off)* | hostnames from Certificate Transparency logs | domain → crt.sh |

**Sustainability**

| Plugin | What it reads | Leaves your machine? |
|---|---|---|
| Carbon | CO₂ per visit, estimated with the Sustainable Web Design Model v4 | hostnames → api.thegreenwebfoundation.org |

**International**

| Plugin | What it reads | Leaves your machine? |
|---|---|---|
| International | long text, right-to-left, logical CSS, lang and hreflang | no |

Every plugin returns three things: **data** (facts), a **summary** (the readout lines shown on the
dashboard) and **findings** (`high` / `medium` / `low` / `info`, tagged security, performance,
accessibility, seo, privacy, quality, infrastructure, intel, international or sustainability). Each result also records which
hosts it contacted.

### The report

The reading page opens on an **Overview**: a screenshot, a one-line summary, an overall score and a
card per area — Performance, Accessibility, Security, Build & content, Infrastructure,
International and Sustainability — each with a 0–100 score, a grade, key numbers and its worst
finding. Each area has its own page with charts
(Web Vitals meters, page-weight donut, header checklists, request path, domain lifetime…),
its findings and every plugin's detail. "How is this scored?" on each area page shows the arithmetic.

The **Screens** page lines the desktop, tablet and phone shots up at true relative size. Next to the
original it puts the page without JavaScript, without CSS and without images, with how much text and
how many links survive; the **Resilience** plugin turns that into findings, so a page that shows
almost nothing without JavaScript is flagged. An International section adds right-to-left and
long-text (pseudo-localized) views, which the **International** plugin checks for clipped text and
sideways scrolling.

**Export → Print or save as PDF** prints every page in order. **Export → Standalone HTML report**
saves a single `.html` file that opens anywhere without the extension. From the CLI:
`hargus summary reading.har --report report.html`.

## Review readings

The **Readings** page lists everything you captured (search, sort by issues, import HAR files).
A reading page has: the readout panel, screenshots, all findings with filters, each plugin's
detail, a network waterfall with request inspector, and notes/tags. Export as a full HAR-PLUS file,
a lighter shareable one (no bodies, thumbnail only), or a Markdown brief for tickets and CRM notes.
**Re-run analysis** applies newer plugins or settings to old readings without the live page.

## Command line

```sh
node cli/harplus.mjs analyze site.har           # any HAR (DevTools, Firefox, Safari, Playwright…) → site.plus.har
node cli/harplus.mjs analyze site.har --no-lookups --enable html-validate
node cli/harplus.mjs summary site.plus.har --md  # readout + findings as Markdown
node cli/harplus.mjs summary site.plus.har --report report.html  # standalone HTML report
node cli/harplus.mjs plugins
```

Keys come from `PAGESPEED_API_KEY`, `HARPLUS_IPINFO_TOKEN`, `ABUSEIPDB_KEY`, `VT_API_KEY`, `GREYNOISE_KEY`.
Page-phase plugins need the live page, so they only run in the extension. The CLI queries WHOIS
over port 43 directly; `--no-lookups` keeps everything (including the fingerprint download) offline.

## Extend it

- **In-repo plugin:** one ES module that default-exports `{ id, name, phase, run() }`, added to
  `extension/plugins/index.js`. It runs in the extension, the viewer and the CLI. See
  [docs/PLUGINS.md](docs/PLUGINS.md).
- **Remote plugin:** any HTTP endpoint, any language. Add it under Options → Remote plugins. The
  [Lighthouse example](examples/remote-lighthouse/) turns a reading's URL into Lighthouse scores
  and findings.

## Privacy and permissions

- `debugger` — records the network conversation and captures screenshots through the DevTools protocol.
- `<all_urls>` — lets lookup plugins call DoH, RDAP and similar services, and fetch the site's
  well-known files. Fetches are made **without your cookies**.
- Readings live in the extension's IndexedDB on your machine. API keys live in extension storage.
- Lookups can be turned off as a group (popup → Plugins) or per plugin.

## Writing the name

- Always **HARgus**: capital HAR, lower-case gus, one word.
- Never "Hargus", "HARGUS", "HAR-gus" or "HARGus".
- **HAR-PLUS** is the file format and keeps its name; HARgus is the product that reads and writes it.
- In the wordmark, "HAR" is set in IBM Plex Mono 600 and "gus" in Instrument Sans 700. In running
  text, write the name in the surrounding font. See [docs/brand/README.md](docs/brand/README.md).

## Tests

```sh
npm test            # unit tests: recorder, plugin host, every plugin against mocked services, CLI
npm run test:e2e    # loads the extension into Chromium via Playwright against a local test site
```

## Related tools and where the ideas came from

HARgus borrows liberally — use these alongside it, or wrap them as remote plugins:

- [web-check](https://github.com/Lissy93/web-check) — open-source all-in-one site OSINT (MIT); the WHOIS, Wayback and Tranco approaches here follow it.
- [who-dat](https://github.com/Lissy93/who-dat) — WHOIS/RDAP over HTTP, self-hostable; the WHOIS fallback.
- [webappanalyzer](https://github.com/enthec/webappanalyzer) — the community continuation of Wappalyzer's fingerprints (GPL-3.0, downloaded at runtime, not bundled). Commercial cousins: BuiltWith, Wappalyzer, WhatRuns, Netcraft site report.
- [web-features](https://github.com/web-platform-dx/web-features) / [Baseline](https://web.dev/baseline) — feature availability data (Apache-2.0).
- [Nu Html Checker](https://validator.github.io/validator/) and the [W3C CSS Validator](https://jigsaw.w3.org/css-validator/) — both self-hostable for private sites.
- [Project Wallace](https://www.projectwallace.com/) and CSS Stats — CSS analytics that inspired the CSS composition metrics.
- [webhint](https://webhint.io/), [Lighthouse](https://github.com/GoogleChrome/lighthouse), [Yellow Lab Tools](https://yellowlab.tools/), WebPageTest — deeper quality audits; good remote-plugin candidates.
- [Mozilla Observatory](https://developer.mozilla.org/en-US/observatory), SecurityHeaders, SSL Labs, [internet.nl](https://internet.nl/) — security and standards scanners.
- [urlscan.io](https://urlscan.io/), crt.sh, Shodan, DNSDumpster — recon services.

## Ideas

Readings over time (diff two readings of the same site), headless capture from the CLI via
Playwright, a runtime JavaScript API census (instrument the page before load to see which APIs
actually run — including fingerprinting), DevTools coverage (unused CSS/JS bytes), WebSocket frames,
Public Suffix List accuracy, company enrichment plugins for sales research, SSL Labs as a remote plugin.
