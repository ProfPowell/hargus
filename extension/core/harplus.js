// HAR-PLUS document helpers: create, upgrade plain HAR, summarize, export.
// A reading is a valid HAR 1.2 log with one extra custom field: log._harplus (see docs/FORMAT.md).

import {
  registrableDomain, siteOf, hostOf, originOf, mainEntry, transferSize,
  formatBytes, SEVERITY_RANK, SEVERITIES,
} from './har-util.js';
import { scoreReading, resolveProfile } from './score.js';
import { activeFindings } from './supersede.js';
import { interstitialNotice } from './interstitial.js';

export const HARPLUS_VERSION = '0.1';
export const CREATOR = { name: 'HARgus', version: '0.1.0' };

export function makeTarget(url = '', title = '', finalUrl = url) {
  const host = hostOf(finalUrl);
  return {
    url, finalUrl, host,
    origin: originOf(finalUrl),
    domain: registrableDomain(host),  // ICANN registrable domain (WHOIS/DNS apex)
    site: siteOf(host),               // first-party boundary (treats github.io etc. as suffixes)
    title,
  };
}

export function createReading({ pages = [], entries = [], tls = {}, target, capture = {}, screenshots = [], browser }) {
  return {
    log: {
      version: '1.2',
      creator: { ...CREATOR },
      ...(browser ? { browser } : {}),
      pages,
      entries,
      _harplus: {
        version: HARPLUS_VERSION,
        id: crypto.randomUUID(),
        capturedAt: new Date().toISOString(),
        target,
        capture: { ...capture, tls },
        screenshots,
        plugins: {},
        tags: [],
        notes: '',
      },
    },
  };
}

/** Accept any HAR 1.2 file (DevTools, Firefox, Safari, Playwright…) and add a _harplus block. */
export function ensureHarPlus(har, { source = 'import', fileName } = {}) {
  if (!har?.log || !Array.isArray(har.log.entries)) throw new Error('Not a HAR file (missing log.entries)');
  const log = har.log;
  log.pages ||= [];
  if (log._harplus?.id) {
    log._harplus.plugins ||= {};
    log._harplus.screenshots ||= [];
    return har;
  }
  const now = new Date().toISOString();
  const page = log.pages[0];
  const firstDoc = log.entries.find((e) => e._resourceType === 'document' ||
    /html/.test(e.response?.content?.mimeType || '')) || log.entries[0];
  const url = firstDoc?.request?.url || (/^https?:/.test(page?.title || '') ? page.title : '');
  const title = page?.title && !/^https?:/.test(page.title) ? page.title : '';
  log._harplus = {
    version: HARPLUS_VERSION,
    id: crypto.randomUUID(),
    capturedAt: page?.startedDateTime || firstDoc?.startedDateTime || now,
    importedAt: now,
    target: makeTarget(url, title),
    capture: {
      mode: source,
      source: log.creator?.name ? `${log.creator.name} ${log.creator.version || ''}`.trim() : 'unknown',
      ...(fileName ? { fileName } : {}),
      tls: {},
    },
    screenshots: [],
    plugins: {},
    tags: [],
    notes: '',
  };
  const main = mainEntry(har);
  if (main) log._harplus.target = makeTarget(url, title, main.request.url);
  return har;
}

/** All findings across plugins, most severe first. */
export function findings(reading) {
  const out = [];
  const results = reading.log._harplus?.plugins || {};
  for (const r of Object.values(results)) {
    for (const f of activeFindings(r, results)) out.push({ ...f, plugin: r.id, pluginName: r.name });
  }
  return out.sort((a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) ||
    a.category.localeCompare(b.category));
}

/** A summary item's display value, with its rating when the plugin rated it. */
export const summaryValue = (s) => (s.rating ? `${s.value} (${s.rating.replace(/-/g, ' ')})` : s.value);

export function severityCounts(reading) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of findings(reading)) counts[f.severity]++;
  return counts;
}

/**
 * A data URL for a screenshot, or '' when it is not a plain base64 image. The URL ends up inside CSS (url(...)) and
 * HTML attributes of the standalone export, so a mimeType or data that could break out of either is refused.
 */
export function screenshotURL(shot) {
  if (!shot || !/^image\/(png|jpeg|webp)$/.test(String(shot.mimeType)) || !/^[A-Za-z0-9+/=]+$/.test(String(shot.data))) return '';
  return `data:${shot.mimeType};base64,${shot.data}`;
}

