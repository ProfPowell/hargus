import { getReading, getIndexRecord, saveReading, deleteReading, getViewsPatch, deleteViewsPatch } from '../browser/store.js';
import { getSettings } from '../browser/settings.js';
import { getPlugins } from '../plugins/index.js';
import { runPlugins } from '../core/plugin-host.js';
import { toMarkdown, stripForSharing, screenshotURL, mergeViewsPatch } from '../core/harplus.js';
import { waitForViews, settleViewsAfterFailure, persistAndCleanup } from '../core/views-wait.js';
import { hostOf, resourceType, formatBytes, formatMs, transferSize, isThirdParty, SEVERITIES } from '../core/har-util.js';
import { AREAS, scoreReading, profileFromSettings, topFindings } from '../core/score.js';
import { VIEW_LABELS, shotView, baseView } from '../core/views.js';
import { html, h, toast, download, fileStem } from './render.js';
import { renderProgress } from './progress-view.js';
import { labelFor, formatElapsed } from '../core/progress.js';
import { renderReport, findingsTable, networkTable, requestDetail, NET_PAGE, PANES, standaloneDocument } from './report.js';
import { lcpPath, clampWindow, zoomAt, timelineModel } from './waterfall.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
let id = params.get('id');
const captureTab = params.has('capture') ? Number(params.get('capture')) : null;
const sourceTab = params.has('tab') ? Number(params.get('tab')) : captureTab;
const prog = { note: '', host: '', steps: [], plugins: [], startedAt: null, error: '', active: false };
let ticker = null;
const state = { sev: new Set(SEVERITIES), area: '', category: '', q: '', netQ: '', netType: '', netParty: '', netSort: { key: 'index', dir: 'asc' }, netLimit: NET_PAGE, netOpen: null, netPath: false, netGroups: false, netOpenGroups: new Set(), netWindow: null };
let reading;
let plugins;
let settings;
let scores;

const hp = () => reading.log._harplus;

/* ------------------------------------------------------------- progress */

let paintedKey = null;

function structureKey() {
  return JSON.stringify([
    prog.host, prog.startedAt, prog.error, prog.note,
    prog.steps.map((x) => [x.stage, x.text, x.end != null]),
    prog.plugins.map((x) => [x.id, x.status, x.text || '']),
  ]);
}

function announce() {
  const cur = [...prog.steps].reverse().find((x) => x.stage !== 'done');
  const text = prog.error || (cur ? `${labelFor(cur.stage)}${cur.text && cur.text !== labelFor(cur.stage) ? ` — ${cur.text}` : ''}` : '');
  const live = $('#prog-live');
  if (live && live.textContent !== text) live.textContent = text;
}

/** Re-render the checklist only when its structure changed; the ticker handles the clocks. */
function paintProgress() {
  if (!prog.active) return;
  const key = structureKey();
  if (key !== paintedKey) {
    paintedKey = key;
    $('#app').innerHTML = String(renderProgress({ ...prog, now: Date.now(), retry: captureTab != null }));
    document.title = `${prog.error ? 'Failed' : 'Reading'} ${prog.host || ''} — HARgus`;
    announce();
  }
  if (prog.error) stopTicker(); else ticker ??= setInterval(tick, 1000);
}

function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll('#app [data-start]')) el.textContent = formatElapsed(now - Number(el.dataset.start));
}

function stopTicker() {
  clearInterval(ticker);
  ticker = null;
}

const lockedWhileBusy = () => document.querySelectorAll('[popovertarget="export-menu"], #delete');

function showProgress() {
  prog.active = true;
  $('#rerun').disabled = true;
  for (const el of lockedWhileBusy()) el.disabled = true;
  paintProgress();
}

function hideProgress() {
  prog.active = false;
  paintedKey = null;
  $('#rerun').disabled = false;
  for (const el of lockedWhileBusy()) el.disabled = false;
  stopTicker();
  const live = $('#prog-live');
  if (live) live.textContent = '';
}

