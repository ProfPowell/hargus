// The reading report as markup: one pure function shared by the viewer, the standalone HTML export
// and the CLI. No DOM access — reading.js adds filters, dialogs, notes and exports on top.
// Layout: a sidebar plus one pane per section; CSS :target shows the current pane, so the
// exported file navigates without JavaScript.

import {
  AREAS, scoreReading, summarize, topFindings, resultArea, pluginArea, VERDICT,
} from '../core/score.js';
import { screenshotURL } from '../core/harplus.js';
import { pluginEnabled } from '../core/plugin-host.js';
import {
  transferSize, hostOf, resourceType, formatBytes, formatMs, isThirdParty,
} from '../core/har-util.js';
import { html, esc } from './html.js';
import { h, renderResult, renderGlance } from './render.js';

export const PANES = ['overview', ...AREAS.map((a) => `area-${a.id}`), 'findings', 'network', 'screens', 'notes'];
const AREA_LABEL = Object.fromEntries(AREAS.map((a) => [a.id, a.label]));
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const hp = (reading) => reading.log._harplus;
const resultsOf = (reading) => hp(reading).plugins || {};
const byId = (plugins, id) => plugins.find((p) => p.id === id);
const rank = (plugins, id) => { const i = plugins.findIndex((p) => p.id === id); return i < 0 ? 999 : i; };

export function timeBuckets(entries, n = 12) {
  const starts = entries.map((e) => Date.parse(e.startedDateTime)).filter(Number.isFinite);
  if (!starts.length) return [];
  const t0 = Math.min(...starts);
  const span = Math.max(1, Math.max(...starts) - t0);
  const out = Array(n).fill(0);
  for (const s of starts) out[Math.min(n - 1, Math.floor(((s - t0) / span) * n))]++;
  return out;
}

/* ---------------------------------------------------------------- sidebar */

function sidebar(reading, scores) {
  const o = scores.overall;
  return html`<nav class="sidebar" aria-label="Report sections">
    <div class="overall-mini">${h.ring({ value: o.score, size: 44, status: o.status, label: 'Overall score' })}<div><b>Overall${o.grade ? ` · ${o.grade}` : ''}</b><small>${count(o.findings, 'finding')}</small></div></div>
    <a href="#overview" data-pane="overview">${h.icon('overview')}Overview</a>
    ${AREAS.map((a) => {
      const s = scores.areas[a.id];
      return html`<a href="#area-${a.id}" data-pane="area-${a.id}">${h.ring({ value: s.score, size: 18, status: s.status, label: a.label, showValue: false })}${a.label}<b>${s.score ?? '—'}</b></a>`;
    })}
    <hr>
    <a href="#findings" data-pane="findings">${h.icon('findings')}All findings<b>${o.findings}</b></a>
    <a href="#network" data-pane="network">${h.icon('network')}Network<b>${reading.log.entries.length}</b></a>
    <a href="#screens" data-pane="screens">${h.icon('screens')}Screens</a>
    <a href="#notes" data-pane="notes">${h.icon('notes')}Notes</a>
  </nav>`;
}

/* --------------------------------------------------------------- overview */

function headlines(reading, plugins, areaId) {
  return Object.values(resultsOf(reading))
    .filter((r) => r.status === 'ok' && resultArea(r, plugins) === areaId)
    .sort((a, b) => rank(plugins, a.id) - rank(plugins, b.id))
    .flatMap((r) => (r.summary || []).filter((s) => s.headline))
    .slice(0, 3);
}

export function findingList(list, { showArea = true } = {}) {
  if (!list.length) return html`<p class="muted">No findings.</p>`;
  return html`<ul class="finding-list">${list.map((f) => html`<li>${h.icon(f.severity, { title: `${f.severity} severity` })}<div><span>${f.title}</span>${f.detail ? html`<small>${f.detail}</small>` : ''}</div><span class="src">${showArea ? AREA_LABEL[f.area] : f.pluginName}</span></li>`)}</ul>`;
}

function areaCard(a, reading, plugins, scores) {
  const worst = topFindings(scores, 1, a.id)[0];
  const keys = headlines(reading, plugins, a.id);
  return html`<article class="card area-card status-${a.status}">
    <div class="top">${h.ring({ value: a.score, size: 44, status: a.status, label: a.label })}<div><h3><a href="#area-${a.id}">${a.label}</a></h3><span class="verdict">${a.grade ? `${a.grade} · ` : ''}${VERDICT[a.status]}</span></div></div>
    ${keys.length ? html`<p class="keys">${keys.map((k) => `${k.label} ${k.value}`).join(' · ')}</p>` : ''}
    ${worst ? html`<p class="worst">${h.icon(worst.severity, { title: `${worst.severity} severity` })}<span>${worst.title}</span></p>` : ''}
    <a class="more" href="#area-${a.id}">Open ${a.label} →</a>
  </article>`;
}

