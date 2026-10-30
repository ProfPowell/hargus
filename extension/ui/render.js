// Helper kit handed to plugin render()/glance() functions, plus small viewer utilities.
// Escaping lives in html.js; every interpolated value is escaped unless it came from html`` / raw().

import { formatBytes, formatMs } from '../core/har-util.js';
import { html, raw, esc, isRaw } from './html.js';
import { AREAS } from '../core/score.js';
import {
  ring, donut, stackBar, hbars, meter, stat, stats, scoreBar, spark, legend, checklist, checks, status, sev, mix, flow, timeline, icon, badges, rate,
} from './charts.js';

export { html, raw, esc, isRaw };

const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length) || (isRaw(v) && !String(v).trim());

function cell(v) {
  if (isRaw(v)) return v;
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return v.toLocaleString();
  if (Array.isArray(v)) return v.every((x) => typeof x !== 'object') ? v.join(', ') : JSON.stringify(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const AREA_LABEL = Object.fromEntries(AREAS.map((a) => [a.id, a.label]));

const parseHttp = (s) => {
  try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u : null; } catch { return null; } // unparseable: shown whole
};

/** host / path / query / hash as separate spans so CSS can shrink the query and hash first; anything not http(s) goes whole into the path. */
function urlParts(url) {
  const s = String(url);
  const u = parseHttp(s);
  if (!u) return html`<span class="url" title="${s}"><span class="url-path">${s}</span></span>`;
  return html`<span class="url" title="${s}"><span class="url-host">${u.host}</span><span class="url-path">${u.pathname}</span>${u.search ? html`<span class="url-query">${u.search}</span>` : ''}${u.hash ? html`<span class="url-hash">${u.hash}</span>` : ''}</span>`;
}

/** A copy button's distinct name: host and path (or the whole string), cut at 60 characters. */
function copyLabel(url) {
  const s = String(url);
  const u = parseHttp(s);
  const short = u ? `${u.host}${u.pathname}${u.hash}` : s;
  return `Copy URL: ${short.length > 60 ? `${short.slice(0, 59)}…` : short}`;
}

const FOLD = 8;

/** The first `fold` items drawn as usual, the rest in a closed "N more" disclosure drawn the same way (print opens it). */
function folded(items, fold, draw) {
  if (fold === false || !(fold > 0) || items.length <= fold) return draw(items);
  const rest = items.slice(fold);
  return html`${draw(items.slice(0, fold))}<details class="disclosure fold"><summary>${rest.length} more</summary><div class="disclosure-body">${draw(rest)}</div></details>`;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');

export const h = {
  html, raw, esc,
  ring, donut, stackBar, hbars, meter, stat, stats, scoreBar, spark, legend, checklist, checks, status, sev, mix, flow, timeline, icon, badges, rate,
  bytes: (n) => formatBytes(n),
  ms: (n) => formatMs(n),
  /** A URL as text, split into host / path / query / hash parts (no link). */
  url: (url) => urlParts(url),
  /** A link; with no text (or text equal to the URL) the URL shows as parts. Only http(s) URLs are linked. */
  link(url, text) {
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) return text || url;
    const label = !text || text === url ? urlParts(url) : text;
    return html`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  },
  kv(pairs) {
    const rows = (Array.isArray(pairs) ? pairs : Object.entries(pairs || {})).filter(([, v]) => !empty(v));
    if (!rows.length) return '';
    return html`<dl class="kv">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${cell(v)}</dd>`)}</dl>`;
  },
  /** A table; past `fold` rows (default 8) the rest go under an "N more" disclosure with the same header. fold: false shows all. */
  table(rows = [], cols, { fold = FOLD } = {}) {
    if (!rows.length) return '';
    const columns = (cols || Object.keys(rows[0])).map((c) => (typeof c === 'string' ? { key: c, label: c } : c));
    const part = (rs) => html`<div class="table-wrap"><table class="data">
      <thead><tr>${columns.map((c) => html`<th scope="col">${c.label}</th>`)}</tr></thead>
      <tbody>${rs.map((r) => html`<tr>${columns.map((c) => html`<td>${cell(r[c.key])}</td>`)}</tr>`)}</tbody>
    </table></div>`;
    return folded(rows, fold, part);
  },
  /** A plain list; folds like table(). */
  list(items = [], { fold = FOLD } = {}) {
    const xs = items.filter((x) => !empty(x));
    return xs.length ? folded(xs, fold, (part) => html`<ul class="plain">${part.map((x) => html`<li>${cell(x)}</li>`)}</ul>`) : '';
  },
  tags(items = []) {
    return items.length ? html`${items.map((x) => html`<span class="tag">${x}</span>`)}` : '';
  },
  sub(title, content, { sub, link, foot, flush } = {}) {
    if (empty(content)) return '';
    const head = html`<h4>${title}</h4>${sub ? html`<span class="panel-sub">${sub}</span>` : ''}${link ? (/^(#|https?:)/i.test(String(link.href).trim()) ? html`<a class="panel-link" href="${link.href}">${link.text}</a>` : html`<span class="panel-link">${link.text}</span>`) : ''}`;
    return html`<section class="panel sub"><div class="panel-head">${head}</div><div class="${flush ? 'panel-body flush' : 'panel-body'}">${content}</div>${foot ? html`<div class="panel-foot">${foot}</div>` : ''}</section>`;
  },
  /** One issue row: a link to its detail (#issue-<key>). */
  issue(issue, { showArea = true, current = false } = {}) {
    const n = Number(issue.count);
    const meta = [showArea && AREA_LABEL[issue.area], issue.pluginName].filter(Boolean);
    return html`<a class="issue" href="#issue-${issue.key}"${current ? raw(' aria-current="true"') : ''}>${sev(issue.severity)}<span class="issue-title">${issue.title}</span><span class="issue-count">${n > 1 ? n : ''}</span><span class="issue-meta">${meta.map((m) => html`<span>${m}</span>`)}</span></a>`;
  },
  issues(list = [], opts) {
    if (!list || !list.length) return raw('<p class="muted">No issues.</p>');
    return html`<ul class="issues">${list.map((i) => html`<li>${h.issue(i, opts)}</li>`)}</ul>`;
  },
  /** Where exactly: status, smart URL, copy button, text/region/line/selector/file/note. */
  places(items, { interactive = false } = {}) {
    if (!items || !items.length) return '';
    const row = (p) => {
      const st = p.status != null && p.status !== '' ? p.status : null;
      const cls = st != null && Number(st) >= 400 ? raw(' data-status-class="error"') : '';
      const code = st == null ? ''
        : interactive && Number.isInteger(p.entry) ? html`<a class="place-code" href="#network" data-entry="${p.entry}"${cls}>${st}<span class="sr-only"> — open request in Network</span></a>`
          : html`<span class="place-code"${cls}>${st}</span>`;
      const where = [
        p.text ? html`“${p.text}”` : '', p.region, p.line != null && p.line !== '' ? `line ${p.line}` : '',
        p.selector ? html`<code>${p.selector}</code>` : '', p.file, p.note,
      ].filter((x) => x !== '' && x != null && x !== false);
      return html`<li class="place">${code}${p.url ? urlParts(p.url) : ''}${interactive && p.url ? html`<button type="button" class="copy" data-copy="${p.url}" aria-label="${copyLabel(p.url)}">Copy</button>` : ''}${where.length ? html`<span class="place-where">${where.map((w) => html`<span class="loc">${w}</span>`)}</span>` : ''}</li>`;
    };
    return html`<ul class="places">${items.map(row)}</ul>`;
  },
  /** Collapsed details (evidence, "show more"); opens for print and no-script export. */
  more(summary, body, meta) {
    if (empty(body)) return '';
    return html`<details class="disclosure"><summary>${summary}${meta ? html`<span class="disclosure-meta">${meta}</span>` : ''}</summary><div class="disclosure-body">${body}</div></details>`;
  },
  notice(text, { state } = {}) {
    return html`<p class="notice">${state ? status(state, '') : ''}${text}</p>`;
  },
  json(value) {
    return html`<pre class="json">${JSON.stringify(value, null, 2)}</pre>`;
  },
  check(ok) {
    return ok ? raw('<span class="check ok" aria-label="yes">✓</span>') : raw('<span class="check no" aria-label="no">✗</span>');
  },
  rating(r) {
    return html`<span class="rating rating-${slug(r)}">${r}</span>`;
  },
  outline(headings = []) {
    if (!headings.length) return '';
    return html`<ol class="outline">${headings.map((x) => html`<li style="--level:${Number(x.level) || 1}"><span class="lvl">h${x.level}</span>${x.text || '(empty)'}</li>`)}</ol>`;
  },
};

/** Fallback renderer for plugins without render() (and for untrusted remote plugins). */
export function renderGeneric(data, depth = 0) {
  if (data == null) return '';
  if (Array.isArray(data)) {
    if (data.length && data.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
      const keys = [...new Set(data.flatMap((x) => Object.keys(x)))].slice(0, 8);
      return h.table(data.slice(0, 200), keys);
    }
    return h.list(data.map(cell));
  }
  if (typeof data !== 'object') return html`<p>${cell(data)}</p>`;
  const flat = Object.entries(data).filter(([, v]) => v == null || typeof v !== 'object' || (Array.isArray(v) && v.every((x) => typeof x !== 'object')));
  const nested = Object.entries(data).filter(([k]) => !flat.some(([f]) => f === k));
  return html`${h.kv(flat)}${depth < 2 ? nested.map(([k, v]) => h.sub(k, renderGeneric(v, depth + 1))) : h.json(Object.fromEntries(nested))}`;
}

export function renderResult(plugin, result, ctx = {}) {
  if (result.status === 'skipped') return html`<p class="note">Skipped — ${result.error}</p>`;
  if (result.status === 'error') return html`<p class="error">Error — ${result.error}</p>`;
  try {
    return plugin?.render && !plugin.remote ? plugin.render(result, h, ctx) : renderGeneric(result.data);
  } catch (e) {
    return html`<p class="error">Render failed: ${e.message}</p>${renderGeneric(result.data)}`;
  }
}

/** A plugin's area-page charts. Never called for remote plugins (untrusted); failures stay contained. */
export function renderGlance(plugin, result, ctx = {}) {
  if (!plugin?.glance || plugin.remote) return html``;
  try {
    return html`${plugin.glance(result, h, ctx) || ''}`;
  } catch (e) {
    return html`<p class="error">${plugin.name}: chart failed — ${e.message}</p>`;
  }
}

export function toast(message, ms = 2500) {
  const el = Object.assign(document.createElement('div'), { className: 'toast', role: 'status', textContent: message });
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

export function download(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fileStem(reading) {
  const hp = reading.log._harplus;
  const date = String(hp.capturedAt || '').slice(0, 16).replace(/[:T]/g, '-');
  return `${hp.target?.host || 'reading'}-${date}`;
}
