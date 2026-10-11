# HARgus architecture

## Flow of a reading

```
 popup / shortcut / harplus.capture()
            │
            ▼
 background.js (service worker)
            │  takeReading(tabId, options)
            ▼
 browser/capture.js — CaptureSession ──── chrome.debugger (DevTools protocol) ──── the tab
   attach → emulate (device, throttle, cache) → reload → wait for network idle → scroll
   → screenshots → collect page info → probes + page-phase plugins (Runtime.evaluate)
            │  events                              ▲
            ▼                                      │ evaluate(fn, args, world)
 core/recorder.js — CDP events → HAR pages/entries, TLS per origin
            │
            ▼
 core/harplus.js — createReading()  ── detach ──
            │
            ▼
 core/plugin-host.js — runPlugins(phases: analyze, enrich)
            │            ctx.fetch / ctx.dns (DoH) / ctx.results …
            ▼
 browser/store.js — IndexedDB { readings, index }
            │
            ▼
 ui/library.html · ui/reading.html — browse, filter, inspect, re-run, export
```

The CLI starts at `core/harplus.js` (`ensureHarPlus` on any HAR file) and runs the same
`plugin-host` + plugins in Node.

## Layers

| Layer | Files | Depends on |
|---|---|---|
| Core (environment-neutral) | `core/har-util.js`, `core/recorder.js`, `core/harplus.js`, `core/plugin-host.js`, `core/doh.js` | nothing but `fetch`, `crypto`, `structuredClone` |
| Plugins | `plugins/*.js`, `plugins/kb/providers.js`, `plugins/tech-signatures.js` | core |
| Browser | `browser/capture.js`, `browser/store.js`, `browser/settings.js` | core, `chrome.*`, IndexedDB |
| Shells | `background.js`, `ui/*`, `cli/harplus.mjs` | everything above |

Things likely to change — what to check, which services to call, how results look — live in
plugins and knowledge-base tables. Things that should stay put — the format, the recorder, the
plugin contract — live in core. Adding a check never touches capture code.

## Decisions and trade-offs

**`chrome.debugger` for capture.** The alternatives were `chrome.devtools.network.getHAR()` (needs
DevTools open, only sees what happened after it opened) and `webRequest` (no bodies, no detailed
timings, no TLS details, no screenshots). The debugger gives a complete, DevTools-grade record —
redirect hops, raw headers including cookies, TLS certificates, response bodies, cross-site
iframes and workers via flat sessions — plus screenshots and device emulation. Cost: the
"started debugging this browser" bar during capture and a strong permission.

**Reload by default.** A HAR is only complete if recording starts before the document request.
Reload mode gives repeatable readings; Record handles flows; Snapshot covers pages that cannot be
reloaded, at reduced fidelity.

**Sensing vs. interpreting.** Page-phase plugins and probes collect raw data while the page is
live; analysis is pure functions over the stored reading. That is what makes **Re-run analysis**
and the CLI possible, and it keeps most plugin code testable in Node with fixtures.

**Plugins are bundled, or remote.** Manifest V3 forbids loading remote code into an extension.
Plugins therefore ship in the package (one module + one line in `plugins/index.js`) or run outside
it as HTTP endpoints. Remote plugins are the escape hatch for heavy or non-JS tools.

**Public, keyless lookups first.** DNS over HTTPS instead of a DNS library; RDAP instead of WHOIS
(port 43 is not reachable from a browser, and RDAP is structured JSON); Team Cymru's DNS interface
for IP→ASN; Shodan InternetDB for exposure. Keyed services (ipinfo token, AbuseIPDB, VirusTotal,
GreyNoise) are optional upgrades. Every result lists the hosts contacted.

**One JSON file per reading.** Screenshots are embedded as base64 so a reading is a single
portable file that any HAR tool accepts. That costs about a third more space than binary; the
"lite" export drops bodies and large screenshots for sharing.

**Reference data at runtime.** The community fingerprint database (GPL-3.0) and the web-features
dataset (Apache-2.0) are downloaded when first needed and cached for a week. HARgus ships only
the matchers, which keeps the repository's licence independent of the data's, and keeps the data
fresh. Without network access, the built-in signatures still work and Baseline reports an error.

**Let the browser parse.** The CSS plugin hands every stylesheet — including cross-origin ones,
from recorded bodies, via constructable stylesheets — to the browser's own CSS parser instead of
shipping a parser. What it counts is exactly what the browser understood.

**IndexedDB, no wrapper.** Two object stores: full readings and a small index for the library
list (with thumbnail and finding counts), so the list stays fast with hundreds of readings.

**No build, no dependencies.** ES modules load directly in the service worker, extension pages
and Node. The UI is HTML, CSS (`@layer`, `light-dark()`, popover, `<dialog>`) and small modules.
The only optional third-party code is axe-core, downloaded on request.

## Known limits

- Registrable domains use a built-in list of common multi-part suffixes, not the full Public Suffix List.
- Full-page screenshots of very tall pages are truncated at 20,000 CSS px; sticky headers repeat.
- In-page metrics are a single local load (lab data), not field data.
- WebSocket frames, EventSource streams and service-worker-internal fetches are not recorded yet.
- In Record mode, page titles for pages you leave within a fraction of a second may fall back to the URL.
- JavaScript API references are string matches in script source, not observed calls.
- The W3C CSS validator lags the newest CSS; some modern syntax is reported as errors.
- Closed shadow roots are invisible to the HTML and CSS plugins.
