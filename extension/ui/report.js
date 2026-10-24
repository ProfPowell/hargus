// The reading report as markup: one pure function shared by the viewer, the standalone HTML export
// and the CLI. No DOM access — reading.js adds filters, dialogs, notes and exports on top.
// Layout: a sidebar plus one pane per section; CSS :target shows the current pane, so the
// exported file navigates without JavaScript.

import {
  AREAS, scoreReading, profileFromSettings, summarize, topFindings, resultArea, pluginArea, VERDICT,
} from '../core/score.js';
import { screenshotURL } from '../core/harplus.js';
import { detectInterstitial } from '../core/interstitial.js';
import { pluginEnabled } from '../core/plugin-host.js';
import {
  transferSize, hostOf, resourceType, formatBytes, formatMs, isThirdParty,
} from '../core/har-util.js';
import {
  shotsByView, baseView, shotView, compareViews, ratingFor, NOCSS_HIDDEN, VIEW_LABELS, DEVICE_VIEWS, RESILIENCE_VIEWS,
  INTERNATIONAL_VIEWS, VISION_VIEWS, DISPLAY_VIEWS, WCAG_VIEWS, A11Y_CLIP_EXTRA, A11Y_MIN_OVERFLOW, A11Y_FORCED_OPT_OUTS, extraClipped, reflowScroll, darkState,
  isBreakpointView, viewLabel, edgeOverflow, edgeClipExtra, edgePartner, EDGE_CLIP_MIN,
} from '../core/views.js';
import { html, esc, raw } from './html.js';
import { PHASES, phaseSegments, timelineModel, sortRows, midTrunc, displayUrl, requestFacts, wireText, lcpPath, pathSummary, groupRows, overviewLanes, isZoomed } from './waterfall.js';
import { h, renderResult, renderGlance } from './render.js';
import { referenceFor, wcagLabel } from '../core/a11y-reference.js';
import { placeMarks, keyboardPath, groupMarks, markDetails, CATEGORIES, CATEGORY, altLabel, MAX_MARKS } from '../core/page-map.js';

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
  let t0 = Infinity, tmax = -Infinity;
  for (const s of starts) { if (s < t0) t0 = s; if (s > tmax) tmax = s; }
  const span = Math.max(1, tmax - t0);
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

function interstitialCard(reading) {
  const hit = detectInterstitial(reading);
  if (!hit) return '';
  const vendor = hit.vendor !== 'unknown' ? ` (${hit.vendor})` : '';
  return html`<div class="card alert" role="note"><p><strong>This looks like a bot check or waiting page${vendor}, not the real page.</strong> The findings and scores describe that page. Detected from ${hit.reason}.</p></div>`;
}

function overviewPane(reading, plugins, scores) {
  const r = hp(reading);
  const t = r.target || {};
  const cap = r.capture || {};
  const shots = r.screenshots || [];
  const base = baseView(reading);
  let heroIndex = shots.findIndex((s) => s.kind === 'viewport' && shotView(s, base) === base);
  if (heroIndex < 0) heroIndex = shots.findIndex((s) => s.kind === 'thumbnail');
  const shot = shots[heroIndex];
  const o = scores.overall;
  const when = r.capturedAt ? new Date(r.capturedAt).toLocaleString() : '';
  const facts = [
    when,
    `Scored as ${o.profile?.label || 'General'}`,
    [cap.device || 'desktop', cap.throttle && cap.throttle !== 'none' ? cap.throttle : ''].filter(Boolean).join(' · '),
    `${cap.mode || 'reading'} mode`,
    cap.durationMs ? `${formatMs(cap.durationMs)} capture` : '',
    cap.source ? `imported from ${cap.source}` : '',
    t.url && t.finalUrl && t.url !== t.finalUrl ? `started at ${t.url}` : '',
    ...(r.tags || []).map((x) => `tag: ${x}`),
  ].filter(Boolean);
  return html`<section class="pane" id="overview" aria-labelledby="overview-h">
    ${interstitialCard(reading)}
    <div class="card hero">
      ${shot ? html`<img class="shot" src="${screenshotURL(shot)}" alt="Screenshot of the page" data-zoom="${heroIndex}">` : html`<div class="shot empty-shot">No screenshot</div>`}
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
    <p>The findings score starts at 100 and each finding deducts points — high 15, medium 6, low 2, info 0 — capped at 60, 30 and 15 per severity.${a.inputs.length > 1 ? ` Findings and ${a.inputs[1].label.toLowerCase()} are combined as ⅔ of the lower plus ⅓ of the higher, so the weaker one dominates.` : ''}</p>
    ${h.table(a.inputs.map((i) => ({ input: i.label, score: i.score })), [{ key: 'input', label: 'Input' }, { key: 'score', label: 'Score' }])}
    ${deducted.length ? h.table(deducted.map((d) => ({ finding: d.finding.title, severity: d.finding.severity, points: `−${d.points}` })), [
      { key: 'finding', label: 'Finding' }, { key: 'severity', label: 'Severity' }, { key: 'points', label: 'Points' },
    ]) : ''}
  </details>`;
}

