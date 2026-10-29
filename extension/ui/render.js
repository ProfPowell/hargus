// Helper kit handed to plugin render()/glance() functions, plus small viewer utilities.
// Escaping lives in html.js; every interpolated value is escaped unless it came from html`` / raw().

import { formatBytes, formatMs } from '../core/har-util.js';
import { html, raw, esc, isRaw } from './html.js';
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

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');

export const h = {
  html, raw, esc,
  ring, donut, stackBar, hbars, meter, stat, stats, scoreBar, spark, legend, checklist, checks, status, sev, mix, flow, timeline, icon, badges, rate,
  bytes: (n) => formatBytes(n),
  ms: (n) => formatMs(n),
  link(url, text) {
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) return text || url;
    return html`<a href="${url}" target="_blank" rel="noopener noreferrer">${text || url}</a>`;
  },
  kv(pairs) {
    const rows = (Array.isArray(pairs) ? pairs : Object.entries(pairs || {})).filter(([, v]) => !empty(v));
    if (!rows.length) return '';
    return html`<dl class="kv">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${cell(v)}</dd>`)}</dl>`;
  },
  table(rows = [], cols) {
    if (!rows.length) return '';
    const columns = (cols || Object.keys(rows[0])).map((c) => (typeof c === 'string' ? { key: c, label: c } : c));
    return html`<div class="table-wrap"><table class="data">
      <thead><tr>${columns.map((c) => html`<th scope="col">${c.label}</th>`)}</tr></thead>
      <tbody>${rows.map((r) => html`<tr>${columns.map((c) => html`<td>${cell(r[c.key])}</td>`)}</tr>`)}</tbody>
    </table></div>`;
  },
  list(items = []) {
    const xs = items.filter((x) => !empty(x));
    return xs.length ? html`<ul class="plain">${xs.map((x) => html`<li>${cell(x)}</li>`)}</ul>` : '';
  },
  tags(items = []) {
    return items.length ? html`${items.map((x) => html`<span class="tag">${x}</span>`)}` : '';
  },
  sub(title, content, { sub, link, foot, flush } = {}) {
    if (empty(content)) return '';
    const head = html`<h4>${title}</h4>${sub ? html`<span class="panel-sub">${sub}</span>` : ''}${link ? html`<a class="panel-link" href="${link.href}">${link.text}</a>` : ''}`;
    return html`<section class="panel sub"><div class="panel-head">${head}</div><div class="${flush ? 'panel-body flush' : 'panel-body'}">${content}</div>${foot ? html`<div class="panel-foot">${foot}</div>` : ''}</section>`;
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