function tellWorker(stage, extra = {}) {
  if (sourceTab == null) return;
  chrome.runtime.sendMessage({ type: 'harplus:analysis', tabId: sourceTab, stage, ...extra }).catch(() => {});
}

function applyStatus(s) {
  if (!s) return;
  if (reading) {
    // Analysis is running while the capture still drives the views: keep its steps (incl. "views") on screen.
    if (hp().capture?.viewsPending && s.steps) { prog.steps = s.steps; paintProgress(); }
    return;
  }
  if (s.startedAt && prog.startedAt && s.startedAt !== prog.startedAt) { prog.error = ''; prog.steps = []; }
  if (s.steps) prog.steps = s.steps;
  if (s.startedAt) prog.startedAt = s.startedAt;
  if (s.stage === 'error') prog.error = s.text || 'The reading failed';
  paintProgress();
  if (s.readingId && !reading && !id) {
    id = s.readingId;
    history.replaceState(null, '', `?id=${encodeURIComponent(id)}&tab=${sourceTab}`);
    openReading().catch((e) => { prog.error = e.message; paintProgress(); });
  }
}

let followingCapture = false;

async function followCapture() {
  chrome.tabs.get(captureTab).then((t) => { try { prog.host = new URL(t.url).host; } catch { /* keep blank */ } paintProgress(); }, () => {});
  followingCapture = true;
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'harplus:progress' && msg.tabId === captureTab) applyStatus(msg);
  });
  const st = await chrome.runtime.sendMessage({ type: 'harplus:status', tabId: captureTab }).catch(() => null);
  applyStatus(st?.status);
}

/** Resolves when the reading has its views (merged into `reading`), or undefined when nothing is pending.
 *  Never rejects: plugins held for views must always get to run. */
function viewsReady(signal) {
  if (!hp().capture?.viewsPending) return undefined;
  return waitForViews({
    signal,
    fromStore: () => getViewsPatch(id),
    isAlive: () => chrome.runtime.sendMessage({ type: 'harplus:views-alive', readingId: id }).then((r) => !!r?.alive),
    subscribe: (fn) => {
      const onMsg = (msg) => {
        if (msg?.type === 'harplus:views' && msg.readingId === id) fn({ kind: 'views' });
        else if (msg?.type === 'harplus:progress' && msg.tabId === sourceTab && msg.stage === 'error') fn({ kind: 'error', text: msg.text });
      };
      chrome.runtime.onMessage.addListener(onMsg);
      return () => chrome.runtime.onMessage.removeListener(onMsg);
    },
  }).then(({ patch }) => { mergeViewsPatch(reading, patch); })
    .catch((e) => { mergeViewsPatch(reading, { capture: { viewsSkipped: [{ view: 'all', reason: `views could not be merged: ${e?.message || e}` }] } }); })
    .catch(() => {});
}

/** While views are pending, keep the capture's progress steps (incl. "views") painted. Returns a stopper. */
function followViewsProgress() {
  if (!hp().capture?.viewsPending || sourceTab == null) return () => {};
  const onMsg = (msg) => { if (msg?.type === 'harplus:progress' && msg.tabId === sourceTab) applyStatus(msg); };
  if (!followingCapture) {
    chrome.runtime.onMessage.addListener(onMsg);
    chrome.runtime.sendMessage({ type: 'harplus:status', tabId: sourceTab }).then((st) => applyStatus(st?.status), () => {});
  }
  return () => chrome.runtime.onMessage.removeListener(onMsg);
}

function stampTiming(analysisStart) {
  const cap = hp().capture || {};
  const t = { ...(hp().timing || {}), analysisMs: Date.now() - analysisStart };
  if (cap.viewsMs != null) t.viewsMs = cap.viewsMs;
  const start = Date.parse(cap.startedAt);
  if (Number.isFinite(start)) t.totalMs = Date.now() - start;
  hp().timing = t;
}

