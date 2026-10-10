import { listReadings, deleteReading, saveReading } from '../browser/store.js';
import { getSettings } from '../browser/settings.js';
import { ensureHarPlus } from '../core/harplus.js';
import { runPlugins } from '../core/plugin-host.js';
import { formatBytes } from '../core/har-util.js';
import { getPlugins } from '../plugins/index.js';
import { html, h, toast } from './render.js';

const $ = (s) => document.querySelector(s);
let all = [];

function card(r) {
  const c = r.counts || {};
  const sevs = ['high', 'medium', 'low'].filter((s) => c[s]);
  return html`<article class="reading-card">
    ${r.thumb ? html`<img class="shot" src="${r.thumb}" alt="" loading="lazy">` : html`<div class="shot"></div>`}
    ${r.score != null ? html`<div class="card-score">${h.ring({ value: r.score, size: 40, status: r.status, label: 'Overall score' })}</div>` : ''}
    <div class="body">
      <h3><a href="reading.html?id=${r.id}">${r.title}</a></h3>
      <div class="host">${r.host}</div>
      ${r.pending ? html`<span class="chip pending" title="Open to finish the lookups">Finishing…</span>` : ''}
      ${sevs.length ? html`<div class="chips">${sevs.map((s) => html`<span class="chip" title="${s} findings"><span class="sev sev-${s}">${c[s]}</span></span>`)}</div>` : ''}
      <div class="meta">${new Date(r.capturedAt).toLocaleString()} · ${r.entries} requests · ${formatBytes(r.bytes)} · ${r.mode}${r.device && r.device !== 'desktop' ? ` · ${r.device}` : ''}</div>
      ${r.tags?.length ? html`<div>${r.tags.map((t) => html`<span class="tag">${t}</span>`)}</div>` : ''}
      <div class="card-actions"><button class="btn ghost danger" type="button" data-delete="${r.id}">Delete</button></div>
    </div>
  </article>`;
}

function render() {
  const q = $('#q').value.trim().toLowerCase();
  const sort = $('#sort').value;
  let rows = all.filter((r) => !q || [r.title, r.host, r.url, r.notes, ...(r.tags || [])].join(' ').toLowerCase().includes(q));
  const issues = (r) => (r.counts?.high || 0) * 100 + (r.counts?.medium || 0);
  if (sort === 'old') rows = rows.reverse();
  if (sort === 'host') rows = [...rows].sort((a, b) => a.host.localeCompare(b.host));
  if (sort === 'issues') rows = [...rows].sort((a, b) => issues(b) - issues(a));
  $('#count').textContent = all.length ? `${rows.length} of ${all.length} readings` : '';
  $('#list').innerHTML = rows.length ? String(html`${rows.map(card)}`)
    : String(html`<p class="empty">${all.length ? 'No readings match.' : 'No readings yet. Open a page, click the HAR+ toolbar button and take a reading — or import a HAR file.'}</p>`);
}

async function load() {
  all = await listReadings();
  render();
}

$('#q').addEventListener('input', render);
$('#sort').addEventListener('change', render);

$('#list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-delete]');
  if (!btn) return;
  if (btn.dataset.armed) {
    await deleteReading(btn.dataset.delete);
    toast('Reading deleted');
    load();
  } else {
    btn.dataset.armed = '1';
    btn.textContent = 'Confirm delete';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Delete'; }, 4000);
  }
});

$('#import').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  const settings = await getSettings();
  const plugins = getPlugins(settings);
  const phases = $('#import-lookups').checked ? ['analyze', 'enrich'] : ['analyze'];
  for (const file of files) {
    try {
      toast(`Analyzing ${file.name}…`);
      const reading = ensureHarPlus(JSON.parse(await file.text()), { fileName: file.name });
      const hp = reading.log._harplus;
      if (all.some((r) => r.id === hp.id)) {
        hp.id = crypto.randomUUID(); // re-importing an export: keep both rather than overwrite notes
        hp.importedAt = new Date().toISOString();
      }
      await runPlugins(reading, plugins, { phases, settings });
      hp.analysis = 'done';
      await saveReading(reading);
    } catch (err) {
      toast(`${file.name}: ${err.message}`, 6000);
    }
  }
  e.target.value = '';
  load();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'harplus:progress' && (msg.stage === 'done' || (msg.stage === 'analyzing' && msg.readingId))) load();
});

load();