/** Lightweight record for the readings library list. */
export function indexRecord(reading, plugins = [], { profile } = {}) {
  const hp = reading.log._harplus;
  const shots = hp.screenshots || [];
  const overall = scoreReading(reading, plugins, { profile }).overall;
  const thumb = shots.find((s) => s.kind === 'thumbnail') || shots.find((s) => s.kind === 'viewport');
  return {
    id: hp.id,
    url: hp.target?.finalUrl || hp.target?.url || '',
    host: hp.target?.host || '',
    title: hp.target?.title || hp.target?.host || '(untitled)',
    capturedAt: hp.capturedAt,
    mode: hp.capture?.mode,
    device: hp.capture?.device,
    thumb: screenshotURL(thumb),
    counts: severityCounts(reading),
    score: overall.score,
    grade: overall.grade,
    status: overall.status,
    entries: reading.log.entries.length,
    bytes: reading.log.entries.reduce((s, e) => s + transferSize(e), 0),
    tags: hp.tags || [],
    notes: hp.notes || '',
    pending: hp.analysis === 'pending',
    profile: resolveProfile(profile).id,
  };
}

/** Copy for sharing: drop large screenshots and/or response bodies. */
export function stripForSharing(reading, { screenshots = 'thumbnail', bodies = false, console: cons = 'counts' } = {}) {
  const copy = structuredClone(reading);
  const hp = copy.log._harplus;
  if (screenshots === 'none') hp.screenshots = [];
  else if (screenshots === 'thumbnail') hp.screenshots = hp.screenshots.filter((s) => s.kind === 'thumbnail');
  if (!bodies) for (const e of copy.log.entries) { delete e.response.content.text; delete e.response.content.encoding; }
  if (cons === 'counts') {
    for (const e of hp.capture?.console?.entries || []) e.text = '';
    const pr = hp.plugins?.console;
    if (pr) {
      for (const f of pr.findings || []) delete f.detail;
      for (const e of pr.data?.entries || []) e.text = '';
    }
  }
  if (hp.analysis === 'pending') hp.analysis = 'done';
  if (hp.capture) delete hp.capture.viewsPending; // the patch lives in this browser's store, never in the export
  hp.stripped = { screenshots, bodies, console: cons };
  return copy;
}

/** Markdown brief: readout + findings. Handy for notes, tickets, CRM entries. */
const MD_PLACES = 10;

const oneLine = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : s);

/** A place as a sub-bullet. Console places keep only status and line: console text and URLs can carry user data. */
function placeLine(raw, consoleOnly = false) {
  const p = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, oneLine(v)]));
  const parts = consoleOnly
    ? [p.status, p.line != null ? `line ${p.line}` : '']
    : [
      [p.status, p.url].filter((x) => x != null && x !== '').join(' '),
      p.text ? `“${p.text}”` : '',
      p.region,
      p.line != null ? `line ${p.line}` : '',
      p.selector, p.file, p.note,
    ];
  const kept = parts.filter((x) => x != null && x !== '');
  return kept.length ? `  - ${kept.join(' · ')}` : null;
}

/** One finding as a Markdown bullet, with its places as indented sub-bullets (the brief and Copy as Markdown share it). */
export function issueMarkdown(f) {
  // Console details quote the page's own messages, which can carry user data: the brief keeps the titles only.
  const detail = f.plugin === 'console' ? '' : f.detail;
  const lines = [`- **${f.severity.toUpperCase()}** · ${f.category} · ${f.title}` +
    `${detail ? ` — ${detail}` : ''} _(${f.pluginName})_`];
  const places = (f.places || []).map((p) => placeLine(p, f.plugin === 'console')).filter(Boolean);
  lines.push(...places.slice(0, MD_PLACES));
  const more = places.length - MD_PLACES;
  if (more > 0) lines.push(`  - …and ${more} more place${more === 1 ? '' : 's'}`);
  return lines.join('\n');
}