/** Run the analyze + enrich phases here (extension pages have no service-worker time limit). */
async function finishAnalysis({ notify }) {
  let failed = false;
  const analysisStart = Date.now();
  prog.startedAt ??= Date.now();
  prog.plugins = [];
  prog.error = '';
  prog.note = '';
  prog.host ||= hp().target?.host || '';
  showProgress();
  const waiting = new AbortController(); // releases the views listener and timer when this run ends
  const views = viewsReady(waiting.signal);
  const stopFollowing = followViewsProgress();
  views?.then(stopFollowing);
  try {
    await runPlugins(reading, plugins, {
      phases: ['analyze', 'enrich'],
      settings,
      views,
      onProgress: (p) => {
        const now = Date.now();
        const row = prog.plugins.find((x) => x.id === p.plugin);
        if (p.status === 'running') {
          if (!row) prog.plugins.push({ id: p.plugin, name: p.name, status: 'running', start: now, text: p.text });
          else if (p.text) row.text = p.text;
        } else if (row) {
          Object.assign(row, { status: p.status, error: p.error, end: now });
        }
        paintProgress();
        if (notify && p.status !== 'running') tellWorker('plugin', { text: `${p.name} — ${p.status}` });
      },
    });
    await views; // plugins that need no views don't wait for them; the reading must still get its patch (never rejects)
    stampTiming(analysisStart);
    hp().analysis = 'done';
    await saveReading(reading); // throws → the catch saves again; the patch is only deleted after a save resolves
    await deleteViewsPatch(id).catch(() => {});
    if (notify) tellWorker('done', { readingId: id });
  } catch (e) {
    failed = true;
    await settleViewsAfterFailure(reading, () => getViewsPatch(id));
    stampTiming(analysisStart);
    hp().analysis = 'done';
    // Delete the patch only once a save has landed; if none did, the next open merges it from the store.
    await persistAndCleanup(() => saveReading(reading), () => deleteViewsPatch(id));
    if (notify) tellWorker('error', { text: e.message });
  }
  waiting.abort();
  stopFollowing();
  hideProgress();
  render();
  toast(failed ? 'Lookups failed — showing what finished' : 'Reading complete');
}

async function waitForOtherTab() {
  prog.host ||= hp().target?.host || '';
  prog.error = '';
  prog.note = 'Being finished in another tab — this page will update when it is done.';
  showProgress();
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const rec = await getIndexRecord(id).catch(() => null);
    if (rec && !rec.pending) {
      const fresh = await getReading(id).catch(() => null);
      if (fresh) { reading = fresh; break; }
    }
    // The tab holding the lock may have died: take over if the lock is free and the reading still pending.
    const took = await navigator.locks.request(`harplus-analysis:${id}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return false;
      const fresh = await getReading(id).catch(() => null);
      if (fresh && fresh.log._harplus.analysis === 'pending') {
        reading = fresh;
        prog.note = '';
        await finishAnalysis({ notify: true });
        return true;
      }
      if (fresh) { reading = fresh; return 'loaded'; }
      return false;
    });
    if (took === true) return;
    if (took === 'loaded') break;
  }
  prog.note = '';
  hideProgress();
  render();
}

async function openReading() {
  reading = await getReading(id);
  if (!reading) {
    hideProgress();
    $('#app').innerHTML = '<p class="empty">Reading not found. <a href="library.html">Back to readings</a></p>';
    return;
  }
  if (hp().analysis === 'pending') {
    await navigator.locks.request(`harplus-analysis:${id}`, { ifAvailable: true }, async (lock) => {
      if (lock) return finishAnalysis({ notify: true });
      return waitForOtherTab();
    });
  }
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
    <select id="n-party" aria-label="Party">${[['', 'First & third party'], ['first', 'First party'], ['third', 'Third party']].map(([v, l]) => html`<option value="${v}" ${v === state.netParty ? 'selected' : ''}>${l}</option>`)}</select>
    <span id="wf-live" class="sr-only" aria-live="polite"></span>`;
}

function renderFindings() {
  const list = topFindings(scores, Infinity, null, { includeInfo: true }).filter((f) => state.sev.has(f.severity) &&
    (!state.area || f.area === state.area) &&
    (!state.category || f.category === state.category) &&
    (!state.q || `${f.title} ${f.detail || ''} ${f.pluginName}`.toLowerCase().includes(state.q)));
  $('#findings-table').innerHTML = String(findingsTable(list));
}

let netPathData = null; // lcpPath(reading), computed once per render()
let netSpan = 1;        // the whole-load span in ms
let announceTimer = 0;
const wfAnnounce = (text) => { // debounced: one pending timer, the last text wins
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { const el = document.getElementById('wf-live'); if (el) el.textContent = text; }, 300);
};
let printing = false; // while printing, the table shows the whole load: no zoom, no path, no groups
const zoomText = () => document.getElementById('wf-zoom-text')?.textContent || '';

