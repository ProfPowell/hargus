import { listReadings, deleteReading, saveReading, getReading, listSets, saveSet, deleteSet } from '../browser/store.js';
import { getSettings } from '../browser/settings.js';
import { ensureHarPlus } from '../core/harplus.js';
import { runPlugins } from '../core/plugin-host.js';
import { getPlugins } from '../plugins/index.js';
import { html, toast } from './render.js';
import { cardHtml, setCardHtml } from './library-card.js';
import { parseUrlList, newSet, setFromReadings, addToSet } from '../core/sets.js';
import { MAX_SITES } from '../core/compare.js';

const $ = (s) => document.querySelector(s);
let all = [];
let sets = [];
const selected = new Set();

function render() {
  const q = $('#q').value.trim().toLowerCase();
  const sort = $('#sort').value;
  let rows = all.filter((r) => !q || [r.title, r.host, r.url, r.notes, ...(r.tags || [])].join(' ').toLowerCase().includes(q));
  const issues = (r) => (r.counts?.high || 0) * 100 + (r.counts?.medium || 0);
  if (sort === 'old') rows = rows.reverse();
  if (sort === 'host') rows = [...rows].sort((a, b) => a.host.localeCompare(b.host));
  if (sort === 'issues') rows = [...rows].sort((a, b) => issues(b) - issues(a));
  $('#count').textContent = all.length ? `${rows.length} of ${all.length} readings` : '';
  $('#list').innerHTML = rows.length ? String(html`${rows.map((r) => cardHtml(r, { selectable: true, sets }))}`)
    : String(html`<p class="empty">${all.length ? 'No readings match.' : 'No readings yet. Open a page, click the HARgus toolbar button and take a reading — or import a HAR file.'}</p>`);
}

function syncSelection() {
  for (const box of document.querySelectorAll('[data-select]')) box.checked = selected.has(box.dataset.select);
  const n = selected.size;
  const ok = n >= 2 && n <= MAX_SITES;
  $('#selbar').hidden = n === 0;
  $('#selcount').textContent = `${n} selected`;
  $('#sel-compare').disabled = !ok;
  $('#sel-save').disabled = !ok;
  $('#sel-compare').title = ok ? '' : `Select 2 to ${MAX_SITES} readings`;
  if (!n) $('#sel-name').hidden = true;
}

function renderSets() {
  $('#set-list').innerHTML = sets.length ? String(html`${sets.map(setCardHtml)}`)
    : String(html`<p class="empty">No sets yet. Save selected readings as a set, or choose New set to record a list of sites.</p>`);
}

/** Reload sets, then redraw the Sets tab and the reading cards' set chips. */
async function refreshSets() {
  sets = await listSets();
  renderSets();
  render();
  syncSelection();
}

async function load() {
  all = await listReadings();
  const ids = new Set(all.map((r) => r.id));
  for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
  sets = await listSets();
  render();
  renderSets();
  syncSelection();
}

function showTab(name) {
  for (const t of document.querySelectorAll('[data-tab]')) {
    const on = t.dataset.tab === name;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  }
  $('#pane-readings').hidden = name !== 'readings';
  $('#pane-sets').hidden = name !== 'sets';
  closeMenu();
}
for (const t of document.querySelectorAll('[data-tab]')) t.addEventListener('click', () => showTab(t.dataset.tab));
$('.lib-tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const next = $('[data-tab][aria-selected="false"]');
  showTab(next.dataset.tab);
  next.focus();
});

/** Ask the background to record a set's round; show its error if it can't. */
async function recordSet(setId) {
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'harplus:record-set', setId });
    if (reply?.error) toast(reply.error, 6000);
    else toast('Recording started. Keep the recording window visible until the round ends');
  } catch (err) {
    toast(err?.message || 'Could not start recording', 6000);
  }
}

function closeMenu() {
  $('#add-menu').hidden = true;
  for (const b of document.querySelectorAll('[data-add-menu][aria-expanded="true"]')) b.setAttribute('aria-expanded', 'false');
}

function openMenu(btn) {
  const m = $('#add-menu');
  const wasOpen = btn.getAttribute('aria-expanded') === 'true';
  closeMenu();
  if (wasOpen) return;
  m.innerHTML = sets.length
    ? String(html`${sets.map((s) => html`<button type="button" role="menuitem" class="btn ghost" data-add-to="${s.id}">${s.name}</button>`)}`)
    : String(html`<span class="muted">No sets yet</span>`);
  m.dataset.reading = btn.dataset.addMenu;
  const r = btn.getBoundingClientRect();
  m.style.top = `${r.bottom + window.scrollY + 4}px`;
  m.style.left = `${Math.max(8, Math.min(r.left + window.scrollX, window.innerWidth - 240))}px`;
  m.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  m.querySelector('button')?.focus();
}