export function toMarkdown(reading) {
  const hp = reading.log._harplus;
  const t = hp.target || {};
  const bytes = reading.log.entries.reduce((s, e) => s + transferSize(e), 0);
  const lines = [
    `# ${t.title || t.host}`,
    '',
    `<${t.finalUrl || t.url}>`,
    '',
    `Captured ${new Date(hp.capturedAt).toLocaleString()} · ${hp.capture?.mode || 'reading'} · ` +
      `${reading.log.entries.length} requests · ${formatBytes(bytes)}`,
    '',
  ];
  const notice = interstitialNotice(reading);
  if (notice) lines.push(`> ${notice}`, '');
  lines.push('## Readout');
  for (const r of Object.values(hp.plugins || {})) {
    if (!r.summary?.length) continue;
    lines.push('', `### ${r.name}`, ...r.summary.map((s) => `- **${s.label}:** ${summaryValue(s)}`));
  }
  const all = findings(reading);
  lines.push('', `## Findings (${all.length})`, '');
  for (const f of all) {
    lines.push(issueMarkdown(f));
  }
  if (hp.notes) lines.push('', '## Notes', '', hp.notes);
  if (hp.tags?.length) lines.push('', `Tags: ${hp.tags.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

/* ----------------------------------------------- snapshot-mode fallback */

const TYPE_BY_INITIATOR = {
  navigation: 'document', iframe: 'document', script: 'script', img: 'image', image: 'image',
  fetch: 'fetch', xmlhttprequest: 'xhr', video: 'media', audio: 'media', beacon: 'ping',
};

function guessType(url, initiatorType) {
  if (TYPE_BY_INITIATOR[initiatorType]) return TYPE_BY_INITIATOR[initiatorType];
  const path = url.split(/[?#]/)[0];
  if (/\.css$/i.test(path)) return 'stylesheet';
  if (/\.m?js$/i.test(path)) return 'script';
  if (/\.(woff2?|ttf|otf|eot)$/i.test(path)) return 'font';
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico)$/i.test(path)) return 'image';
  return 'other';
}

/**
 * Build approximate HAR entries from Resource Timing (no headers, no bodies).
 * Used when a reading is taken without reloading the page.
 */
export function entriesFromResourceTiming(list, { pageref = 'page_1', timeOrigin }) {
  const span = (a, b) => (a > 0 && b >= a ? Math.round((b - a) * 1000) / 1000 : -1);
  return list.map((e) => {
    let url;
    try { url = new URL(e.name); } catch { return null; }
    const type = guessType(e.name, e.initiatorType);
    return {
      pageref,
      startedDateTime: new Date(timeOrigin + e.startTime).toISOString(),
      time: Math.round(e.duration * 1000) / 1000,
      request: {
        method: 'GET', url: e.name, httpVersion: e.nextHopProtocol || '', cookies: [], headers: [],
        queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
        headersSize: -1, bodySize: 0,
      },
      response: {
        status: e.responseStatus || 0, statusText: '', httpVersion: e.nextHopProtocol || '',
        cookies: [], headers: [],
        content: { size: e.decodedBodySize || 0, mimeType: e.contentType || 'x-unknown' },
        redirectURL: '', headersSize: -1, bodySize: e.encodedBodySize || 0, _transferSize: e.transferSize || 0,
      },
      cache: {},
      timings: {
        blocked: Math.max(0, (e.domainLookupStart || e.fetchStart) - e.startTime),
        dns: span(e.domainLookupStart, e.domainLookupEnd),
        connect: span(e.connectStart, e.connectEnd),
        ssl: span(e.secureConnectionStart, e.connectEnd),
        send: 0,
        wait: e.requestStart > 0 ? Math.max(0, e.responseStart - e.requestStart) : 0,
        receive: Math.max(0, e.responseEnd - (e.responseStart || e.startTime)),
      },
      _resourceType: type,
      _synthetic: true,
      ...(e.deliveryType === 'cache' || (e.transferSize === 0 && e.decodedBodySize > 0) ? { _fromCache: 'disk' } : {}),
    };
  }).filter(Boolean);
}

/** Fold a views patch (screenshots + capture fields from the views run) into a reading still waiting for it. */
export function mergeViewsPatch(reading, patch) {
  const hp = reading?.log?._harplus;
  if (!hp?.capture?.viewsPending || !patch) return reading;
  hp.screenshots = [...(hp.screenshots || []), ...(patch.screenshots || [])];
  const { warnings: _w, ...capture } = patch.capture || {};
  Object.assign(hp.capture, capture);
  const seen = new Set(hp.capture.warnings || []);
  hp.capture.warnings = [...(hp.capture.warnings || []), ...(patch.warnings || []).filter((w) => !seen.has(w))];
  if (patch.timing) hp.timing = { ...(hp.timing || {}), ...patch.timing };
  delete hp.capture.viewsPending;
  return reading;
}
