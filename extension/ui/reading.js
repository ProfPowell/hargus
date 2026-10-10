import { getReading, saveReading, deleteReading } from '../browser/store.js';
import { getSettings } from '../browser/settings.js';
import { getPlugins } from '../plugins/index.js';
import { runPlugins } from '../core/plugin-host.js';
import { toMarkdown, stripForSharing, screenshotURL } from '../core/harplus.js';
import { hostOf, resourceType, formatBytes, formatMs, transferSize, isThirdParty, SEVERITIES } from '../core/har-util.js';
import { AREAS, scoreReading, topFindings } from '../core/score.js';
import { VIEW_LABELS, shotView, baseView } from '../core/views.js';
import { html, h, toast, download, fileStem } from './render.js';
import { renderProgress } from './progress-view.js';
import { renderReport, findingsTable, networkTable, PANES, standaloneDocument } from './report.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
let id = params.get('id');
const captureTab = params.has('capture') ? Number(params.get('capture')) : null;
let sourceTab = params.has('tab') ? Number(params.get('tab')) : captureTab;
const prog = { host: '', steps: [], plugins: [], startedAt: null, error: '', active: false };
let ticker = null;
const state = { sev: new Set(SEVERITIES), area: '', category: '', q: '', netQ: '', netType: '', netParty: '' };
let reading;
let plugins;
let settings;
let scores;

const hp = () => reading.log._harplus;

/* ------------------------------------------------------------- progress */

function paintProgress() {
  if (!prog.active) return;
  $('#app').innerHTML = String(renderProgress({ ...prog, now: Date.now(), retry: captureTab != null }));
  document.title = `${prog.error ? 'Failed' : 'Reading'} ${prog.host || ''} — HAR-PLUS`;
}

function showProgress() {
  prog.active = true;
  paintProgress();
  ticker ??= setInterval(paintProgress, 1000);
}

function hideProgress() {
  prog.active = false;
  clearInterval(ticker);
  ticker = null;
}

function tellWorker(stage, extra = {}) {
  if (sourceTab == null) return;
  chrome.runtime.sendMessage({ type: 'harplus:analysis', tabId: sourceTab, stage, ...extra }).catch(() => {});
}

function applyStatus(s) {
  if (!s) return;
  if (s.steps) prog.steps = s.steps;
  if (s.startedAt) prog.startedAt = s.startedAt;
  if (s.stage === 'error') prog.error = s.text || 'The reading failed';
  paintProgress();
  if (s.readingId && !reading && !id) {
    id = s.readingId;
    history.replaceState(null, '', `?id=${encodeURIComponent(id)}&tab=${sourceTab}`);
    openReading();
  }
}

async function followCapture() {
  chrome.tabs.get(captureTab).then((t) => { try { prog.host = new URL(t.url).host; } catch { /* keep blank */ } paintProgress(); }, () => {});
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'harplus:progress' && msg.tabId === captureTab) applyStatus(msg);
  });
  const st = await chrome.runtime.sendMessage({ type: 'harplus:status', tabId: captureTab }).catch(() => null);
  applyStatus(st?.status);
}

/** Run the analyze + enrich phases here (extension pages have no service-worker time limit). */
async function finishAnalysis({ notify }) {
  prog.plugins = [];
  prog.host ||= hp().target?.host || '';
  showProgress();
  try {
    await runPlugins(reading, plugins, {
      phases: ['analyze', 'enrich'],
      settings,
      onProgress: (p) => {
        const now = Date.now();
        const row = prog.plugins.find((x) => x.id === p.plugin);
        if (p.status === 'running') {
          if (!row) prog.plugins.push({ id: p.plugin, name: p.name, status: 'running', start: now });
        } else if (row) {
          Object.assign(row, { status: p.status, error: p.error, end: now });
        }
        paintProgress();
        if (notify && p.status !== 'running') tellWorker('plugin', { text: `${p.name} — ${p.status}` });
      },
    });
    hp().analysis = 'done';
    await saveReading(reading);
    if (notify) tellWorker('done', { readingId: id });
  } catch (e) {
    hp().analysis = 'done';
    await saveReading(reading).catch(() => {});
    if (notify) tellWorker('error', { text: e.message });
  }
  hideProgress();
  render();
  toast('Reading complete');
}