$('#add-menu').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-add-to]');
  if (!b) return;
  const id = $('#add-menu').dataset.reading;
  closeMenu();
  try {
    const reading = await getReading(id);
    const set = sets.find((s) => s.id === b.dataset.addTo);
    if (!reading || !set) { toast('That reading or set is gone'); return; }
    await saveSet(addToSet(set, reading));
    toast(`Added to ${set.name}`);
    refreshSets();
  } catch (err) { toast(err.message, 5000); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
document.addEventListener('click', (e) => { if (!e.target.closest('#add-menu, [data-add-menu]')) closeMenu(); });

$('#list').addEventListener('change', (e) => {
  const box = e.target.closest('[data-select]');
  if (!box) return;
  if (box.checked) selected.add(box.dataset.select); else selected.delete(box.dataset.select);
  syncSelection();
});
$('#sel-clear').addEventListener('click', () => { selected.clear(); syncSelection(); });
$('#sel-compare').addEventListener('click', () => {
  if (selected.size < 2 || selected.size > MAX_SITES) return;
  location.href = `compare.html?ids=${[...selected].map(encodeURIComponent).join(',')}`;
});
$('#sel-save').addEventListener('click', () => { $('#sel-name').hidden = false; $('#sel-name-in').focus(); });
$('#sel-name-cancel').addEventListener('click', () => { $('#sel-name').hidden = true; });
$('#sel-name').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#sel-name-in').value.trim();
  if (!name) return;
  try {
    const readings = (await Promise.all([...selected].map(getReading))).filter(Boolean);
    if (readings.length < 2) { toast('Those readings are gone'); return; }
    await saveSet(setFromReadings(name, readings));
    $('#sel-name-in').value = '';
    $('#sel-name').hidden = true;
    selected.clear();
    toast(`Saved set ${name}`);
    refreshSets();
  } catch (err) { toast(err.message, 5000); }
});

async function openNewSetForm() {
  const c = (await getSettings()).capture || {};
  $('#ns-device').value = c.device || 'desktop';
  $('#ns-throttle').value = c.throttle || 'none';
  $('#ns-runs').value = String(c.runs || 1);
  $('#ns-cache').checked = !!c.bypassCache;
  $('#ns-coverage').checked = !!c.coverage;
  $('#new-set').hidden = false;
  $('#ns-name').focus();
}
$('#new-set-open').addEventListener('click', openNewSetForm);
$('#ns-cancel').addEventListener('click', () => { $('#new-set').hidden = true; });
$('#ns-urls').addEventListener('input', () => {
  const { urls, bad } = parseUrlList($('#ns-urls').value);
  $('#ns-bad').textContent = bad.length ? `Not used: ${bad.join(', ')}` : (urls.length ? `${urls.length} of ${MAX_SITES} sites` : '');
});
$('#new-set').addEventListener('submit', async (e) => {
  e.preventDefault();
  const record = e.submitter?.dataset.after === 'record';
  const name = $('#ns-name').value.trim();
  const { urls, bad } = parseUrlList($('#ns-urls').value);
  $('#ns-bad').textContent = bad.length ? `Not used: ${bad.join(', ')}` : '';
  if (!name) return;
  if (!urls.length) { toast('Add at least one site'); return; }
  const settings = {
    device: $('#ns-device').value, throttle: $('#ns-throttle').value, runs: Number($('#ns-runs').value),
    bypassCache: $('#ns-cache').checked, coverage: $('#ns-coverage').checked,
  };
  const set = newSet({ name, urls, settings });
  try { await saveSet(set); } catch (err) { toast(err.message, 5000); return; }
  $('#new-set').hidden = true;
  $('#ns-name').value = '';
  $('#ns-urls').value = '';
  $('#ns-bad').textContent = '';
  await refreshSets();
  if (record) recordSet(set.id); else toast(`Saved set ${name}`);
});

$('#set-list').addEventListener('click', async (e) => {
  const rec = e.target.closest('[data-record]');
  if (rec) { recordSet(rec.dataset.record); return; }
  const btn = e.target.closest('[data-delete-set]');
  if (!btn) return;
  if (btn.dataset.armed) {
    await deleteSet(btn.dataset.deleteSet);
    toast('Set deleted');
    refreshSets();
  } else {
    btn.dataset.armed = '1';
    btn.textContent = 'Confirm delete';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Delete'; }, 4000);
  }
});

$('#q').addEventListener('input', render);
$('#sort').addEventListener('change', render);

$('#list').addEventListener('click', async (e) => {
  const menu = e.target.closest('[data-add-menu]');
  if (menu) { openMenu(menu); return; }
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
  if (msg?.type === 'harplus:set-progress') { refreshSets(); return; }
  if (msg?.type === 'harplus:progress' && (msg.stage === 'done' || (msg.stage === 'analyzing' && msg.readingId))) load();
});

load();
