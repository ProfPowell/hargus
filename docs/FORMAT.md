# HAR-PLUS format (v0.1)

A HAR-PLUS file is a [HAR 1.2](http://www.softwareishard.com/blog/har-12-spec/) document. HAR allows
custom fields whose names begin with an underscore; HAR-PLUS uses exactly one at the log level,
`log._harplus`, plus a handful of per-entry fields (mostly the same ones Chrome DevTools writes).
Any HAR tool can open a HAR-PLUS file; tools that know HAR-PLUS get the rest.

```jsonc
{
  "log": {
    "version": "1.2",
    "creator": { "name": "HAR-PLUS", "version": "0.1.0" },
    "browser": { "name": "Chrome", "version": "141.0.0.0" },
    "pages":   [ /* HAR pages; one per main-frame navigation */ ],
    "entries": [ /* HAR entries */ ],
    "_harplus": { /* see below */ }
  }
}
```

## `log._harplus`

| Field | Type | Meaning |
|---|---|---|
| `version` | string | HAR-PLUS format version (`"0.1"`) |
| `id` | string | UUID of the reading |
| `capturedAt` | ISO date | when the reading was taken (or the HAR's first page for imports) |
| `importedAt` | ISO date | present when a plain HAR was upgraded |
| `target` | object | what was read — see below |
| `capture` | object | how it was read — see below |
| `screenshots` | array | captured images — see below |
| `probes` | object | raw in-page data collected for non-page plugins, keyed by plugin id (`_contacted` lists hosts contacted while preparing the probe) |
| `plugins` | object | plugin results keyed by plugin id — see below |
| `tags` | string[] | user tags |
| `notes` | string | user notes |
| `stripped` | object | present on shared copies: `{ screenshots, bodies }` |

### `target`

```jsonc
{
  "url": "http://example.com/",        // where the capture started
  "finalUrl": "https://www.example.com/", // the page that was read (end of redirects / last page recorded)
  "host": "www.example.com",
  "origin": "https://www.example.com",
  "domain": "example.com",              // ICANN registrable domain (WHOIS / DNS apex)
  "site": "example.com",                // first-party boundary (treats github.io, vercel.app… as suffixes)
  "title": "Example Domain"
}
```

### `capture`

`mode` (`reload` | `snapshot` | `record` | `import`), `device` (`desktop` | `mobile` | `tablet`),
`throttle`, `bypassCache`, `bodies` (`none` | `document` | `text` | `all`), `maxBodyKB`, `scroll`,
`fullPage`, `userAgent`, `viewport` `{ width, height, dpr }`, `startedAt`, `durationMs`,
`viewsMs` (time spent on views, not included in `durationMs`), `reachedIdle`, `timeline` `[{ stage, ms }]`, `childTargets` (cross-site iframes/workers recorded),
`warnings` (string[]),
`views` (per-view measurements, see below), `viewsSkipped` (`[{ view, reason }]`),
`source` and `fileName` (imports), and `tls`:

```jsonc
"tls": {
  "https://www.example.com": {
    "protocol": "TLS 1.3", "keyExchangeGroup": "X25519", "cipher": "AES_128_GCM",
    "subjectName": "www.example.com", "issuer": "R11",
    "validFrom": "2026-08-01T00:00:00.000Z", "validTo": "2026-10-30T00:00:00.000Z",
    "sanList": ["www.example.com", "example.com"], "sanCount": 2, "sctCount": 2,
    "ctCompliance": "compliant", "ip": "93.184.215.14", "httpProtocol": "h2"
  }
}
```

One record per origin, first connection seen.

### `screenshots`

```jsonc
{ "kind": "viewport" | "fullpage" | "thumbnail", "view": "desktop", "mimeType": "image/webp", "encoding": "base64",
  "data": "…", "cssWidth": 1280, "cssHeight": 800, "dpr": 2, "scale": 1, "truncated": false }
```

Full-page shots are capped at 20,000 CSS px tall and scaled to stay under WebP's 16,383 px limit.

`view` is one of `desktop`, `tablet`, `mobile` (devices, captured in place by resizing the viewport) or
`nojs`, `nocss`, `noimages` (the page without scripts, styles or images) or
`rtl` (`dir="rtl"` on `<html>`) and `pseudo` (text pseudo-localized: accented and about 40 % longer). Shots without `view`
(older readings) belong to the capture device's view. The thumbnail is of the capture device only.
The no-JS view disables scripts in the top document only, so cross-site iframes still run their own scripts.

### `capture.views`

What a reader can see in each view, measured in the page:

```jsonc
"views": {
  "desktop": { "cssWidth": 1280, "cssHeight": 6420, "text": 18234, "links": 142, "images": 38, "imagesWithAlt": 31, "noscript": false,
               "overflowX": 0, "clipped": 2, "rtlChars": 0, "rtlUnmarked": 0, "dir": "ltr" },
  "nojs":    { "cssWidth": 1280, "cssHeight": 900,  "text": 412,   "links": 3,   "images": 0,  "imagesWithAlt": 0,  "noscript": true,
               "overflowX": 0, "clipped": 0, "rtlChars": 0, "rtlUnmarked": 0, "dir": "ltr" }
}
```

`text` is the length of the visible text (whitespace collapsed), `links` and `images` count rendered
elements, `imagesWithAlt` counts images with an `alt` attribute (including `alt=""`). The
**Resilience** plugin compares each view with the capture device's view. `noscript` is true when `<noscript>` content shows at least 200 characters of text (tracking pixels and one-line 'enable JavaScript' notices don't count).

`overflowX` is how many px the page is wider than the window; `clipped` counts text elements whose content is cut off by `overflow: hidden/clip` (or an ellipsis); `rtlChars` is the share of letters that are Hebrew or Arabic; `rtlUnmarked` is the share of letters that are Hebrew or Arabic and shown left-to-right; `dir` is the document direction. The **International** plugin compares the `rtl` and `pseudo` views with the capture device's view.

### `plugins[id]`

```jsonc
{
  "id": "dns", "name": "DNS", "version": "0.1.0", "phase": "enrich",
  "status": "ok" | "skipped" | "error",
  "error": "…",                     // reason when skipped / error
  "ranAt": "2026-10-08T16:40:00.000Z", "durationMs": 412,
  "data": { /* plugin-specific facts */ },
  "summary": [ { "label": "Mail", "value": "Google Workspace" } ],
  "findings": [
    {
      "severity": "high" | "medium" | "low" | "info",
      "category": "security" | "performance" | "accessibility" | "seo" | "privacy" | "quality" | "infrastructure" | "intel",
      "title": "No DMARC policy",
      "detail": "…",                // optional
      "evidence": "…",              // optional string or JSON
      "ref": "https://…",           // optional documentation link
      "id": "…"                     // optional stable id
    }
  ],
  "contacted": [ { "host": "cloudflare-dns.com", "count": 14 } ]
}
```

**Data** is facts, **summary** is the readout (short label/value strings), **findings** are
judgments. Keep them apart so readouts stay neutral and findings stay comparable across plugins.

## Entry fields

Standard HAR fields are filled from the DevTools protocol (`serverIPAddress`, `connection`,
`timings` with `dns`/`connect`/`ssl`/`send`/`wait`/`receive`, cookies parsed from the raw
`Cookie`/`Set-Cookie` headers). Custom fields:

| Field | Meaning |
|---|---|
| `_resourceType` | `document`, `script`, `stylesheet`, `image`, `font`, `fetch`, `xhr`, `media`, `ping`, `other`… |
| `response._transferSize` | bytes on the wire (headers + body) |
| `_priority` | Chrome's initial request priority |
| `_initiator` | `{ type, url, lineNumber }` |
| `_fromCache` | `memory` or `disk` |
| `_fromServiceWorker` | `true` when a service worker answered |
| `_remotePort` | server port |
| `_error` / `_canceled` | network error text / request was canceled |
| `_incomplete` | still in flight when capture ended |
| `_target` | `iframe` or `worker` when the request came from a cross-site iframe or worker target |
| `_synthetic` | built from Resource Timing (snapshot mode): no headers, approximate sizes |

`response.content.text` holds the body when captured (`encoding: "base64"` for binary).
Bodies are optional and controlled by `capture.bodies`.

## Compatibility

- Readers must ignore unknown fields in `_harplus` and in plugin `data`.
- Plain HAR files are upgraded by adding `_harplus` (see `ensureHarPlus` in `extension/core/harplus.js`).
- Additive changes bump the minor version; breaking changes bump the major version.