function rerenderKeeping(selector) {
  renderNetwork();
  if (selector) document.querySelector(selector)?.focus();
}

function setWindow(w, { announceIt = true } = {}) {
  const next = clampWindow(w, netSpan);
  state.netWindow = next.from <= 0 && next.to >= netSpan ? null : next;
  renderNetwork();
  if (announceIt) wfAnnounce(zoomText());
}

function renderNetwork() {
  const site = hp().target?.site;
  const rows = reading.log.entries.map((e, i) => ({ e, i })).filter(({ e }) => {
    const host = hostOf(e.request.url);
    return (!state.netQ || e.request.url.toLowerCase().includes(state.netQ)) &&
      (!state.netType || resourceType(e) === state.netType) &&
      (!state.netParty || (state.netParty === 'third') === isThirdParty(host, site));
  });
  const box = document.querySelector('#net-table .table-wrap.net');
  const keep = box ? { top: box.scrollTop, left: box.scrollLeft } : null;
  $('#net-table').innerHTML = String(networkTable(reading, rows, {
    limit: state.netLimit, sort: state.netSort,
    window: printing ? null : state.netWindow, path: state.netPath && !printing ? netPathData : null,
    groups: state.netGroups && !printing, openGroups: state.netOpenGroups,
  }));
  const fresh = keep && document.querySelector('#net-table .table-wrap.net');
  if (fresh) { fresh.scrollTop = keep.top; fresh.scrollLeft = keep.left; }
  // An open row survives a re-render while it is still shown (Review Focus 3).
  if (state.netOpen != null) expandEntry(state.netOpen, { focus: false });
}

/** Insert the request's detail row after its row; one open at a time. Returns false if the row is not shown. */
function expandEntry(i, { focus = true } = {}) {
  const row = document.querySelector(`#net-table tr[data-entry="${i}"]`);
  if (!row) return false;
  const btn = row.querySelector('button.disclose');
  const detail = document.createElement('tr');
  detail.className = 'detail-row';
  detail.id = `ed-${i}`;
  detail.innerHTML = `<td colspan="${row.children.length}">${requestDetail(reading, i)}</td>`;
  row.after(detail);
  row.classList.add('open');
  btn.setAttribute('aria-expanded', 'true');
  btn.textContent = '▾';
  if (focus) btn.focus();
  return true;
}

function collapseEntry({ focus = true } = {}) {
  const i = state.netOpen;
  state.netOpen = null;
  if (i == null) return;
  document.getElementById(`ed-${i}`)?.remove();
  const row = document.querySelector(`#net-table tr[data-entry="${i}"]`);
  if (!row) return;
  row.classList.remove('open');
  const btn = row.querySelector('button.disclose');
  btn.setAttribute('aria-expanded', 'false');
  btn.textContent = '▸';
  if (focus) btn.focus();
}

function toggleEntry(i) {
  const was = state.netOpen;
  collapseEntry({ focus: false });
  if (was === i) { document.querySelector(`#net-table tr[data-entry="${i}"] button.disclose`)?.focus(); return; }
  if (expandEntry(i)) state.netOpen = i;
}