function overviewStats(reading) {
  const entries = reading.log.entries;
  const site = hp(reading).target?.site;
  const bytes = entries.reduce((n, e) => n + transferSize(e), 0);
  const hosts = [...new Set(entries.map((e) => hostOf(e.request.url)))];
  const third = entries.filter((e) => isThirdParty(hostOf(e.request.url), site)).length;
  const r = resultsOf(reading);
  const techs = r.tech?.status === 'ok' ? r.tech.data?.technologies || [] : [];
  const lcp = r.vitals?.status === 'ok' ? r.vitals.data?.lcp?.time : null;
  return html`<div class="tiles stats">
    ${h.stat({ label: 'Requests', value: entries.length.toLocaleString('en-US'), note: `${third} third-party` })}
    ${h.stat({ label: 'Page weight', value: formatBytes(bytes) })}
    ${lcp != null ? h.stat({ label: 'Load (LCP)', value: formatMs(lcp), rating: r.vitals.data.ratings?.lcp }) : ''}
    ${h.stat({ label: 'Hosts contacted', value: hosts.length, note: `${hosts.filter((x) => isThirdParty(x, site)).length} third-party` })}
    ${techs.length ? h.stat({ label: 'Technologies', value: techs.length, note: count(new Set(techs.map((x) => x.category)).size, 'category', 'categories') }) : ''}
    ${entries.length ? h.stat({ label: 'Requests over time', value: h.spark(timeBuckets(entries), { label: 'Requests started over the capture' }) }) : ''}
  </div>`;
}

function findingsByArea(scores) {
  const rows = AREAS.map((a) => {
    const c = scores.areas[a.id].counts;
    return { a, c, total: c.high + c.medium + c.low + c.info };
  });
  const max = Math.max(1, ...rows.map((r) => r.total));
  const sum = (k) => rows.reduce((n, r) => n + r.c[k], 0);
  return html`<div class="area-bars">${rows.map(({ a, c, total }) => html`<div class="row"><span>${a.label}</span><div style="width:${Math.round((total / max) * 100)}%">${total ? h.stackBar({ legend: false, segments: [
    { label: 'High', value: c.high, color: 'var(--st-critical)' },
    { label: 'Medium', value: c.medium, color: 'var(--st-serious)' },
    { label: 'Low / info', value: c.low + c.info, color: 'var(--c1)' },
  ] }) : ''}</div><b>${total}</b></div>`)}</div>
  ${h.legend([
    { label: 'High', value: sum('high'), color: 'var(--st-critical)' },
    { label: 'Medium', value: sum('medium'), color: 'var(--st-serious)' },
    { label: 'Low / info', value: sum('low') + sum('info'), color: 'var(--c1)' },
  ])}`;
}

function builtWith(reading) {
  const tech = resultsOf(reading).tech;
  const techs = tech?.status === 'ok' ? tech.data?.technologies || [] : [];
  return techs.length ? html`<h2>Built with</h2>${h.badges(techs, { limit: 6 })}` : '';
}

function overviewPane(reading, plugins, scores) {
  const r = hp(reading);
  const t = r.target || {};
  const cap = r.capture || {};
  const shots = r.screenshots || [];
  const shot = shots.find((s) => s.kind === 'viewport') || shots.find((s) => s.kind === 'thumbnail');
  const o = scores.overall;
  const when = r.capturedAt ? new Date(r.capturedAt).toLocaleString() : '';
  const facts = [
    when,
    [cap.device || 'desktop', cap.throttle && cap.throttle !== 'none' ? cap.throttle : ''].filter(Boolean).join(' · '),
    `${cap.mode || 'reading'} mode`,
    cap.durationMs ? `${formatMs(cap.durationMs)} capture` : '',
    cap.source ? `imported from ${cap.source}` : '',
    t.url && t.finalUrl && t.url !== t.finalUrl ? `started at ${t.url}` : '',
    ...(r.tags || []).map((x) => `tag: ${x}`),
  ].filter(Boolean);
  return html`<section class="pane" id="overview" aria-labelledby="overview-h">
    <div class="card hero">
      ${shot ? html`<img class="shot" src="${screenshotURL(shot)}" alt="Screenshot of the page" data-zoom="${shot.kind}">` : html`<div class="shot empty-shot">No screenshot</div>`}
      <div class="hero-text">
        <h1 id="overview-h">${t.title || t.host || 'Untitled reading'}</h1>
        <div class="url">${h.link(t.finalUrl || t.url)}</div>
        <p class="narrative">${summarize(scores)}</p>
        <ul class="facts">${facts.map((f) => html`<li>${f}</li>`)}</ul>
        ${cap.warnings?.length ? html`<p class="note">Capture notes: ${cap.warnings.join('; ')}</p>` : ''}
      </div>
      <div class="overall">${h.ring({ value: o.score, size: 104, status: o.status, label: 'Overall score' })}<b>Overall${o.grade ? ` · ${o.grade}` : ''}</b><small>${count(o.findings, 'finding')}</small></div>
    </div>
    <div class="area-cards">${AREAS.map((a) => areaCard(scores.areas[a.id], reading, plugins, scores))}</div>
    ${overviewStats(reading)}
    <div class="two">
      <section class="card"><h2>Fix these first</h2>${findingList(topFindings(scores, 5))}<a class="more" href="#findings">All ${count(o.findings, 'finding')} →</a></section>
      <section class="card"><h2>Findings by area and severity</h2>${findingsByArea(scores)}${builtWith(reading)}</section>
    </div>
  </section>`;
}