async function openReading() {
  reading = await getReading(id);
  if (!reading) {
    hideProgress();
    $('#app').innerHTML = '<p class="empty">Reading not found. <a href="library.html">Back to readings</a></p>';
    return;
  }
  if (hp().analysis === 'pending') await finishAnalysis({ notify: true });
  else { hideProgress(); render(); }
}

/* --------------------------------------------------------------- render */

function findingTools() {
  const cats = [...new Set(topFindings(scores, Infinity, null, { includeInfo: true }).map((f) => f.category))].sort();
  return html`
    <div class="chips" role="group" aria-label="Severity">${SEVERITIES.map((s) => html`<button type="button" class="chip" data-sev="${s}" aria-pressed="${String(state.sev.has(s))}"><span class="sev sev-${s}">${h.icon(s)}${s}</span></button>`)}</div>
    <select id="f-area" aria-label="Area"><option value="">All areas</option>${AREAS.map((a) => html`<option value="${a.id}" ${a.id === state.area ? 'selected' : ''}>${a.label}</option>`)}</select>
    <select id="f-cat" aria-label="Category"><option value="">All categories</option>${cats.map((c) => html`<option ${c === state.category ? 'selected' : ''}>${c}</option>`)}</select>
    <input type="search" id="f-q" placeholder="Filter findings" aria-label="Filter findings" value="${state.q}">`;
}

function netTools() {
  const types = ['document', 'script', 'stylesheet', 'image', 'font', 'xhr', 'media', 'other'];
  return html`
    <input type="search" id="n-q" placeholder="Filter URLs" aria-label="Filter requests" value="${state.netQ}">
    <select id="n-type" aria-label="Type"><option value="">All types</option>${types.map((t) => html`<option ${t === state.netType ? 'selected' : ''}>${t}</option>`)}</select>
    <select id="n-party" aria-label="Party">${[['', 'First & third party'], ['first', 'First party'], ['third', 'Third party']].map(([v, l]) => html`<option value="${v}" ${v === state.netParty ? 'selected' : ''}>${l}</option>`)}</select>`;
}

function renderFindings() {
  const list = topFindings(scores, Infinity, null, { includeInfo: true }).filter((f) => state.sev.has(f.severity) &&
    (!state.area || f.area === state.area) &&
    (!state.category || f.category === state.category) &&
    (!state.q || `${f.title} ${f.detail || ''} ${f.pluginName}`.toLowerCase().includes(state.q)));
  $('#findings-table').innerHTML = String(findingsTable(list));
}

function renderNetwork() {
  const site = hp().target?.site;
  const rows = reading.log.entries.map((e, i) => ({ e, i })).filter(({ e }) => {
    const host = hostOf(e.request.url);
    return (!state.netQ || e.request.url.toLowerCase().includes(state.netQ)) &&
      (!state.netType || resourceType(e) === state.netType) &&
      (!state.netParty || (state.netParty === 'third') === isThirdParty(host, site));
  });
  $('#net-table').innerHTML = String(networkTable(reading, rows));
}

