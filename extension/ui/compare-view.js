// The compare page's markup: verdict, site headers, area table, metric face-off, before and after, round progress.
// Pure (no DOM, no chrome.*): strings in, Raw out, shared by the page and its standalone export.

import { html, raw, esc } from './html.js';
import { scoreBar } from './charts.js';
import { inlineAssets } from './report.js';
import { formatMetric } from '../core/metrics.js';
import { siteLabel } from '../core/compare.js';
import { AREAS, status } from '../core/score.js';

const isImg = (s) => /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i.test(String(s || ''));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listAnd = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const STAR = raw('<span class="cmp-star">★<span class="sr-only"> winner</span></span>');
const dateOf = (t) => {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

/** 1 → "1st", 2 → "2nd", 11 → "11th". */
export function ordinal(n) {
  const t = n % 100;
  const s = t >= 11 && t <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
  return `${n}${s}`;
}

// Everything the parts share: the site names (gone sites from the delta included), live sites, and the delta lookups.
function context(model, opts) {
  const { delta = null, interactive = false, links = {} } = opts;
  const labels = new Map(model.sites.map((s) => [s.key, s.label || s.host || s.key]));
  const gone = delta ? delta.sites.filter((d) => d.status === 'gone') : [];
  const goneKeys = gone.map((d) => d.key);
  for (const k of goneKeys) labels.set(k, siteLabel(k, goneKeys) || k);
  return {
    delta,
    interactive,
    links,
    name: (k) => labels.get(k) ?? k,
    live: model.sites.filter((s) => !s.gap),
    gone,
    dsite: (k) => delta?.sites.find((d) => d.key === k) || null,
    darea: (id, k) => delta?.areas.find((a) => a.id === id)?.changes[k] || null,
    dmetric: (id, k) => delta?.metrics.find((m) => m.id === id)?.changes[k] || null,
    single: !model.overall.tie && model.overall.winners.length === 1 ? model.overall.winners[0] : null,
  };
}

function favicon(site) {
  if (isImg(site.favicon)) return html`<img class="cmp-fav" src="${site.favicon}" alt="">`;
  const initial = String(site.host || site.label || '?').replace(/^www\./, '').charAt(0).toUpperCase() || '?';
  return html`<span class="cmp-fav" aria-hidden="true">${initial}</span>`;
}

// On screen the host links to its reading; in the export it is plain text.
function hostName(site, ctx) {
  const id = ctx.links[site.key];
  return ctx.interactive && id ? html`<a href="reading.html?id=${encodeURIComponent(id)}">${ctx.name(site.key)}</a>` : html`<span>${ctx.name(site.key)}</span>`;
}

const gradeChip = (site) => (site.grade ? html`<span class="grade status-${site.status}">${site.grade}</span>` : '');

// Before and after for one site's header: "new in this round", or the grade then → now and the rank change.
function siteChange(key, ctx) {
  const d = ctx.dsite(key);
  if (!d) return '';
  if (d.status === 'new') return html`<p class="cmp-change">new in this round</p>`;
  const parts = [];
  if (d.grade.before && d.grade.after) parts.push(`${d.grade.before} → ${d.grade.after}`);
  if (d.rank.before && d.rank.after) parts.push(`${ordinal(d.rank.before)} → ${ordinal(d.rank.after)}`);
  return parts.length ? html`<p class="cmp-change">${parts.join(' · ')}</p>` : '';
}

const item = (x) => html`<li>${x.label} (${x.value})</li>`;
function strengthsAndWeaknesses(site) {
  const good = site.strengths.slice(0, 2);
  const bad = site.weaknesses.slice(0, 2);
  return html`<ul class="cmp-good">${good.length ? good.map(item) : html`<li class="muted">No clear strengths in this group</li>`}</ul><ul class="cmp-bad">${bad.length ? bad.map(item) : html`<li class="muted">No clear weaknesses in this group</li>`}</ul>`;
}

function column(site, ctx) {
  const head = html`<header class="cmp-site-head">${favicon(site)}<h3 class="cmp-host">${hostName(site, ctx)}</h3>${ctx.single === site.key ? STAR : ''}</header>`;
  if (site.gap) return html`<section class="cmp-site gap">${head}<p class="cmp-gap">${site.gap}</p></section>`;
  return html`<section class="cmp-site${ctx.single === site.key ? ' win' : ''}">${head}
    ${isImg(site.thumb) ? html`<img class="cmp-thumb" src="${site.thumb}" alt="">` : html`<div class="cmp-thumb"></div>`}
    <p class="cmp-total"><span class="cmp-score">${site.score ?? '—'}</span> ${gradeChip(site)}</p>
    ${siteChange(site.key, ctx)}
    ${strengthsAndWeaknesses(site)}
  </section>`;
}

const goneColumn = (d, ctx) => html`<section class="cmp-site gap"><header class="cmp-site-head">${favicon({ host: ctx.name(d.key) })}<h3 class="cmp-host"><span>${ctx.name(d.key)}</span></h3></header><p class="cmp-gap">not in this round</p></section>`;

function chip(site, ctx) {
  if (site.gap) return html`<li class="cmp-chip gap">${favicon(site)}${hostName(site, ctx)} <span class="cmp-gap">${site.gap}</span></li>`;
  return html`<li class="cmp-chip${ctx.single === site.key ? ' win' : ''}">${favicon(site)}${hostName(site, ctx)} <span class="cmp-score">${site.score ?? '—'}</span> ${gradeChip(site)}${ctx.single === site.key ? STAR : ''}${siteChange(site.key, ctx)}</li>`;
}

function headers(model, ctx) {
  if (model.layout === 'strip') {
    return html`<ul class="cmp-strip">${model.sites.map((s) => chip(s, ctx))}${ctx.gone.map((d) => html`<li class="cmp-chip gap">${favicon({ host: ctx.name(d.key) })}<span>${ctx.name(d.key)}</span> <span class="cmp-gap">not in this round</span></li>`)}</ul>`;
  }
  return html`<div class="cmp-sites" style="--cols:${model.sites.length + ctx.gone.length}">${model.sites.map((s) => column(s, ctx))}${ctx.gone.map((d) => goneColumn(d, ctx))}</div>`;
}

function verdict(model, ctx) {
  if (ctx.delta) return html`<p class="cmp-verdict">${ctx.delta.verdict}</p>`;
  const o = model.overall;
  if (!o.winners.length) return '';
  if (o.tie) return html`<p class="cmp-verdict">Overall: tie between ${listAnd(o.winners.map(ctx.name))}</p>`;
  const w = o.winners[0];
  const others = Object.entries(o.areaWins).filter(([k, n]) => k !== w && n > 0).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${ctx.name(k)} ${n}`);
  const parts = [`Overall: ${ctx.name(w)}`, `wins ${plural(o.areaWins[w] || 0, 'area')}`, ...others, o.ties ? plural(o.ties, 'tie') : ''];
  return html`<p class="cmp-verdict">${parts.filter(Boolean).join(' · ')}</p>`;
}

// "▲14", "▼6" or "no change"; nothing when either round lacks the score.
function areaChange(ch) {
  if (!ch || ch.change == null) return '';
  if (ch.same) return html` <span class="cmp-delta same">no change</span>`;
  return ch.change > 0 ? html` <span class="cmp-delta up">▲${ch.change}</span>` : html` <span class="cmp-delta down">▼${Math.abs(ch.change)}</span>`;
}

function areaTable(model, ctx) {
  const rows = model.areas.map((a) => {
    const winner = a.tie ? 'tie' : a.winners.length ? ctx.name(a.winners[0]) : '—';
    const cells = ctx.live.map((s) => {
      const v = a.scores[s.key];
      if (v == null) return html`<td><span class="muted">not measured</span></td>`;
      const star = !a.tie && a.winners[0] === s.key ? STAR : '';
      return html`<td><span class="cmp-cell">${scoreBar({ value: v, status: status(v), label: `${ctx.name(s.key)}, ${a.label}` })}<span class="cmp-num">${v}</span>${areaChange(ctx.darea(a.id, s.key))}${star}</span></td>`;
    });
    return html`<tr><th scope="row">${a.label}</th><td>${winner}</td>${cells}<td class="cmp-why">${a.why}</td></tr>`;
  });
  return html`<section class="cmp-section"><h2>Areas</h2><div class="table-wrap"><table class="cmp-areas data">
    <thead><tr><th scope="col">Area</th><th scope="col">Winner</th>${ctx.live.map((s) => html`<th scope="col">${ctx.name(s.key)}</th>`)}<th scope="col">Why</th></tr></thead>
    <tbody>${rows}</tbody></table></div></section>`;
}

function swBlock(model, ctx) {
  if (model.layout !== 'strip' || !ctx.live.length) return '';
  return html`<section class="cmp-section cmp-sw"><h2>Strengths and weaknesses</h2><div class="table-wrap"><table class="data">
    <thead><tr><th scope="col">Site</th><th scope="col">Strengths</th><th scope="col">Weaknesses</th></tr></thead>
    <tbody>${ctx.live.map((s) => {
      const good = s.strengths.slice(0, 2);
      const bad = s.weaknesses.slice(0, 2);
      return html`<tr><th scope="row">${ctx.name(s.key)}</th><td><ul class="cmp-good">${good.length ? good.map(item) : html`<li class="muted">No clear strengths in this group</li>`}</ul></td><td><ul class="cmp-bad">${bad.length ? bad.map(item) : html`<li class="muted">No clear weaknesses in this group</li>`}</ul></td></tr>`;
    })}</tbody></table></div></section>`;
}

// One face-off value: the text, or then → now with "no change" by the metric's tie rules.
function metricCell(m, key, ctx) {
  const ch = ctx.dmetric(m.id, key);
  if (!ctx.delta || !ch) return m.values[key]?.text ?? '—';
  const b = formatMetric(m.id, ch.before);
  const a = formatMetric(m.id, ch.after);
  if (ch.before == null) return a;
  if (ch.same) return html`${a} <span class="cmp-delta same">no change</span>`;
  return `${b} → ${a}`;
}

function faceoff(model, ctx) {
  const f = model.faceoff;
  const wins = Object.entries(f.wins).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([k, n], i) => (i ? `${ctx.name(k)} ${n}` : `${ctx.name(k)} wins ${n}`));
  const summary = f.total ? `${plural(f.total, 'metric')}: ${[...wins, f.ties ? plural(f.ties, 'tie') : ''].filter(Boolean).join(', ')}` : 'No metric was measured on two or more sites.';
  const span = ctx.live.length + 2;
  const groups = AREAS.map((a) => ({ a, ms: model.metrics.filter((m) => m.area === a.id) })).filter((g) => g.ms.length);
  const rows = groups.map(({ a, ms }) => html`<tr class="cmp-group"><th colspan="${span}" scope="colgroup">${a.label}</th></tr>${ms.map((m) => html`<tr><th scope="row">${m.label}</th>${ctx.live.map((s) => {
    const cls = m.best === s.key ? 'best' : m.worst === s.key ? 'worst' : '';
    return cls ? html`<td class="${cls}">${metricCell(m, s.key, ctx)}</td>` : html`<td>${metricCell(m, s.key, ctx)}</td>`;
  })}<td>${m.tie ? 'tie' : m.winners.length ? ctx.name(m.winners[0]) : '—'}</td></tr>`)}`);
  return html`<section class="cmp-section cmp-faceoff"><h2>Metric face-off</h2><p class="cmp-summary">${summary}</p>
    ${model.singleRunNote ? html`<p class="note">Some timings are single runs; record with 3 runs for firmer results.</p>` : ''}
    ${groups.length ? html`<div class="table-wrap"><table class="cmp-metrics data">
      <thead><tr><th scope="col">Metric</th>${ctx.live.map((s) => html`<th scope="col">${ctx.name(s.key)}</th>`)}<th scope="col">Winner</th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : ''}</section>`;
}

function conditionsBlock(lines) {
  return lines?.length ? html`<section class="cmp-conditions" aria-label="Recorded differently"><ul>${lines.map((l) => html`<li>${l}</li>`)}</ul></section>` : '';
}

const ROUND_WORD = { done: '', running: 'recording', incomplete: 'incomplete', stopped: 'stopped' };
const roundLabel = (r, i) => {
  const word = ROUND_WORD[r.state] ?? r.state;
  return `Round ${i + 1} · ${dateOf(r.at)}${word ? ` (${word})` : ''}`;
};

/** The round picker: two selects on screen, a plain line in the export; nothing with fewer than 2 rounds. */
export function roundPicker(rounds, { interactive = false } = {}) {
  if (!rounds?.list || rounds.list.length < 2) return '';
  const { list, before, after } = rounds;
  if (!interactive) {
    return html`<p class="cmp-rounds">${roundLabel(list[after], after)} against round ${before + 1} · ${dateOf(list[before].at)}</p>`;
  }
  const options = (pick) => list.map((r, i) => (i === pick
    ? html`<option value="${i}" selected>${roundLabel(r, i)}</option>`
    : html`<option value="${i}">${roundLabel(r, i)}</option>`)).reverse();
  return html`<form class="cmp-rounds"><label>Compare round <select id="round-after">${options(after)}</select></label> <label>against <select id="round-before">${options(before)}</select></label></form>`;
}

/** A running round as a list, "Site 3 of 5: stanford.edu, analysing", with the keep-visible line. */
export function roundProgress(round) {
  if (!round?.readings?.length) return '';
  const urls = round.readings.map((r) => r.url);
  const n = urls.length;
  return html`<section class="card cmp-progress"><h2>Recording this round</h2><ol>${round.readings.map((r, i) => {
    const word = r.state === 'failed' || r.error ? `failed${r.error ? `: ${r.error}` : ''}` : r.state || 'waiting';
    return html`<li class="cmp-prog-${r.error ? 'failed' : r.state || 'waiting'}">Site ${i + 1} of ${n}: ${siteLabel(r.url, urls) || r.url}, ${word}</li>`;
  })}</ol><p class="note">Keep the recording window visible until the round ends</p></section>`;
}

function footer(model, ctx) {
  const dates = ctx.live.filter((s) => s.capturedAt).map((s) => `${ctx.name(s.key)} recorded ${new Date(s.capturedAt).toLocaleString()}`);
  return html`<footer class="cmp-foot"><p>Scored with the ${model.profile?.label || 'General'} profile</p>${dates.length ? html`<p>${dates.join(' · ')}</p>` : ''}</footer>`;
}

/**
 * The whole comparison. opts: conditions (lines), delta (compareRounds) for before and after, rounds { list, before, after }
 * for the picker, progress (a running round), notes (page lines), links ({ [key]: reading id }), title (a set's name), interactive.
 */
export function renderCompare(model, { conditions = [], delta = null, rounds = null, progress = null, interactive = false, notes = [], links = {}, title = '' } = {}) {
  const ctx = context(model, { delta, interactive, links });
  return html`<div class="compare-view">
    ${title ? html`<h1 class="cmp-title">${title}</h1>` : ''}
    ${notes.map((n) => html`<p class="note">${n}</p>`)}
    ${roundProgress(progress)}
    ${roundPicker(rounds, ctx)}
    ${conditionsBlock(conditions)}
    ${verdict(model, ctx)}
    ${headers(model, ctx)}
    ${areaTable(model, ctx)}
    ${swBlock(model, ctx)}
    ${faceoff(model, ctx)}
    ${footer(model, ctx)}
  </div>`;
}

/** A self-contained comparison file: inlined CSS and fonts, data-URL images, hosts as plain text, no script. */
export function compareDocument(model, opts = {}, { css = '', fonts = {} } = {}) {
  const names = model.sites.map((s) => s.label || s.host || s.key);
  const title = `${opts.title || `Comparing ${listAnd(names)}`} — HARgus`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="HARgus">
<title>${esc(title)}</title>
<style>${inlineAssets(css, fonts)}</style>
</head>
<body class="compare standalone">
<header class="appbar"><span class="brand"><svg class="mark" viewBox="0 0 32 32" width="24" height="24" aria-hidden="true"><path d="M2 16c3.8-6.2 8.4-9.3 14-9.3s10.2 3.1 14 9.3c-3.8 6.2-8.4 9.3-14 9.3S5.8 22.2 2 16z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><rect x="9" y="11.4" width="7" height="2.4" rx="1.2" fill="#0A7C71"/><rect x="12" y="14.8" width="9" height="2.4" rx="1.2" fill="#0A7C71"/><rect x="16" y="18.2" width="7" height="2.4" rx="1.2" fill="#0A7C71"/></svg> <span class="wordmark"><b>HAR</b>gus</span></span><span class="appbar-title">${esc(`Comparing ${listAnd(names)}`)}</span></header>
<main id="app">${renderCompare(model, { ...opts, interactive: false })}</main>
</body>
</html>
`;
}