/* ------------------------------------------------------------- area panes */

function areaSentence(a, ran) {
  if (a.score == null) return 'Not measured — no plugin in this area ran successfully.';
  const c = a.counts;
  const parts = [c.high && `${c.high} high`, c.medium && `${c.medium} medium`, c.low && `${c.low} low`].filter(Boolean);
  const names = ran.filter((r) => r.status === 'ok').map((r) => r.name).join(', ');
  const verdict = VERDICT[a.status];
  return `${verdict[0].toUpperCase()}${verdict.slice(1)}. ${parts.length ? `${parts.join(', ')} severity findings` : 'No findings above info'}${names ? ` from ${names}` : ''}.`;
}

function scoringDetails(a) {
  if (a.score == null) return '';
  const deducted = a.deductions.filter((d) => d.points);
  return html`<details class="scoring"><summary>How is this scored?</summary>
    <p>The findings score starts at 100 and each finding deducts points — high 15, medium 6, low 2, info 0 — capped at 60, 30 and 15 per severity.${a.inputs.length > 1 ? ' It is averaged 50/50 with the measured metric below.' : ''}</p>
    ${h.table(a.inputs.map((i) => ({ input: i.label, score: i.score })), [{ key: 'input', label: 'Input' }, { key: 'score', label: 'Score' }])}
    ${deducted.length ? h.table(deducted.map((d) => ({ finding: d.finding.title, severity: d.finding.severity, points: `−${d.points}` })), [
      { key: 'finding', label: 'Finding' }, { key: 'severity', label: 'Severity' }, { key: 'points', label: 'Points' },
    ]) : ''}
  </details>`;
}

function glances(ran, plugins, reading) {
  const ctx = { results: resultsOf(reading), target: hp(reading).target || {} };
  const tiles = [];
  const charts = [];
  for (const r of ran) {
    if (r.status !== 'ok') continue;
    const p = byId(plugins, r.id);
    if (p?.glance && !p.remote) charts.push(renderGlance(p, r, ctx));
    else tiles.push(...(r.summary || []).filter((s) => s.rating).map((s) => h.stat({ label: s.label, value: s.value, rating: s.rating })));
  }
  return html`${tiles.length ? html`<div class="tiles">${tiles}</div>` : ''}${charts.map((c) => html`<div class="glance">${c}</div>`)}`;
}

function pluginPanel(r, plugins) {
  return html`<details class="plugin" id="p-${r.id}">
    <summary>
      <span class="status-dot status-${r.status}" title="${r.status}"></span>
      <span class="name">${r.name}</span>
      ${r.findings?.length ? html`<span class="muted">${count(r.findings.length, 'finding')}</span>` : ''}
      <span class="meta">${r.status} · ${formatMs(r.durationMs)}${r.contacted?.length ? ` · contacted ${r.contacted.map((c) => `${c.host} ×${c.count}`).join(', ')}` : ''}</span>
    </summary>
    <div class="content">
      ${renderResult(byId(plugins, r.id), r)}
      ${r.data != null ? html`<details class="raw" data-raw="${r.id}"><summary>Raw data</summary></details>` : ''}
    </div>
  </details>`;
}