function markActive() {
  const target = location.hash.slice(1);
  const pane = PANES.includes(target) ? target : document.getElementById(target)?.closest('.pane')?.id || 'overview';
  for (const a of document.querySelectorAll('.sidebar a[data-pane]')) {
    if (a.dataset.pane === pane) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

function render() {
  const t = hp().target || {};
  document.title = `${t.title || t.host || 'Reading'} — HAR-PLUS`;
  $('#appbar-title').textContent = [t.title || t.host, t.host, hp().capturedAt && new Date(hp().capturedAt).toLocaleDateString()].filter(Boolean).join(' · ');
  scores = scoreReading(reading, plugins);
  $('#app').innerHTML = renderReport(reading, plugins, { scores, settings, interactive: true });
  $('#findings-tools').innerHTML = String(findingTools());
  $('#network-tools').innerHTML = String(netTools());
  renderFindings();
  renderNetwork();
  markActive();
  if (location.hash) location.replace(location.hash);
}

/* -------------------------------------------------------------- dialogs */

function openDialog(title, body) {
  $('#dlg-title').textContent = title;
  $('#dlg-body').innerHTML = String(body);
  $('#dlg').showModal();
}

function entryDetail(e) {
  const headerRows = (hs) => (hs || []).map((x) => ({ name: x.name, value: x.value }));
  const c = e.response.content || {};
  let body = '';
  if (c.text && c.encoding === 'base64' && /^image\//.test(c.mimeType)) body = html`<img src="data:${c.mimeType};base64,${c.text}" alt="Response image" style="max-width:100%">`;
  else if (c.text && c.encoding !== 'base64') body = html`<pre class="json">${c.text.slice(0, 100_000)}${c.text.length > 100_000 ? '\n… (truncated)' : ''}</pre>`;
  return html`
    ${h.kv([
      ['URL', e.request.url], ['Method', e.request.method],
      ['Status', `${e.response.status} ${e.response.statusText || ''}`.trim()], ['Error', e._error],
      ['Protocol', e.response.httpVersion], ['Server', [e.serverIPAddress, e._remotePort].filter(Boolean).join(':')],
      ['Type', e._resourceType], ['MIME', c.mimeType], ['Priority', e._priority],
      ['Initiator', e._initiator ? [e._initiator.type, e._initiator.url].filter(Boolean).join(' ') : ''],
      ['Cache', e._fromCache], ['Service worker', e._fromServiceWorker], ['Target', e._target],
      ['Transferred', formatBytes(transferSize(e))], ['Decoded', formatBytes(c.size)],
      ['Started', e.startedDateTime], ['Time', formatMs(e.time)], ['Synthetic', e._synthetic],
    ])}
    ${h.sub('Timings (ms)', h.kv(Object.entries(e.timings || {}).map(([k, v]) => [k, v < 0 ? '—' : v])))}
    ${h.sub('Request headers', h.table(headerRows(e.request.headers), ['name', 'value']))}
    ${h.sub('Response headers', h.table(headerRows(e.response.headers), ['name', 'value']))}
    ${h.sub('Query string', h.table(e.request.queryString || [], ['name', 'value']))}
    ${h.sub('Request cookies', h.table(e.request.cookies || [], ['name', 'value']))}
    ${h.sub('Response cookies', h.table(e.response.cookies || [], ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite']))}
    ${e.request.postData ? h.sub('Request body', html`<pre class="json">${e.request.postData.text}</pre>`) : ''}
    ${body ? h.sub('Response body', body) : ''}`;
}

/* --------------------------------------------------------------- events */

document.addEventListener('click', async (ev) => {
  const t = ev.target;
  if (t.closest('#retry') && captureTab != null) {
    prog.error = '';
    prog.steps = [];
    prog.startedAt = Date.now();
    paintProgress();
    const tabId = (await chrome.tabs.getCurrent())?.id;
    chrome.runtime.sendMessage({ type: 'harplus:capture', tabId: captureTab, options: { progressTab: tabId } }).catch(() => {});
    return;
  }
  const zoom = t.closest('[data-zoom]');
  if (zoom) {
    const shot = hp().screenshots[Number(zoom.dataset.zoom)];
    if (!shot) return;
    const what = shot.kind === 'fullpage' ? 'full page' : shot.kind === 'thumbnail' ? 'thumbnail' : 'above the fold';
    openDialog(`${VIEW_LABELS[shotView(shot, baseView(reading))]} · ${what}`,
      html`<img src="${screenshotURL(shot)}" alt="Screenshot" style="width:100%">`);
    return;
  }
  const row = t.closest('tr[data-entry]');
  if (row) {
    const e = reading.log.entries[Number(row.dataset.entry)];
    openDialog(e.request.url, entryDetail(e));
    return;
  }
  const sevToggle = t.closest('[data-sev]');
  if (sevToggle) {
    const s = sevToggle.dataset.sev;
    if (state.sev.has(s)) state.sev.delete(s); else state.sev.add(s);
    sevToggle.setAttribute('aria-pressed', String(state.sev.has(s)));
    renderFindings();
    return;
  }
  const exp = t.closest('[data-export]');
  if (exp) {
    $('#export-menu').hidePopover();
    const stem = fileStem(reading);
    const kind = exp.dataset.export;
    if (kind === 'print') window.print();
    if (kind === 'report') {
      const css = await (await fetch('theme.css')).text();
      download(`${stem}.report.html`, standaloneDocument(reading, plugins, { css, scores }), 'text/html');
    }
    if (kind === 'full') download(`${stem}.har`, JSON.stringify(reading));
    if (kind === 'lite') download(`${stem}.lite.har`, JSON.stringify(stripForSharing(reading)));
    if (kind === 'markdown') download(`${stem}.md`, toMarkdown(reading), 'text/markdown');
    if (kind === 'copy') { await navigator.clipboard.writeText(toMarkdown(reading)); toast('Brief copied'); }
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.matches?.('tr[data-entry]')) ev.target.click();
});

document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.id === 'f-q') { state.q = t.value.trim().toLowerCase(); renderFindings(); }
  if (t.id === 'n-q') { state.netQ = t.value.trim().toLowerCase(); renderNetwork(); }
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.id === 'f-area') { state.area = t.value; renderFindings(); }
  if (t.id === 'f-cat') { state.category = t.value; renderFindings(); }
  if (t.id === 'n-type') { state.netType = t.value; renderNetwork(); }
  if (t.id === 'n-party') { state.netParty = t.value; renderNetwork(); }
});

