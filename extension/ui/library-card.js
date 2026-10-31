// One reading card in the library. Pure markup: no DOM access, so it can be tested in node.

import { formatBytes } from '../core/har-util.js';
import { grade, VERDICT } from '../core/score.js';
import { html, h } from './render.js';

export function cardHtml(r) {
  const c = r.counts || {};
  const sevs = ['high', 'medium', 'low'].filter((s) => c[s]);
  const g = r.score != null ? grade(r.score) : null;
  const verdict = VERDICT[r.status];
  return html`<article class="reading-card">
    ${r.thumb ? html`<img class="shot" src="${r.thumb}" alt="" loading="lazy">` : html`<div class="shot"></div>`}
    ${r.score != null ? html`<div class="card-score">${h.ring({ value: r.score, size: 40, status: r.status, label: 'Overall score' })}<small class="card-grade">${[g, verdict].filter(Boolean).join(' · ')}</small></div>` : ''}
    <div class="body">
      <h3><a href="reading.html?id=${r.id}">${r.title}</a></h3>
      <div class="host">${r.host}</div>
      ${r.pending ? html`<span class="chip pending" title="Open to finish the lookups">Finishing…</span>` : ''}
      ${sevs.length ? html`<div class="chips">${sevs.map((s) => html`<span class="chip" title="${s} findings">${h.sev(s, { word: false, sr: `${c[s]} ${s}` })} <span aria-hidden="true">${c[s]}</span></span>`)}</div>` : ''}
      <div class="meta">${new Date(r.capturedAt).toLocaleString()} · ${r.entries} requests · ${formatBytes(r.bytes)} · ${r.mode}${r.runs > 1 ? ` · ×${r.runs}` : ''}${r.device && r.device !== 'desktop' ? ` · ${r.device}` : ''}</div>
      ${r.tags?.length ? html`<div>${r.tags.map((t) => html`<span class="tag">${t}</span>`)}</div>` : ''}
      <div class="card-actions"><button class="btn ghost danger" type="button" data-delete="${r.id}">Delete</button></div>
    </div>
  </article>`;
}