function areaPane(area, reading, plugins, scores, settings) {
  const a = scores.areas[area.id];
  const ran = Object.values(resultsOf(reading))
    .filter((r) => resultArea(r, plugins) === area.id)
    .sort((x, y) => rank(plugins, x.id) - rank(plugins, y.id));
  const notRun = plugins.filter((p) => pluginArea(p) === area.id && !resultsOf(reading)[p.id]);
  const list = topFindings(scores, Infinity, area.id, { includeInfo: true });
  return html`<section class="pane" id="area-${area.id}" aria-labelledby="area-${area.id}-h">
    <div class="card area-head">
      ${h.ring({ value: a.score, size: 72, status: a.status, label: area.label })}
      <div><h1 id="area-${area.id}-h">${area.label} ${a.grade ? html`<span class="grade status-${a.status}">${a.grade}</span>` : ''}</h1>
        <p>${areaSentence(a, ran)}</p>${scoringDetails(a)}</div>
    </div>
    ${glances(ran, plugins, reading)}
    <section class="card"><h2>Findings · ${list.length}</h2>${findingList(list.slice(0, 8), { showArea: false })}${list.length > 8 ? html`<a class="more" href="#findings">All findings →</a>` : ''}</section>
    <section class="plugin-detail"><h2>Plugin detail</h2>
      ${ran.length ? ran.map((r) => pluginPanel(r, plugins)) : html`<p class="muted">No plugins in this area ran.</p>`}
      ${notRun.length ? html`<p class="note">Not run: ${notRun.map((p) => `${p.name}${pluginEnabled(p, settings) ? '' : ' (disabled)'}`).join(', ')}. Enable plugins in the popup or Options, then re-run.</p>` : ''}
    </section>
  </section>`;
}

/* ------------------------------------------------- findings, network, … */

export function findingsTable(list) {
  if (!list.length) return html`<p class="muted">No findings match.</p>`;
  return html`<div class="table-wrap findings"><table class="data">
    <thead><tr><th scope="col">Severity</th><th scope="col">Area</th><th scope="col">Finding</th><th scope="col">Source</th></tr></thead>
    <tbody>${list.map((f) => html`<tr>
      <td><span class="sev sev-${f.severity}">${h.icon(f.severity)}${f.severity}</span></td>
      <td>${AREA_LABEL[f.area] || ''}</td>
      <td>${f.title}${f.detail ? html`<div class="detail">${f.detail}</div>` : ''}
        ${f.evidence ? html`<details><summary>evidence</summary><pre>${typeof f.evidence === 'string' ? f.evidence : JSON.stringify(f.evidence, null, 2)}</pre></details>` : ''}
        ${f.ref ? html`<div class="detail">${h.link(f.ref, 'reference')}</div>` : ''}</td>
      <td><a href="#p-${f.plugin}">${f.pluginName}</a></td>
    </tr>`)}</tbody></table></div>`;
}

export function networkTable(reading, rows, { limit = 800 } = {}) {
  const entries = reading.log.entries;
  if (!entries.length) return html`<p class="muted">No requests recorded.</p>`;
  const site = hp(reading).target?.site;
  const starts = entries.map((e) => Date.parse(e.startedDateTime));
  const t0 = Math.min(...starts);
  const end = Math.max(1, ...entries.map((e, i) => starts[i] - t0 + Math.max(0, e.time || 0)));
  const pct = (n) => Math.max(0, Math.min(100, (n / end) * 100)).toFixed(2);
  const shown = rows.slice(0, limit);
  return html`<p class="note">${rows.length} of ${entries.length} requests · span ${formatMs(end)}${rows.length > shown.length ? ` · showing first ${shown.length}` : ''} · orange bars are third-party</p>
    <div class="table-wrap net"><table class="data">
      <thead><tr><th scope="col">#</th><th scope="col">Status</th><th scope="col">Method</th><th scope="col">Type</th><th scope="col">URL</th><th scope="col">Size</th><th scope="col">Time</th><th scope="col">Waterfall</th></tr></thead>
      <tbody>${shown.map(({ e, i }) => {
        const host = hostOf(e.request.url);
        let path = e.request.url;
        try { const u = new URL(e.request.url); path = u.pathname + u.search; } catch { /* keep raw */ }
        const bad = e._error || e.response.status >= 400 || e.response.status === 0;
        return html`<tr data-entry="${i}" tabindex="0">
          <td class="num">${i + 1}</td>
          <td class="num ${bad ? 'status-err' : ''}">${e._error ? 'ERR' : e.response.status || '—'}</td>
          <td>${e.request.method}</td>
          <td>${resourceType(e)}</td>
          <td class="url" title="${e.request.url}">${host}<span class="muted">${path.slice(0, 90)}</span></td>
          <td class="num">${formatBytes(transferSize(e))}</td>
          <td class="num">${formatMs(e.time)}</td>
          <td><div class="wf"><span class="${isThirdParty(host, site) ? 'third' : ''}" style="left:${pct(starts[i] - t0)}%;width:${pct(Math.max(0, e.time || 0))}%"></span></div></td>
        </tr>`;
      })}</tbody>
    </table></div>`;
}