// Fill raw JSON lazily — some plugin data is large.
document.addEventListener('toggle', (ev) => {
  const d = ev.target;
  if (d.matches?.('details[data-raw]') && d.open && !d.dataset.filled) {
    d.insertAdjacentHTML('beforeend', String(h.json(hp().plugins[d.dataset.raw]?.data)));
    d.dataset.filled = '1';
  }
}, true);

document.addEventListener('submit', async (ev) => {
  if (ev.target.id !== 'notes-form') return;
  ev.preventDefault();
  const f = new FormData(ev.target);
  hp().tags = String(f.get('tags') || '').split(',').map((s) => s.trim()).filter(Boolean);
  hp().notes = String(f.get('notes') || '');
  await saveReading(reading);
  toast('Notes saved');
});

window.addEventListener('hashchange', markActive);

// Print every pane with plugin detail expanded; restore afterwards.
let opened = [];
window.addEventListener('beforeprint', () => {
  opened = [...document.querySelectorAll('details.plugin:not([open])')];
  for (const d of opened) d.open = true;
});
window.addEventListener('afterprint', () => { for (const d of opened) d.open = false; opened = []; });

$('#dlg-close').addEventListener('click', () => $('#dlg').close());

$('#rerun').addEventListener('click', async () => {
  if (!reading) return;
  const btn = $('#rerun');
  btn.disabled = true;
  settings = await getSettings();
  plugins = getPlugins(settings);
  prog.steps = [];
  prog.startedAt = Date.now();
  await finishAnalysis({ notify: false });
  btn.disabled = false;
});

$('#delete').addEventListener('click', async () => {
  if (!id) return;
  const btn = $('#delete');
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = 'Confirm delete';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Delete'; }, 4000);
    return;
  }
  await deleteReading(id);
  location.href = 'library.html';
});

async function init() {
  settings = await getSettings();
  plugins = getPlugins(settings);
  if (captureTab != null && !id) {
    showProgress();
    followCapture();
    return;
  }
  if (sourceTab != null) {
    const st = await chrome.runtime.sendMessage({ type: 'harplus:status', tabId: sourceTab }).catch(() => null);
    if (st?.status?.steps) { prog.steps = st.status.steps; prog.startedAt = st.status.startedAt; }
  }
  await openReading();
}

init();
