// One reading card in the library. Pure markup: no DOM access, so it can be tested in node.

import { formatBytes } from '../core/har-util.js';
import { grade, VERDICT } from '../core/score.js';
import { html, h } from './render.js';

export const RECORD_NO_COMPARE = "Recordings of several pages can't be compared yet";

const inSet = (set, id) => (set.rounds || []).some((rd) => (rd.readings || []).some((e) => e.id === id));

/** One reading card; with { selectable, sets } it gains a checkbox, set chips and an Add to set button. */
export function cardHtml(r, opts) {
  const selectable = !!(opts && opts.selectable && typeof opts === 'object');
  const mine = selectable ? (opts.sets || []).filter((s) => inSet(s, r.id)) : [];
  const noCompare = r.mode === 'record';
  const c = r.counts || {};
  const sevs = ['high', 'medium', 'low'].filter((s) => c[s]);
  const g = r.score != null ? grade(r.score) : null;
  const verdict = VERDICT[r.status];
  return html`<article class="reading-card">
    ${selectable ? html`<label class="pick"${noCompare ? html` title="${RECORD_NO_COMPARE}"` : ''}><input type="checkbox" data-select="${r.id}" aria-label="Select ${r.title} to compare"${noCompare ? ' disabled' : ''}></label>` : ''}
    ${r.thumb ? html`<img class="shot" src="${r.thumb}" alt="" loading="lazy">` : html`<div class="shot"></div>`}
    ${r.score != null ? html`<div class="card-score">${h.ring({ value: r.score, size: 40, status: r.status, label: 'Overall score' })}<small class="card-grade">${[g, verdict].filter(Boolean).join(' · ')}</small></div>` : ''}
    <div class="body">
      <h3><a href="reading.html?id=${r.id}">${r.title}</a></h3>
      <div class="host">${r.host}</div>
      ${r.pending ? html`<span class="chip pending" title="Open to finish the lookups">Finishing…</span>` : ''}
      ${sevs.length ? html`<div class="chips">${sevs.map((s) => html`<span class="chip" title="${s} findings">${h.sev(s, { word: false, sr: `${c[s]} ${s}` })} <span aria-hidden="true">${c[s]}</span></span>`)}</div>` : ''}
      <div class="meta">${new Date(r.capturedAt).toLocaleString()} · ${r.entries} requests · ${formatBytes(r.bytes)} · ${r.mode}${r.runs > 1 ? ` · ×${r.runs}` : ''}${r.device && r.device !== 'desktop' ? ` · ${r.device}` : ''}</div>
      ${r.tags?.length ? html`<div>${r.tags.map((t) => html`<span class="tag">${t}</span>`)}</div>` : ''}
      ${mine.length ? html`<div class="chips">${mine.map((s) => html`<a class="chip set-chip" href="compare.html?set=${s.id}">${s.name}</a>`)}</div>` : ''}
      <div class="card-actions">${selectable ? html`<button class="btn ghost" type="button" data-add-menu="${r.id}" aria-haspopup="true" aria-expanded="false">Add to set</button>` : ''}<button class="btn ghost danger" type="button" data-delete="${r.id}">Delete</button></div>
    </div>
  </article>`;
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return String(url); } };

/** One set card: name, site initials, round count, last round date, and its three actions. */
export function setCardHtml(set) {
  const rounds = set.rounds || [];
  const last = rounds.length ? rounds[rounds.length - 1].at : null;
  const urls = set.urls || [];
  return html`<article class="set-card">
    <h3>${set.name}</h3>
    <div class="set-favs">${urls.map((u) => html`<span class="cmp-fav" title="${hostOf(u)}" aria-hidden="true">${hostOf(u).charAt(0).toUpperCase() || '?'}</span>`)}</div>
    <div class="meta">${urls.length} ${urls.length === 1 ? 'site' : 'sites'} · ${rounds.length ? `${rounds.length} ${rounds.length === 1 ? 'round' : 'rounds'} · last ${new Date(last).toLocaleDateString()}` : 'no rounds yet'}</div>
    <div class="set-progress" data-progress="${set.id}"></div>
    <div class="card-actions">
      <a class="btn" href="compare.html?set=${set.id}">Compare</a>
      <button class="btn" type="button" data-record="${set.id}">Record again</button>
      <button class="btn ghost danger" type="button" data-delete-set="${set.id}">Delete</button>
    </div>
  </article>`;
}
