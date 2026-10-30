import { listReadings, deleteReading, saveReading } from '../browser/store.js';
import { getSettings } from '../browser/settings.js';
import { ensureHarPlus } from '../core/harplus.js';
import { runPlugins } from '../core/plugin-host.js';
import { getPlugins } from '../plugins/index.js';
import { html, toast } from './render.js';
import { cardHtml } from './library-card.js';

const $ = (s) => document.querySelector(s);
let all = [];

function render() {
  const q = $('#q').value.trim().toLowerCase();
  const sort = $('#sort').value;
  let rows = all.filter((r) => !q || [r.title, r.host, r.url, r.notes, ...(r.tags || [])].join(' ').toLowerCase().includes(q));
  const issues = (r) => (r.counts?.high || 0) * 100 + (r.counts?.medium || 0);
  if (sort === 'old') rows = rows.reverse();
  if (sort === 'host') rows = [...rows].sort((a, b) => a.host.localeCompare(b.host));
  if (sort === 'issues') rows = [...rows].sort((a, b) => issues(b) - issues(a));
  $('#count').textContent = all.length ? `${rows.length} of ${all.length} readings` : '';
  $('#list').innerHTML = rows.length ? String(html`${rows.map(cardHtml)}`)
    : String(html`<p class="empty">${all.length ? 'No readings match.' : 'No readings yet. Open a page, click the HARgus toolbar button and take a reading — or import a HAR file.'}</p>`);
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
      if (hp.capture) delete hp.capture.viewsPending; // no views patch can exist for an imported reading
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