function selectTab(tab, { focus = true } = {}) {
  const list = tab.closest('[role="tablist"]');
  for (const t of list.querySelectorAll('[role="tab"]')) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  }
  if (focus) tab.focus();
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
  document.title = `${t.title || t.host || 'Reading'} — HARgus`;
  $('#appbar-title').textContent = [t.title || t.host, t.host, hp().capturedAt && new Date(hp().capturedAt).toLocaleDateString()].filter(Boolean).join(' · ');
  scores = scoreReading(reading, plugins, { profile: profileFromSettings(settings) });
  $('#app').innerHTML = renderReport(reading, plugins, { scores, settings, interactive: true });
  $('#findings-tools').innerHTML = String(findingTools());
  $('#network-tools').innerHTML = String(netTools());
  renderFindings();
  netPathData = lcpPath(reading);
  netSpan = timelineModel(reading).span;
  state.netWindow = null;
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

/* --------------------------------------------------------------- events */

document.addEventListener('click', async (ev) => {
  const t = ev.target;
  if (t.closest('#retry') && captureTab != null) {
    prog.error = '';
    prog.steps = [];
    prog.startedAt = Date.now();
    paintProgress();
    const tabId = (await chrome.tabs.getCurrent())?.id;
    const reply = await chrome.runtime.sendMessage({ type: 'harplus:capture', tabId: captureTab, options: { progressTab: tabId } }).catch(() => null);
    if (reply?.error) { prog.error = reply.error; paintProgress(); }
    return;
  }
  const copy = t.closest('[data-copy]');
  if (copy) {
    await navigator.clipboard.writeText(copy.getAttribute('data-copy')).then(() => toast('Copied'), () => toast('Copy failed'));
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
  if (t.closest('#net-table [data-wf-path]')) {
    state.netPath = !state.netPath;
    rerenderKeeping('#net-table [data-wf-path]');
    return;
  }
  if (t.closest('#net-table [data-wf-groups]')) {
    state.netGroups = !state.netGroups;
    state.netLimit = NET_PAGE;
    rerenderKeeping('#net-table [data-wf-groups]');
    return;
  }
  if (t.closest('#net-table [data-wf-reset]')) {
    setWindow(null);
    document.querySelector('#wf-overview .ov-h[data-edge="to"]')?.focus();
    return;
  }
  const grpRow = t.closest('#net-table tr[data-group]');
  if (grpRow) {
    const key = grpRow.dataset.group;
    if (state.netOpenGroups.has(key)) {
      state.netOpenGroups.delete(key);
      // Closing a group closes a request detail open inside it.
      if (state.netOpen != null && document.querySelector(`#net-table tr.grp-member[data-entry="${state.netOpen}"]`)) state.netOpen = null;
    } else state.netOpenGroups.add(key);
    rerenderKeeping(`#net-table tr[data-group="${CSS.escape(key)}"] button.grp-disc`);
    return;
  }
  const sortBtn = t.closest('#net-table button[data-sort]');
  if (sortBtn) {
    const key = sortBtn.dataset.sort;
    state.netSort = state.netSort.key === key ? { key, dir: state.netSort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
    renderNetwork();
    document.querySelector(`#net-table button[data-sort="${key}"]`)?.focus();
    return;
  }
  if (t.closest('#net-table [data-net-more]')) {
    const before = document.querySelectorAll('#net-table tr[data-entry]').length;
    state.netLimit += NET_PAGE;
    renderNetwork();
    (document.querySelector('#net-table [data-net-more]')
      || document.querySelectorAll('#net-table tr[data-entry]')[before]?.querySelector('button.disclose'))?.focus();
    return;
  }
  const tab = t.closest('.req-detail [role="tab"]');
  if (tab) { selectTab(tab); return; }
  if (t.closest('.detail-row')) return; // clicks inside the detail never toggle the row
  const row = t.closest('#net-table tr[data-entry]');
  if (row) { toggleEntry(Number(row.dataset.entry)); return; }
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
  const t = ev.target;
  if (t.matches?.('#wf-overview .ov-h') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) {
    const cur = state.netWindow || { from: 0, to: netSpan };
    const step = netSpan * (ev.shiftKey ? 0.1 : 0.01);
    const edge = t.dataset.edge;
    const v = ev.key === 'Home' ? 0 : ev.key === 'End' ? netSpan : cur[edge] + (ev.key === 'ArrowRight' ? step : -step);
    setWindow(edge === 'from' ? { from: Math.min(v, cur.to - 10), to: cur.to } : { from: cur.from, to: Math.max(v, cur.from + 10) });
    document.querySelector(`#wf-overview .ov-h[data-edge="${edge}"]`)?.focus();
    ev.preventDefault();
    return;
  }
  if (t.matches?.('.req-detail [role="tab"]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) {
    const tabs = [...t.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
    const k = tabs.indexOf(t);
    const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? tabs.length - 1 : (k + (ev.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    selectTab(tabs[next]);
    ev.preventDefault();
    return;
  }
  if (ev.key === 'Escape' && state.netOpen != null && t.closest?.(`#ed-${state.netOpen}, #net-table tr[data-entry="${state.netOpen}"]`)) {
    collapseEntry();
    ev.preventDefault();
  }
});

/* -------------------------------------------- overview brush and ruler drag */

let drag = null; // { kind: 'draw'|'pan'|'from'|'to'|'ruler', el, rect, startX, startWin }

const msAt = (rect, clientX, from, to) => from + Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * (to - from);

document.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  const strip = ev.target.closest?.('#wf-overview');
  const ruler = ev.target.closest?.('#net-table .tl-head .ruler');
  if (!strip && !ruler) return;
  const el = strip || ruler;
  const rect = el.getBoundingClientRect();
  const cur = state.netWindow || { from: 0, to: netSpan };
  const handle = ev.target.closest('.ov-h');
  // Unzoomed, the brush covers the whole strip: dragging inside it must draw a new window, not pan a full-width one.
  const kind = ruler ? 'ruler' : handle ? handle.dataset.edge : state.netWindow && ev.target.closest('.ov-brush') ? 'pan' : 'draw';
  drag = { kind, el, rect, startX: ev.clientX, startWin: cur };
  el.setPointerCapture?.(ev.pointerId);
  if (handle) handle.focus(); // preventDefault below blocks mouse focus; keep arrows working after the drag
  ev.preventDefault();
});

// The re-render replaces the strip, so a handle that had focus must be found again.
const refocusHandle = (kind) => { if (kind === 'from' || kind === 'to') document.querySelector(`#wf-overview .ov-h[data-edge="${kind}"]`)?.focus(); };

function abortDrag() {
  const d = drag;
  drag = null;
  if (d?.moved) { renderNetwork(); refocusHandle(d.kind); } // restore the brush the drag was moving
}
document.addEventListener('pointercancel', abortDrag);

document.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  if (ev.buttons === 0) { abortDrag(); return; } // the button was released elsewhere
  drag.moved = true;
  const { kind, rect, startX, startWin } = drag;
  const brush = document.querySelector('#wf-overview .ov-brush');
  let w;
  if (kind === 'ruler') return; // the ruler zooms on release
  if (kind === 'pan') {
    const dms = ((ev.clientX - startX) / rect.width) * netSpan;
    w = { from: startWin.from + dms, to: startWin.to + dms };
  } else if (kind === 'from' || kind === 'to') {
    const ms = msAt(rect, ev.clientX, 0, netSpan);
    w = kind === 'from' ? { from: Math.min(ms, startWin.to - 10), to: startWin.to } : { from: startWin.from, to: Math.max(ms, startWin.from + 10) };
  } else {
    const a = msAt(rect, startX, 0, netSpan), b = msAt(rect, ev.clientX, 0, netSpan);
    w = { from: Math.min(a, b), to: Math.max(a, b) };
  }
  drag.pending = clampWindow(w, netSpan);
  if (brush) { // move the brush without re-rendering the table on every pointer move
    brush.style.left = `${(drag.pending.from / netSpan) * 100}%`;
    brush.style.width = `${((drag.pending.to - drag.pending.from) / netSpan) * 100}%`;
  }
});

document.addEventListener('pointerup', (ev) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (Math.abs(ev.clientX - d.startX) < 4 && d.kind !== 'from' && d.kind !== 'to') { if (d.moved) renderNetwork(); return; } // a click, not a drag
  if (d.kind === 'ruler') {
    const a = msAt(d.rect, d.startX, d.startWin.from, d.startWin.to), b = msAt(d.rect, ev.clientX, d.startWin.from, d.startWin.to);
    setWindow({ from: Math.min(a, b), to: Math.max(a, b) });
    return;
  }
  if (d.pending) { setWindow(d.pending); refocusHandle(d.kind); }
});

/* ------------------------------------------------------------ wheel zoom */

window.addEventListener('beforeprint', () => { printing = true; renderNetwork(); });
window.addEventListener('afterprint', () => { printing = false; renderNetwork(); });

let wheelFrame = 0;
// On #app: #net-table is re-created by render(), #app persists.
$('#app').addEventListener('wheel', (ev) => {
  if (!(ev.ctrlKey || ev.metaKey)) return; // a plain wheel scrolls; Ctrl-wheel elsewhere keeps the browser's page zoom
  const strip = ev.target.closest?.('#wf-overview');
  const cell = ev.target.closest?.('#net-table td.tl, #net-table .tl-head');
  if (!strip && !cell) return;
  ev.preventDefault();
  const cur = state.netWindow || { from: 0, to: netSpan };
  const box = (strip || cell.querySelector('.wf, .ruler') || cell).getBoundingClientRect();
  const center = strip ? msAt(box, ev.clientX, 0, netSpan) : msAt(box, ev.clientX, cur.from, cur.to);
  const dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
  if (!dy) return;
  const next = zoomAt(cur, center, 1.2 ** Math.max(-1, Math.min(1, dy / 100)), netSpan);
  state.netWindow = next.from <= 0 && next.to >= netSpan ? null : next;
  cancelAnimationFrame(wheelFrame);
  wheelFrame = requestAnimationFrame(() => { renderNetwork(); wfAnnounce(zoomText()); });
}, { passive: false });

document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.id === 'f-q') { state.q = t.value.trim().toLowerCase(); renderFindings(); }
  if (t.id === 'n-q') { state.netQ = t.value.trim().toLowerCase(); state.netLimit = NET_PAGE; renderNetwork(); }
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.id === 'f-area') { state.area = t.value; renderFindings(); }
  if (t.id === 'f-cat') { state.category = t.value; renderFindings(); }
  if (t.id === 'n-type') { state.netType = t.value; state.netLimit = NET_PAGE; renderNetwork(); }
  if (t.id === 'n-party') { state.netParty = t.value; state.netLimit = NET_PAGE; renderNetwork(); }
});

/** Display-only copy of plugin data with long data: URLs shortened. */
function elideDataUrls(v) {
  if (typeof v === 'string') return v.startsWith('data:') && v.length > 200 ? `data:…(${v.length} chars)` : v;
  if (Array.isArray(v)) return v.map(elideDataUrls);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, elideDataUrls(x)]));
  return v;
}

// Fill raw JSON lazily — some plugin data is large.
document.addEventListener('toggle', (ev) => {
  const d = ev.target;
  if (d.matches?.('details[data-raw]') && d.open && !d.dataset.filled) {
    d.insertAdjacentHTML('beforeend', String(h.json(elideDataUrls(hp().plugins[d.dataset.raw]?.data))));
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
  if (!reading || prog.active) return;
  settings = await getSettings();
  plugins = getPlugins(settings);
  prog.steps = [];
  prog.startedAt = Date.now();
  await navigator.locks.request(`harplus-analysis:${id}`, { ifAvailable: true }, async (lock) => {
    if (!lock) { toast('Already being finished in another tab'); return; }
    await finishAnalysis({ notify: false });
  });
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