function glances(ran, plugins, reading, interactive) {
  const ctx = { results: resultsOf(reading), target: hp(reading).target || {}, interactive };
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

function pluginPanel(r, plugins, ctx = {}) {
  return html`<details class="plugin" id="p-${r.id}"${r.id === 'a11y-map' ? raw(' open') : ''}>
    <summary>
      <span class="status-dot status-${r.status}" title="${r.status}"></span>
      <span class="name">${r.name}</span>
      ${r.findings?.length ? html`<span class="muted">${count(r.findings.length, 'finding')}</span>` : ''}
      <span class="meta">${r.status} · ${formatMs(r.durationMs)}${r.contacted?.length ? ` · contacted ${r.contacted.map((c) => `${c.host} ×${c.count}`).join(', ')}` : ''}</span>
    </summary>
    <div class="content">
      ${renderResult(byId(plugins, r.id), r, ctx)}
      ${r.data != null ? html`<details class="raw" data-raw="${r.id}"><summary>Raw data</summary></details>` : ''}
    </div>
  </details>`;
}

/**
 * A thumbnail of `box` (document coordinates, CSS px) cropped from the base view's full-page screenshot by CSS
 * alone: the shot is the background, sized and offset so the box fills a `size` px square (aspect kept, up to 3x).
 * `shared` leaves the image to a stylesheet rule (see cropKit) so a long table does not repeat the data URL.
 */
export function cropThumb(reading, box, size = 96, { shared = false, cls = 'crop' } = {}) {
  const shot = shotsByView(reading)[baseView(reading)]?.fullpage?.shot;
  const none = (w = size, hh = size) => html`<span class="crop crop-none" style="width:${w}px;height:${hh}px" aria-hidden="true"><span>not in screenshot</span></span>`;
  const W = Number(shot?.cssWidth);
  const H = Number(shot?.cssHeight);
  const [bx, by, bw, bh] = [box?.x, box?.y, box?.w, box?.h].map(Number);
  if (!(W > 0 && H > 0) || ![bx, by, bw, bh].every(Number.isFinite) || bw <= 0 || bh <= 0) return none();
  // the part of the box that lies inside the shot (a truncated page shot ends before the page does)
  const x0 = Math.max(0, bx);
  const y0 = Math.max(0, by);
  const x1 = Math.min(W, bx + bw);
  const y1 = Math.min(H, by + bh);
  if (x1 <= x0 || y1 <= y0) return none();
  const cw = x1 - x0;
  const ch = y1 - y0;
  const k = Math.min(size / Math.max(cw, ch), 3);
  const r2 = (n) => Math.round(n * 100) / 100;
  const style = `width:${r2(cw * k)}px;height:${r2(ch * k)}px;${shared ? '' : `background-image:url(${screenshotURL(shot)});`}background-size:${r2(W * k)}px ${r2(H * k)}px;background-position:-${r2(x0 * k)}px -${r2(y0 * k)}px`;
  return html`<span class="crop${shared ? ` ${cls}` : ''}" style="${style}" aria-hidden="true"></span>`;
}

/** What image-listing plugin panels get as `ctx.crop`: one stylesheet rule holding the screenshot, and thumb(box). Null without a full-page shot. */
const cropKits = new WeakMap();
/** FNV-1a of the whole string, base 36: a short class-safe token that changes with any character of the id. */
function shortHash(s) {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return x.toString(36);
}
let cropSeq = 0;
function cropKit(reading) {
  if (cropKits.has(reading)) return cropKits.get(reading);
  const shot = shotsByView(reading)[baseView(reading)]?.fullpage?.shot;
  let kit = null;
  if (shot) {
    // the rule is scoped to a class unique to this reading, so it cannot clash with another panel or reading
    const id = String(reading.id || reading.log?._harplus?.id || '');
    const cls = `crop-r${id ? shortHash(id) : ++cropSeq}`;
    kit = { cls, style: raw(`<style>.${cls}{background-image:url(${screenshotURL(shot)})}</style>`), thumb: (box) => cropThumb(reading, box, 96, { shared: true, cls }) };
  }
  cropKits.set(reading, kit);
  return kit;
}

/* --------------------------------------------------------------- Page map */

const mapModels = new WeakMap();
/**
 * The Page map for a reading: the frame it draws on (the base view's full-page shot, else its first screen) and the
 * a11y-map marks placed on it (core/page-map.js). Null when there are no marks. Memoised per a11y-map result.
 */
export function pageMapModel(reading) {
  const r = resultsOf(reading)['a11y-map'];
  if (r?.status !== 'ok' || !Array.isArray(r.data?.marks) || !r.data.marks.length) return null;
  if (mapModels.has(r)) return mapModels.get(r);
  const views = shotsByView(reading)[baseView(reading)] || {};
  const full = views.fullpage?.shot || null;
  const frame = full || views.viewport?.shot || null;
  const fit = frame ? placeMarks(r.data.marks, frame, r.data.doc || {}) : { placed: [], beyond: 0, dropped: 0, withheld: 0, mismatch: false };
  const model = {
    frame, full: !!full, viewportH: Number(views.viewport?.shot?.cssHeight) || 0, ...fit, total: r.data.marks.length,
    ambiguous: Number(r.data.marksAmbiguous) || 0, unresolved: Number(r.data.marksUnresolved) || 0,
  };
  mapModels.set(r, model);
  return model;
}

const glyphOf = (m) => m.glyph || CATEGORY[m.category]?.glyph || '•';
const catGlyph = (c) => (c === 'keyboard' ? '1' : CATEGORY[c]?.glyph || '•');
const markTitle = (m, i) => `#${i + 1} ${CATEGORY[m.category]?.one || m.category}: ${m.label}${m.sel ? ` — ${m.sel}` : ''}`;
const segPath = (segs) => segs.map(([p, q]) => `M${p[0]} ${p[1]}L${q[0]} ${q[1]}`).join('');

/**
 * The fix-it reference as paragraphs: what it is, why it matters, how to fix it, the WCAG success criteria (each a link
 * to its Understanding page) and the rule reference. `ref` is { what, why, fix, wcag, url }; wcag is a list of
 * { sc, name, url } or a plain string.
 */
export function referenceHtml(ref) {
  if (!ref || !(ref.what || ref.why || ref.fix || ref.wcag?.length || ref.url)) return '';
  const crit = (Array.isArray(ref.wcag) ? ref.wcag : ref.wcag ? [ref.wcag] : [])
    .map((w, i) => html`${i ? ', ' : ''}${typeof w === 'string' ? w : h.link(w.url, wcagLabel(w))}`);
  return html`${ref.what ? html`<p><b>What:</b> ${ref.what}</p>` : ''}
      ${ref.why ? html`<p><b>Why it matters:</b> ${ref.why}</p>` : ''}
      ${ref.fix ? html`<p><b>How to fix:</b> ${ref.fix}</p>` : ''}
      ${crit.length ? html`<p><b>WCAG:</b> ${crit}</p>` : ''}
      ${ref.url ? html`<p>${h.link(ref.url, 'Rule reference')}</p>` : ''}`;
}

/** A finding's reference from its plugin, id and (for axe) tags and help; the finding's own link stays beside it. */
const findingReference = (f) => f.area !== 'accessibility' ? null : referenceFor(f.plugin, f.id, f.tags, { help: String(f.title || '').replace(/^Needs review: /, '').replace(/\s*\(\d[\d,]*\)$/, '') });

/** One list group: a rule with its elements, each linked to its marker on the map; details open on demand. */
function mapGroup(g) {
  const first = g.items[0].mark;
  const d = markDetails(first);
  const founds = new Set(g.items.map(({ mark }) => mark.detail || ''));
  const shared = founds.size === 1 ? first.detail || '' : '';
  const a = g.items[0].index + 1;
  const b = g.items.at(-1).index + 1;
  return html`<li class="pm-group c-${g.category}"><details><summary><span class="pm-dot" aria-hidden="true">${catGlyph(g.category)}</span><b>${CATEGORY[g.category]?.one || g.category}</b> · ${g.rule} <span class="pm-n">${count(g.items.length, 'element')} · ${a === b ? `#${a}` : `#${a}–#${b}`}</span></summary>
    <div class="pm-gbody">
      ${shared ? html`<p><b>Found:</b> ${shared}</p>` : ''}
      ${referenceHtml(d)}
      <ul class="pm-rows">${g.items.map(({ mark, index }) => {
        const alt = altLabel(mark);
        return html`<li id="pm-i-${index + 1}" data-pm="${index}"><a class="pm-go" href="#pm-m-${index + 1}" aria-label="Marker ${index + 1}: show on the map">#${index + 1}</a>${mark.label !== g.rule ? html` ${mark.label}` : ''}${alt ? html` <span class="pm-li-alt">${alt}</span>` : ''}${mark.sel ? html` <code>${mark.sel}</code>` : ''}${!shared && mark.detail ? html`<div class="pm-found">${mark.detail}</div>` : ''}</li>`;
      })}</ul>
    </div></details></li>`;
}

/**
 * The Page map panel: WAVE-style markers over the screenshot at percentage positions, alt text on images, the
 * keyboard path, a legend whose checkboxes hide a category by CSS alone (sibling selectors, so the export works
 * without scripts), notes, and the markers listed by rule, each group a <details> with its elements linked to the map.
 */
function pageMapPanel(reading, kit, interactive) {
  const m = pageMapModel(reading);
  if (!m) return '';
  const { frame, placed } = m;
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c.id, 0]));
  for (const p of placed) counts[p.category] = (counts[p.category] || 0) + 1;
  const W = Number(frame?.cssWidth) || 0;
  const H = Number(frame?.cssHeight) || 0;
  const path = keyboardPath(placed, { frameH: H, viewportH: m.viewportH });
  const notes = [
    !frame ? 'No screenshot to draw the markers on.' : '',
    frame && !m.full ? 'No full-page screenshot: the map uses the first screen, and only markers inside it are drawn.' : '',
    m.mismatch ? `The page changed size between the screenshot and the marker positions (by more than 2%), so markers may be slightly off.${m.withheld ? ` ${count(m.withheld, 'marker', 'markers')} other than keyboard and structure ${m.withheld === 1 ? 'is' : 'are'} not drawn.` : ''}` : '',
    m.beyond ? `${count(m.beyond, 'marker lies', 'markers lie')} beyond the captured image.` : '',
    m.dropped ? `${m.dropped} more not drawn: the map draws at most ${MAX_MARKS} markers, errors first.` : '',
    m.ambiguous ? `${count(m.ambiguous, 'flagged element', 'flagged elements')} could not be pinned to one element and ${m.ambiguous === 1 ? 'is' : 'are'} not drawn.` : '',
    m.unresolved ? `${count(m.unresolved, 'flagged element', 'flagged elements')} could not be placed (not found, no size, inside a frame or shadow DOM, not reached in time, or pinned to the screen while the page was scrolled).` : '',
  ].filter(Boolean);
  const mark = (p, i) => {
    const alt = altLabel(p);
    return html`<span class="pm-mark c-${p.category}${alt ? ' pm-img' : ''}" id="pm-m-${i + 1}" data-pm="${i}" style="left:${p.left}%;top:${p.top}%;width:${p.width}%;height:${p.height}%;--slot:${p.slot || 0};--stack:${p.stack || 1}"><a class="pm-icon" href="#pm-i-${i + 1}" tabindex="-1" title="${markTitle(p, i)}">${glyphOf(p)}</a>${alt ? html`<span class="pm-alt">${alt}</span>` : ''}</span>`;
  };
  const hasPath = path.steps.length + path.jumps.length > 0;
  const canvas = frame ? html`<div class="pm-canvas${m.full && kit ? ` ${kit.cls}` : ''}" role="img" aria-label="Screenshot of the page with ${count(placed.length, 'marker', 'markers')}, listed below" style="max-width:${W}px;aspect-ratio:${W} / ${H}">
      ${m.full && kit ? '' : html`<img class="pm-shot" src="${screenshotURL(frame)}" alt="">`}
      ${hasPath ? html`<svg class="pm-path" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${path.steps.length ? html`<path class="halo" d="${segPath(path.steps)}"/><path class="step" d="${segPath(path.steps)}"/>` : ''}${path.jumps.length ? html`<path class="jump" d="${segPath(path.jumps)}"/>` : ''}</svg>` : ''}
      ${placed.map(mark)}
    </div>` : '';
  const errors = counts.error || 0;
  return html`<details class="plugin pm-panel" id="p-page-map" open>
    <summary><span class="status-dot status-${errors ? 'error' : 'ok'}" title="${errors ? count(errors, 'error') : 'no errors'}"></span><span class="name">Page map</span><span class="muted">${count(placed.length, 'marker')}${errors ? ` · ${count(errors, 'error')}` : ''}</span></summary>
    <div class="content"><div class="page-map">
      <p class="muted pm-intro">Markers on the page screenshot, as WAVE shows them. Untick a category to hide it. The list under the map groups the markers by rule; open a rule for its elements${interactive ? ', and choose a number to show that marker and its details' : ' and links to each marker'}.</p>
      ${CATEGORIES.map((c) => html`<input type="checkbox" class="pm-t" id="pm-t-${c.id}" checked><label class="pm-key c-${c.id}" for="pm-t-${c.id}"><span class="pm-dot" aria-hidden="true">${catGlyph(c.id)}</span>${c.label} <b>${counts[c.id]}</b></label>`)}
      ${hasPath ? html`<input type="checkbox" class="pm-t" id="pm-t-path" checked><label class="pm-key c-keyboard" for="pm-t-path"><span class="pm-line" aria-hidden="true"></span>Keyboard path</label>` : ''}
      ${notes.length ? html`<div class="pm-notes">${notes.map((n) => html`<p class="note">${n}</p>`)}</div>` : ''}
      ${interactive ? html`<div class="pm-detail" id="pm-detail" tabindex="-1" aria-live="polite" hidden></div>` : ''}
      ${frame ? html`<div class="pm-frame">${canvas}</div>` : ''}
      ${placed.length ? html`<ul class="pm-list">${groupMarks(placed).map(mapGroup)}</ul>` : ''}
    </div></div>
  </details>`;
}

function areaPane(area, reading, plugins, scores, settings, interactive) {
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
    ${glances(ran, plugins, reading, interactive)}
    <section class="card"><h2>Findings · ${list.length}</h2>${findingList(list.slice(0, 8), { showArea: false })}${list.length > 8 ? html`<a class="more" href="#findings">All findings →</a>` : ''}</section>
    <section class="plugin-detail"><h2>Plugin detail</h2>
      ${ran.length ? ran.map((r) => (r.id === 'a11y-map'
        ? html`${pluginPanel(r, plugins, { crop: cropKit(reading) })}${pageMapPanel(reading, cropKit(reading), interactive)}`
        : pluginPanel(r, plugins))) : html`<p class="muted">No plugins in this area ran.</p>`}
      ${interactive && notRun.length ? html`<p class="note">Not run: ${notRun.map((p) => `${p.name}${pluginEnabled(p, settings) ? '' : ' (disabled)'}`).join(', ')}. Enable plugins in the popup or Options, then re-run.</p>` : ''}
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
        ${(() => { const ref = findingReference(f); return ref ? html`<details class="fix"><summary>how to fix</summary><div class="ref">${referenceHtml(ref)}</div></details>` : ''; })()}
        ${f.evidence ? html`<details><summary>evidence</summary><pre>${typeof f.evidence === 'string' ? f.evidence : JSON.stringify(f.evidence, null, 2)}</pre></details>` : ''}
        ${f.ref ? html`<div class="detail">${h.link(f.ref, 'reference')}</div>` : ''}</td>
      <td><a href="#p-${f.plugin}">${f.pluginName}</a></td>
    </tr>`)}</tbody></table></div>`;
}

export const NET_PAGE = 200;

const statusClass = (e) => {
  const s = e.response?.status;
  if (e._error || !(s > 0) || s >= 500) return 'st-err';
  return s >= 400 ? 'st-warn' : s >= 300 ? 'st-redir' : 'st-ok';
};
const NET_COLUMNS = [['index', '#'], ['status', 'Status'], [null, 'Method'], ['type', 'Type'], ['name', 'Name'], ['size', 'Size'], ['time', 'Time']];
const fmtN = (n) => n.toLocaleString('en-US');
const ariaSort = (sort, key) => (sort.key === key ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none');
const sortMark = (sort, key) => (sort.key === key ? (sort.dir === 'desc' ? html`<span aria-hidden="true"> ▾</span>` : html`<span aria-hidden="true"> ▴</span>`) : '');
const phaseLabel = (key) => PHASES.find((p) => p.key === key)?.label || key;
const barTip = (b) => (b.known
  ? [`starts at ${formatMs(b.start)}`, ...b.segments.map((s) => `${phaseLabel(s.key)} ${formatMs(s.ms)}`)].join(' · ')
  : `no timing${b.start != null ? ` · starts at ${formatMs(b.start)}` : ''}`);

const OV_LANES = 12;

function overviewStrip(reading, model, full, path) {
  const onPath = new Set(path ? [...path.hops, ...path.blocking] : []);
  const w = model.window;
  const span = full.span;
  const pctOf = (ms) => Math.round((ms / span) * 10000) / 100;
  const handle = (edge, label, value) => html`<span class="ov-h" role="slider" tabindex="0" data-edge="${edge}" aria-label="${label}" aria-valuemin="0" aria-valuemax="${Math.round(span)}" aria-valuenow="${Math.round(value)}" aria-valuetext="${formatMs(value)}"></span>`;
  return html`<div class="wf-overview" id="wf-overview" data-span="${Math.round(span * 1000) / 1000}">
      <div class="ov-lanes" aria-hidden="true">${overviewLanes(full, OV_LANES).map((l) => html`<i class="${onPath.has(l.i) ? 'p' : ''}" style="left:${l.left}%;width:${l.width}%;top:${4 + l.lane * 3.5}px"></i>`)}</div>
      <div class="ov-brush" style="left:${pctOf(w.from)}%;width:${pctOf(w.to - w.from)}%">${handle('from', 'Zoom start', w.from)}${handle('to', 'Zoom end', w.to)}</div>
    </div>
    <p class="wf-zoom"><span id="wf-zoom-text">Showing ${formatMs(w.from)}–${formatMs(w.to)} of ${formatMs(span)}</span>
      <button type="button" data-wf-reset${isZoomed(w, span) ? '' : raw(' disabled')}>Reset zoom</button></p>`;
}

export function networkTable(reading, rows, { limit = NET_PAGE, sort = { key: 'index', dir: 'asc' }, interactive = true, window = null, path = null, groups = false, openGroups = new Set() } = {}) {
  const entries = reading.log.entries;
  if (!entries.length) return html`<p class="muted">No requests recorded.</p>`;
  const site = hp(reading).target?.site;
  // The export and print have no JavaScript: always the whole load, no path, no groups.
  if (!interactive) { window = null; path = null; groups = false; }
  const full = timelineModel(reading);
  const model = window ? timelineModel(reading, window) : full;
  const sorted = sortRows(rows, sort.key, sort.dir);
  const list = groups ? groupRows(sorted, site, full) : sorted;
  const items = list.slice(0, limit);
  const total = list.length;
  const noGroups = groups && !list.some((r) => r.group);
  const onPath = path ? new Set([...path.hops, ...path.blocking]) : null;
  const blocking = new Set(path ? path.blocking : []);
  const pathClass = (on) => (onPath ? (on ? 'on-path' : 'off-path') : '');
  const shownEntries = items.flatMap((x) => (x.group ? (openGroups.has(x.group) ? x.rows : []) : [x]));
  const present = new Set(shownEntries.flatMap(({ i }) => (model.bars[i].known ? model.bars[i].segments.map((s) => s.key) : [])));
  const bytes = rows.reduce((t, { e }) => t + transferSize(e), 0);
  const third = rows.filter(({ e }) => isThirdParty(hostOf(e.request.url), site)).length;
  const lines = html`${model.ticks.slice(1).map((t) => html`<i class="gl" style="left:${t.left}%"></i>`)}${model.markers.map((m) => html`<i class="mk mk-${m.key}" style="left:${m.left}%"></i>`)}`;
  const cues = (p) => html`${p.clipStart ? html`<i class="clip-cue s" aria-hidden="true">◂</i>` : ''}${p.clipEnd ? html`<i class="clip-cue e" aria-hidden="true">▸</i>` : ''}`;
  const clipCls = (p) => `${p.clipStart ? ' clip-s' : ''}${p.clipEnd ? ' clip-e' : ''}`;
  const lcpOk = Boolean(lcpPath(reading));

  const entryRow = ({ e, i }, member) => {
    const host = hostOf(e.request.url);
    let p = e.request.url;
    try { const u = new URL(e.request.url); p = u.pathname + u.search; } catch { /* keep raw */ }
    const isData = /^data:/i.test(e.request.url || '');
    const b = model.bars[i];
    const size = transferSize(e);
    const cls = [member ? 'grp-member' : '', pathClass(onPath?.has(i))].filter(Boolean).join(' ');
    return html`<tr data-entry="${i}"${cls ? raw(` class="${cls}"`) : ''}>
      ${interactive ? html`<td class="disc"><button type="button" class="disclose" aria-expanded="false" aria-controls="ed-${i}" aria-label="Details for request ${i + 1}">▸</button></td>` : ''}
      <td class="num">${i + 1}</td>
      <td><span class="st-chip ${statusClass(e)}">${e._error ? 'ERR' : e.response.status || '—'}</span></td>
      <td>${e.request.method}</td>
      <td class="type">${resourceType(e)}</td>
      <td class="url${isThirdParty(host, site) ? ' third' : ''}" title="${isData ? displayUrl(e.request.url) : e.request.url}">${isData ? displayUrl(e.request.url) : midTrunc(host + p, 64)}${blocking.has(i) ? html` <span class="rb-tag">blocks render</span>` : ''}</td>
      <td class="num" data-bytes="${size}">${formatBytes(size)}</td>
      <td class="num">${formatMs(e.time)}</td>
      <td class="tl"><div class="wf">${lines}${cues(b)}<span class="bar${b.known ? '' : ' none'}${clipCls(b)}" style="left:${b.left}%;width:${b.width}%" title="${barTip(b)}">${b.known ? b.segments.map((s) => html`<i class="ph-${s.key}" style="flex:${s.ms}"></i>`) : ''}</span></div></td>
    </tr>`;
  };

  const groupRow = (g) => {
    const open = openGroups.has(g.group);
    const p = model.place(g.start, g.end);
    const cls = ['grp', pathClass(g.rows.some((m) => onPath?.has(m.i)))].filter(Boolean).join(' ');
    return html`<tr class="${cls}" data-group="${g.group}">
      <td class="disc"><button type="button" class="disclose grp-disc" aria-expanded="${String(open)}" aria-label="Show ${g.count} requests from ${g.group}">${open ? '▾' : '▸'}</button></td>
      <td class="num"></td><td></td><td></td>
      <td>${fmtN(g.count)} requests</td>
      <td class="url third">${g.group}</td>
      <td class="num" data-bytes="${g.bytes}">${formatBytes(g.bytes)}</td>
      <td class="num">${formatMs(g.end - g.start)}</td>
      <td class="tl"><div class="wf">${lines}${cues(p)}<span class="bar grp-bar${clipCls(p)}" style="left:${p.left}%;width:${p.width}%" title="${g.group}: ${fmtN(g.count)} requests, ${formatMs(g.start)}–${formatMs(g.end)}"></span></div></td>
    </tr>${open ? g.rows.map((m) => entryRow(m, true)) : ''}`;
  };

  const toolbar = interactive ? html`<div class="wf-bar">
      <button type="button" class="tog" data-wf-path aria-pressed="${String(Boolean(path))}"${lcpOk ? '' : raw(' disabled title="No LCP recorded for this reading"')}><span aria-hidden="true">◆</span> LCP path</button>
      <button type="button" class="tog" data-wf-groups aria-pressed="${String(groups)}">Group by site</button>${noGroups ? html`<span class="muted wf-nogroups">no site has 2+ requests</span>` : ''}
    </div>
    ${overviewStrip(reading, model, full, path)}` : '';

  return html`${toolbar}
    <p class="note">${fmtN(rows.length)} of ${fmtN(entries.length)} requests · ${formatBytes(bytes)} transferred · ${fmtN(third)} third-party · span ${formatMs(full.span)}</p>
    ${path ? html`<p class="lcp-sum">${pathSummary(reading, path, new Set(rows.map((r) => r.i)))}</p>` : ''}
    <p class="wf-legend">${PHASES.filter((ph) => present.has(ph.key)).map((ph) => html`<span><i class="sw ph-${ph.key}"></i>${ph.label}</span>`)}${model.markers.map((m) => html`<span><i class="mk-key mk-${m.key}"></i>${m.label} ${formatMs(m.ms)}</span>`)}<span class="third">amber name = third-party</span></p>
    <div class="table-wrap net${interactive ? ' scroll' : ''}"><table class="data">
      <thead><tr>${interactive ? html`<th scope="col"><span class="sr-only">Details</span></th>` : ''}${NET_COLUMNS.map(([key, label]) => (key && interactive
        ? html`<th scope="col" aria-sort="${ariaSort(sort, key)}"><button type="button" class="sort" data-sort="${key}">${label}${sortMark(sort, key)}</button></th>`
        : html`<th scope="col">${label}</th>`))}
        ${interactive
          ? html`<th scope="col" class="tl-head" aria-sort="${ariaSort(sort, 'start')}"><button type="button" class="sort" data-sort="start">Timeline${sortMark(sort, 'start')}</button>`
          : html`<th scope="col" class="tl-head"><span class="tl-label">Timeline</span>`}
          <div class="ruler" aria-hidden="true">${model.ticks.map((t) => html`<span style="left:${t.left}%">${formatMs(t.ms)}</span>`)}</div></th></tr></thead>
      <tbody>${items.map((x) => (x.group ? groupRow(x) : entryRow(x, false)))}</tbody>
    </table></div>
    ${total > items.length ? html`<p class="note net-more">Showing ${fmtN(items.length)} of ${fmtN(total)} · <button type="button" data-net-more>Show ${fmtN(Math.min(NET_PAGE, total - items.length))} more</button></p>` : ''}`;
}

/* ------------------------------------------------------- one request, inline */

const DETAIL_TABS = [['overview', 'Overview'], ['timing', 'Timing'], ['headers', 'Headers'], ['wire', 'Wire'], ['body', 'Body']];
const fineMs = (v) => (v < 10 ? `${v.toFixed(1)} ms` : formatMs(v));

function timingPanel(e, entries, i) {
  const t = e.timings || {};
  const { segments } = phaseSegments(t, e.time);
  const total = segments.reduce((s, x) => s + x.ms, 0) || 1;
  const reused = e.connection && entries.slice(0, i).some((x) => x.connection === e.connection);
  let at = 0;
  const pos = Object.fromEntries(segments.map((s) => { const p = { left: (at / total) * 100, width: (s.ms / total) * 100, ms: s.ms }; at += s.ms; return [s.key, p]; }));
  return html`<div class="phases">${PHASES.map(({ key, label }) => {
    const p = pos[key];
    const text = p ? fineMs(p.ms) : reused && ['dns', 'connect', 'ssl'].includes(key) ? '— reused' : '—';
    return html`<div class="ph-row"><span>${label}</span><span class="ph-track">${p ? html`<b class="ph-${key}" style="left:${p.left.toFixed(2)}%;width:${Math.max(0.5, p.width).toFixed(2)}%"></b>` : ''}</span><span class="num">${text}</span></div>`;
  })}</div>`;
}

function headersPanel(e) {
  const rows = (hs) => (hs || []).map((x) => ({ name: x.name, value: x.value }));
  return html`${h.sub('Request headers', h.table(rows(e.request.headers), ['name', 'value']))}
    ${h.sub('Response headers', h.table(rows(e.response.headers), ['name', 'value']))}
    ${h.sub('Query string', h.table(e.request.queryString || [], ['name', 'value']))}
    ${h.sub('Request cookies', h.table(e.request.cookies || [], ['name', 'value']))}
    ${h.sub('Response cookies', h.table(e.response.cookies || [], ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite']))}`;
}

const wireLine = (l) => (l.kind === 'header' ? html`<span class="w-h">${l.name}:</span>${l.text.slice(l.name.length + 1)}\n`
  : l.kind === 'start' ? html`<span class="w-s">${l.text}</span>\n`
    : l.kind === 'more' ? html`<span class="muted">${l.text}</span>\n`
      : html`${l.text}\n`);

function wirePanel(e) {
  const w = wireText(e);
  return html`<div class="wire"><pre aria-label="Request">${w.request.map(wireLine)}</pre><pre aria-label="Response">${w.response.map(wireLine)}</pre></div>`;
}

function bodyPanel(e) {
  const c = e.response.content || {};
  let body = '';
  if (c.text && c.encoding === 'base64' && /^image\//.test(c.mimeType)) body = html`<img src="data:${c.mimeType};base64,${c.text}" alt="Response image" style="max-width:100%">`;
  else if (c.text && c.encoding !== 'base64') body = html`<pre class="json">${c.text.slice(0, 100_000)}${c.text.length > 100_000 ? '\n… (truncated)' : ''}</pre>`;
  return html`${e.request.postData?.text ? h.sub('Request body', html`<pre class="json">${e.request.postData.text}</pre>`) : ''}
    ${body ? h.sub('Response body', body) : ''}`;
}

/** The expanded row: Overview (plain-English facts), Timing, Headers, Wire, Body. reading.js inserts it and switches tabs. */
export function requestDetail(reading, i) {
  const entries = reading.log.entries;
  const e = entries[i];
  const t = hp(reading).target || {};
  const b = timelineModel(reading).bars[i];
  const facts = requestFacts(e, { entries, index: i, pageUrl: t.finalUrl || t.url, site: t.site, renderBlocking: resultsOf(reading).vitals?.data?.renderBlocking, start: b.start });
  const panels = { overview: h.kv(facts), timing: timingPanel(e, entries, i), headers: headersPanel(e), wire: wirePanel(e), body: bodyPanel(e) };
  const id = `ed-${i}`;
  return html`<div class="req-detail">
    <div role="tablist" aria-label="Request ${i + 1} details">${DETAIL_TABS.map(([k, label], n) => html`<button type="button" role="tab" id="${id}-t-${k}" aria-controls="${id}-p-${k}" aria-selected="${String(n === 0)}" tabindex="${n === 0 ? 0 : -1}" data-tab="${k}">${label}</button>`)}</div>
    ${DETAIL_TABS.map(([k], n) => html`<div role="tabpanel" id="${id}-p-${k}" aria-labelledby="${id}-t-${k}" tabindex="0"${n ? raw(' hidden') : ''}>${String(panels[k]).trim() ? panels[k] : html`<p class="muted">Nothing recorded.</p>`}</div>`)}
  </div>`;
}

function findingsPane(scores) {
  return html`<section class="pane" id="findings" aria-labelledby="findings-h">
    <header class="pane-head"><h1 id="findings-h">All findings</h1><div class="tools" id="findings-tools"></div></header>
    <div id="findings-table">${findingsTable(topFindings(scores, Infinity, null, { includeInfo: true }))}</div>
  </section>`;
}

function networkPane(reading, plugins, interactive) {
  const net = resultsOf(reading).network;
  const p = byId(plugins, 'network');
  return html`<section class="pane" id="network" aria-labelledby="network-h">
    <header class="pane-head"><h1 id="network-h">Network</h1><div class="tools" id="network-tools"></div></header>
    ${net?.status === 'ok' && p ? renderGlance(p, net, { results: resultsOf(reading), target: hp(reading).target || {} }) : ''}
    <div id="net-table">${networkTable(reading, reading.log.entries.map((e, i) => ({ e, i })), { limit: interactive ? NET_PAGE : Infinity, interactive })}</div>
  </section>`;
}

const pct = (r) => `${Math.round(r * 100)}%`;

function ratingChip(text, rating) {
  const name = rating === 'good' ? 'ok' : rating === 'poor' ? 'fail' : 'up';
  return html`<span class="chip-r rating-${rating}">${h.icon(name, { size: 12 })}${text}</span>`;
}

function viewChips(id, c, baseM) {
  if (!c) return '';
  if (id === 'nojs') return html`${ratingChip(`${pct(c.textRatio)} of text`, ratingFor(c.textRatio))}${ratingChip(`${pct(c.linkRatio)} of links`, baseM && baseM.links < 5 ? 'good' : ratingFor(c.linkRatio))}`;
  if (id === 'nocss') return ratingChip(`${pct(c.textRatio)} of text`, c.textRatio > NOCSS_HIDDEN ? 'needs-improvement' : 'good');
  if (id === 'noimages') return ratingChip(`${c.imagesWithAlt} of ${c.images} images have alt text`, c.images && c.imagesWithAlt < c.images ? 'needs-improvement' : 'good');
  return '';
}

function intlChips(id, m, baseM, extra = {}) {
  if (!m) return '';
  if (id === 'pseudo' && !baseM) return '';
  if (id.startsWith('translated-')) {
    if (extra.status && extra.status !== 'ok') return ratingChip("couldn't be verified", 'needs-improvement');
    if (id === 'translated-ar' && extra.rtl) baseM = extra.rtl;
    if (!baseM) return '';
  }
  const sideways = m.overflowX > 0 && !(baseM?.overflowX > 0);
  if (id === 'rtl') return sideways ? ratingChip('scrolls sideways', 'poor') : ratingChip('fits', 'good');
  const more = Math.max(0, extraClipped(m, baseM)); // 0 when either walk was truncated
  if (id !== 'pseudo' && !more && !sideways) return ratingChip('fits', 'good');
  return html`${ratingChip(`+${more} clipped`, more === 0 ? 'good' : more < 3 ? 'needs-improvement' : 'poor')}${sideways ? ratingChip('scrolls sideways', 'poor') : ''}`;
}

/** Above-the-fold and full-page images for one view; CSS shows one, picked by the section's switch. */
function viewImages(entry, label) {
  const img = (e, cls, what) => (e ? html`<img class="${cls}" src="${screenshotURL(e.shot)}" alt="${label} — ${what}" data-zoom="${e.index}" loading="lazy">` : '');
  return html`<div class="frame">${img(entry.viewport, 'shot-fold', 'above the fold')}${img(entry.fullpage || entry.viewport, 'shot-full', 'full page')}</div>`;
}

/** One above-the-fold image (accessibility views keep no full-page shot). */
function foldImage(entry, label) {
  const e = entry.viewport || entry.fullpage;
  return html`<div class="frame"><img src="${screenshotURL(e.shot)}" alt="${label} — above the fold" data-zoom="${e.index}" loading="lazy"></div>`;
}

/** The a11y-views plugin's verdicts ({ [view]: ok }), or null when it has no usable result. */
function a11yVerdicts(reading) {
  const r = resultsOf(reading)['a11y-views'];
  if (r?.status !== 'ok' || !Array.isArray(r.data?.checks)) return null;
  return Object.fromEntries(r.data.checks.map((c) => [c.id, !!c.ok]));
}

/**
 * One chip for a measured accessibility view. The text describes the measurement; the rating is the
 * plugin's verdict (good or poor) and, without one, the same check made locally with the plugin's thresholds.
 */
function a11yChips(id, m, baseM, { verdict, prefs = {}, css = {} } = {}) {
  if (!m || !baseM) return '';
  const n = (v) => Number(v) || 0;
  const extra = extraClipped(m, baseM);
  const clips = extra >= A11Y_CLIP_EXTRA;
  const newOverflow = n(m.overflowX) > n(baseM.overflowX);
  let text;
  let ok;
  if (id === 'reflow') {
    const over = m.scrollsX === false ? 0 : reflowScroll(m, baseM); // scrollsX false: the page could not really scroll sideways
    ok = !over && !clips;
    const o = (m.overflowers || [])[0];
    text = [over ? `${over} px overflow${o ? ` · ${o.selector}` : ''}` : '', clips ? `+${extra} clipped` : ''].filter(Boolean).join(', ') || (ok ? 'fits' : `+${Math.max(0, extra)} clipped`);
  } else if (id === 'spacing') {
    ok = !clips && !newOverflow;
    text = `+${Math.max(0, extra)} clipped`;
    // As for 200% text: scrolling sideways (measured, past the floor) without clipping is "needs improvement", not green.
    // Older readings without scrollsX keep the verdict above.
    const scrolls = !clips && m.scrollsX === true && n(m.overflowX) - n(baseM.overflowX) >= A11Y_MIN_OVERFLOW;
    if (scrolls && (verdict ?? true)) return ratingChip(text, 'needs-improvement');
  } else if (id === 'text200') {
    const scrolls = !clips && newOverflow && m.scrollsX !== false;
    ok = n(m.bodyFont) > n(baseM.bodyFont) && !clips && !scrolls;
    text = `${n(baseM.bodyFont)} → ${n(m.bodyFont)} px`;
    // The plugin rates sideways scrolling "needs improvement" without failing the check, so a passing verdict is not green here.
    if (scrolls && (verdict ?? n(m.bodyFont) > n(baseM.bodyFont))) return ratingChip(text, 'needs-improvement');
  } else if (id === 'dark') {
    const state = darkState(m, baseM);
    if (!state) return '';
    ok = state !== 'no change';
    text = state;
  } else if (id === 'forced') {
    const issues = [n(m.iconOnly) ? `${n(m.iconOnly)} icon-only controls` : '', n(m.forcedNone) >= A11Y_FORCED_OPT_OUTS ? `${n(m.forcedNone)} opt-outs` : ''].filter(Boolean);
    ok = !issues.length;
    text = issues.join(', ') || 'clean';
  } else if (id === 'morecontrast') {
    ok = verdict ?? !!(prefs.mediaFeatures?.['prefers-contrast'] || css.mediaFeatures?.['prefers-contrast']);
    text = ok ? 'clean' : 'no contrast styles';
  } else if (id === 'print') {
    const overlays = Array.isArray(m.fixed) ? m.fixed.length : 0;
    const printStyles = !!prefs.mediaPrint || Object.keys(css.media || {}).some((k) => /\bprint\b/i.test(k));
    const issues = [m.chrome ? 'site chrome prints' : '', overlays ? `${overlays} overlay${overlays === 1 ? '' : 's'}` : '', printStyles ? '' : 'no print styles'].filter(Boolean);
    ok = !issues.length;
    text = issues.join(', ') || 'clean';
  } else {
    return '';
  }
  return ratingChip(text, (verdict ?? ok) ? 'good' : 'poor');
}

/** Chips for a breakpoint-edge view: sideways scroll (0 when the root clips), else extra clipped text, else fits. */
function bpChip(id, views, baseM) {
  const m = views[id];
  if (!m) return '';
  const o = (m.overflowers || [])[0];
  if (edgeOverflow(m) > 0) return ratingChip(`scrolls sideways${o ? ` · ${o.selector}` : ''}`, 'poor');
  const extra = edgeClipExtra(m, views[edgePartner(id)], baseM);
  return extra >= EDGE_CLIP_MIN ? ratingChip(`+${extra} clipped`, 'needs-improvement') : ratingChip('fits', 'good');
}

const shotSwitch = (name) => html`<span class="seg" role="radiogroup" aria-label="Screenshot extent">
  <label><input type="radio" name="${name}" value="fold" checked> Above the fold</label>
  <label><input type="radio" name="${name}" value="full"> Full page</label></span>`;

const checkNote = (c) => (c && c.ok === false ? html`<span class="view-check">May not reflect the setting — ${c.detail}</span>` : '');

function screensPane(reading) {
  const by = shotsByView(reading);
  const base = baseView(reading);
  const devices = DEVICE_VIEWS.filter((v) => by[v]);
  const resilient = RESILIENCE_VIEWS.filter((v) => by[v]);
  const intl = INTERNATIONAL_VIEWS.filter((v) => by[v]);
  const cmp = compareViews(hp(reading).capture?.views, base);
  const vision = VISION_VIEWS.filter((v) => by[v]);
  const measuredA11y = [...DISPLAY_VIEWS, ...WCAG_VIEWS].filter((v) => by[v]);
  const mv = hp(reading).capture?.views || {};
  const bpIds = Object.keys(by).filter(isBreakpointView).sort((a, b) => {
    const n = (id) => Number(id.match(/\d+/)[0]);
    return n(a) - n(b) || (a.endsWith('below') ? -1 : 1);
  });
  const checks = hp(reading).capture?.viewChecks || {};
  const verdicts = a11yVerdicts(reading);
  const cssResult = resultsOf(reading).css;
  const a11yCtx = (v) => ({ verdict: verdicts?.[v], prefs: hp(reading).capture?.prefs || {}, css: cssResult?.status === 'ok' ? cssResult.data || {} : {} });
  const sizeOf = (v) => (by[v].viewport || by[v].fullpage).shot;
  const total = devices.reduce((n, v) => n + (Number(sizeOf(v).cssWidth) || 0), 0) || 1;
  return html`<section class="pane" id="screens" aria-labelledby="screens-h"><h1 id="screens-h">Screens</h1>
    ${devices.length ? html`<section class="card views">
      <header class="views-head"><h2>Devices</h2>${shotSwitch('devices-shot')}</header>
      <div class="lineup">${devices.map((v) => {
        const s = sizeOf(v);
        return html`<figure style="flex:0 1 ${(((Number(s.cssWidth) || 0) / total) * 100).toFixed(2)}%">${viewImages(by[v], VIEW_LABELS[v])}<figcaption><b>${VIEW_LABELS[v]}</b> · ${s.cssWidth}×${s.cssHeight}${checkNote(checks[v])}</figcaption></figure>`;
      })}</div>
    </section>` : html`<p class="muted">No screenshots in this reading.</p>`}
    ${resilient.length && by[base] ? html`<section class="card views">
      <header class="views-head"><h2>Resilience</h2>${shotSwitch('resilience-shot')}</header>
      <div class="resilience">
        <figure>${viewImages(by[base], 'As designed')}<figcaption><b>As designed</b></figcaption></figure>
        ${resilient.map((v) => html`<figure>${viewImages(by[v], VIEW_LABELS[v])}<figcaption><b>${VIEW_LABELS[v]}</b>${viewChips(v, cmp?.views[v], cmp?.views[base])}${checkNote(checks[v])}</figcaption></figure>`)}
      </div>
    </section>` : ''}
    ${intl.length && by[base] ? html`<section class="card views">
      <header class="views-head"><h2>International</h2>${shotSwitch('international-shot')}</header>
      <div class="resilience">
        <figure>${viewImages(by[base], 'As designed')}<figcaption><b>As designed</b></figcaption></figure>
        ${intl.map((v) => html`<figure>${viewImages(by[v], VIEW_LABELS[v])}<figcaption><b>${VIEW_LABELS[v]}</b>${intlChips(v, hp(reading).capture?.views?.[v], hp(reading).capture?.views?.[base], { rtl: hp(reading).capture?.views?.rtl, status: hp(reading).capture?.translation?.[v]?.status })}${checkNote(checks[v])}</figcaption></figure>`)}
      </div>
    </section>` : ''}
    ${vision.length || measuredA11y.length ? html`<section class="card views a11y-views">
      <header class="views-head"><h2>Accessibility views</h2></header>
      ${vision.length && by[base] ? html`<h3>Vision</h3><div class="resilience vision-grid">
        <figure>${foldImage(by[base], 'As designed')}<figcaption><b>As designed</b></figcaption></figure>
        ${vision.map((v) => html`<figure>${foldImage(by[v], VIEW_LABELS[v])}<figcaption><b>${VIEW_LABELS[v]}</b>${checkNote(checks[v])}</figcaption></figure>`)}
      </div>` : ''}
      ${measuredA11y.length ? html`<h3>Display and WCAG</h3><div class="resilience">
        ${measuredA11y.map((v) => html`<figure>${foldImage(by[v], VIEW_LABELS[v])}<figcaption><b>${VIEW_LABELS[v]}</b>${a11yChips(v, mv[v], mv[base], a11yCtx(v))}${checkNote(checks[v])}</figcaption></figure>`)}
      </div>` : ''}
    </section>` : ''}
    ${bpIds.length ? html`<section class="card views">
      <header class="views-head"><h2>Breakpoints</h2></header>
      <div class="resilience">${bpIds.map((v) => html`<figure>${foldImage(by[v], viewLabel(v))}<figcaption><b>${viewLabel(v)}</b>${bpChip(v, mv, mv[base])}${checkNote(checks[v])}</figcaption></figure>`)}</div>
    </section>` : ''}
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

export function renderReport(reading, plugins, { settings = {}, scores = scoreReading(reading, plugins, { profile: profileFromSettings(settings) }), interactive = true } = {}) {
  return String(html`<div class="report">
    ${sidebar(reading, scores)}
    <div class="panes">
      ${overviewPane(reading, plugins, scores)}
      ${AREAS.map((a) => areaPane(a, reading, plugins, scores, settings, interactive))}
      ${findingsPane(scores)}
      ${networkPane(reading, plugins, interactive)}
      ${screensPane(reading)}
      ${notesPane(reading, interactive)}
    </div>
  </div>`);
}

/** A self-contained report file: inlined CSS, embedded screenshots, :target navigation, no scripts. */
export function standaloneDocument(reading, plugins, { css = '', scores, settings = {} } = {}) {
  const t = hp(reading).target || {};
  const title = `${t.title || t.host || 'Reading'} — HARgus report`;
  const safeCss = String(css).replace(/</g, '\\3C '); // CSS escape: nothing in the stylesheet can close <style>
  const when = hp(reading).capturedAt ? new Date(hp(reading).capturedAt).toLocaleString() : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="HARgus">
<title>${esc(title)}</title>
<style>${safeCss}</style>
</head>
<body class="reading standalone">
<header class="appbar"><span class="brand"><svg class="mark" viewBox="0 0 32 32" width="24" height="24" aria-hidden="true"><path d="M2 16c3.8-6.2 8.4-9.3 14-9.3s10.2 3.1 14 9.3c-3.8 6.2-8.4 9.3-14 9.3S5.8 22.2 2 16z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><rect x="9" y="11.4" width="7" height="2.4" rx="1.2" fill="#0A7C71"/><rect x="12" y="14.8" width="9" height="2.4" rx="1.2" fill="#0A7C71"/><rect x="16" y="18.2" width="7" height="2.4" rx="1.2" fill="#0A7C71"/></svg> <span class="wordmark"><b>HAR</b>gus</span></span><span class="appbar-title">${esc([t.title || t.host, t.finalUrl || t.url, when].filter(Boolean).join(' · '))}</span></header>
<main id="app">${renderReport(reading, plugins, { scores, settings, interactive: false })}</main>
</body>
</html>
`;
}