function findingsPane(scores) {
  return html`<section class="pane" id="findings" aria-labelledby="findings-h">
    <header class="pane-head"><h1 id="findings-h">All findings</h1><div class="tools" id="findings-tools"></div></header>
    <div id="findings-table">${findingsTable(topFindings(scores, Infinity, null, { includeInfo: true }))}</div>
  </section>`;
}

function networkPane(reading, plugins) {
  const net = resultsOf(reading).network;
  const p = byId(plugins, 'network');
  return html`<section class="pane" id="network" aria-labelledby="network-h">
    <header class="pane-head"><h1 id="network-h">Network</h1><div class="tools" id="network-tools"></div></header>
    ${net?.status === 'ok' && p ? renderGlance(p, net, { results: resultsOf(reading), target: hp(reading).target || {} }) : ''}
    <div id="net-table">${networkTable(reading, reading.log.entries.map((e, i) => ({ e, i })))}</div>
  </section>`;
}

function screensPane(reading) {
  const shots = (hp(reading).screenshots || []).filter((s) => s.kind !== 'thumbnail');
  return html`<section class="pane" id="screens" aria-labelledby="screens-h"><h1 id="screens-h">Screens</h1>
    ${shots.length ? html`<div class="shots">${shots.map((s) => html`<figure>
      <div class="frame"><img src="${screenshotURL(s)}" alt="${s.kind === 'fullpage' ? 'Full-page' : 'Viewport'} screenshot" data-zoom="${s.kind}" loading="lazy"></div>
      <figcaption>${s.kind === 'fullpage' ? 'Full page' : 'Viewport'} · ${s.cssWidth}×${s.cssHeight} CSS px · ${s.dpr}× DPR${s.truncated ? ' · truncated' : ''}</figcaption>
    </figure>`)}</div>` : html`<p class="muted">No screenshots in this reading.</p>`}
  </section>`;
}

function notesPane(reading, interactive) {
  const r = hp(reading);
  const body = interactive
    ? html`<form id="notes-form" class="notes card">
        <label>Tags <input type="text" name="tags" value="${(r.tags || []).join(', ')}" placeholder="prospect, competitor, audit-q4" style="width:100%"></label>
        <label>Notes <textarea name="notes" placeholder="What did you learn from this reading?">${r.notes || ''}</textarea></label>
        <div><button class="btn primary" type="submit">Save notes</button></div>
      </form>`
    : html`<div class="card notes">${r.tags?.length ? html`<div>${h.tags(r.tags)}</div>` : ''}${r.notes ? html`<p style="white-space:pre-wrap">${r.notes}</p>` : html`<p class="muted">No notes.</p>`}</div>`;
  return html`<section class="pane" id="notes" aria-labelledby="notes-h"><h1 id="notes-h">Notes &amp; tags</h1>${body}</section>`;
}

/* ------------------------------------------------------------------ main */

export function renderReport(reading, plugins, { scores = scoreReading(reading, plugins), settings = {}, interactive = true } = {}) {
  return String(html`<div class="report">
    ${sidebar(reading, scores)}
    <div class="panes">
      ${overviewPane(reading, plugins, scores)}
      ${AREAS.map((a) => areaPane(a, reading, plugins, scores, settings))}
      ${findingsPane(scores)}
      ${networkPane(reading, plugins)}
      ${screensPane(reading)}
      ${notesPane(reading, interactive)}
    </div>
  </div>`);
}

/** A self-contained report file: inlined CSS, embedded screenshots, :target navigation, no scripts. */
export function standaloneDocument(reading, plugins, { css = '', scores } = {}) {
  const t = hp(reading).target || {};
  const title = `${t.title || t.host || 'Reading'} — HAR-PLUS report`;
  const safeCss = String(css).replace(/</g, '\\3C '); // CSS escape: nothing in the stylesheet can close <style>
  const when = hp(reading).capturedAt ? new Date(hp(reading).capturedAt).toLocaleString() : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="HAR-PLUS">
<title>${esc(title)}</title>
<style>${safeCss}</style>
</head>
<body class="reading standalone">
<header class="appbar"><span class="brand">HAR<small>+</small></span><span class="appbar-title">${esc([t.title || t.host, t.finalUrl || t.url, when].filter(Boolean).join(' · '))}</span></header>
<main id="app">${renderReport(reading, plugins, { scores, interactive: false })}</main>
</body>
</html>
`;
}
