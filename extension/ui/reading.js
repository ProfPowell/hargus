import { getReading, saveReading, deleteReading } from '../browser/store.js';
import { getSettings } from '../browser/settings.js';
import { getPlugins, pluginById, GROUP_LABELS } from '../plugins/index.js';
import { runPlugins, pluginEnabled } from '../core/plugin-host.js';
import { findings as allFindings, severityCounts, toMarkdown, stripForSharing, screenshotURL } from '../core/harplus.js';
import {
  transferSize, hostOf, resourceType, formatBytes, formatMs, isThirdParty, SEVERITIES,
} from '../core/har-util.js';
import { html, h, renderResult, toast, download, fileStem } from './render.js';

const $ = (s) => document.querySelector(s);
const id = new URLSearchParams(location.search).get('id');
const state = { sev: new Set(SEVERITIES), category: '', q: '', netQ: '', netType: '', netParty: '' };
let reading;
let plugins;
let settings;

const hp = () => reading.log._harplus;
const ordered = () => {
  const results = Object.values(hp().plugins || {});
  const rank = (r) => { const i = plugins.findIndex((p) => p.id === r.id); return i < 0 ? 999 : i; };
  return results.sort((a, b) => rank(a) - rank(b));
};

/* ------------------------------------------------------------ sections */

function hero() {
  const { target: t, capture: cap = {}, screenshots = [] } = hp();
  const shot = screenshots.find((s) => s.kind === 'viewport') || screenshots.find((s) => s.kind === 'thumbnail');
  const counts = severityCounts(reading);
  const bytes = reading.log.entries.reduce((s, e) => s + transferSize(e), 0);
  const extras = [cap.device && cap.device !== 'desktop' && cap.device, cap.throttle && cap.throttle !== 'none' && cap.throttle].filter(Boolean);
  return html`<section class="hero">
    ${shot ? html`<img class="shot" src="${screenshotURL(shot)}" alt="Screenshot of the page" data-zoom="${shot.kind}">` : html`<div class="shot card muted">No screenshot</div>`}
    <div>
      <h1>${t.title || t.host || 'Untitled reading'}</h1>
      <div class="url">${h.link(t.finalUrl || t.url)}</div>
      <div class="facts">
        <span>${new Date(hp().capturedAt).toLocaleString()}</span>
        <span>${[cap.mode || 'reading', ...extras].join(' · ')}</span>
        <span>${reading.log.entries.length} requests</span>
        <span>${formatBytes(bytes)}</span>
        ${cap.durationMs ? html`<span>captured in ${formatMs(cap.durationMs)}</span>` : ''}
        ${cap.source ? html`<span>imported from ${cap.source}</span>` : ''}
        ${t.url && t.url !== t.finalUrl ? html`<span>started at ${t.url}</span>` : ''}
      </div>
      <div class="chips">${SEVERITIES.map((s) => html`<button type="button" class="chip" data-sev-only="${s}"><span class="sev sev-${s}">${counts[s]} ${s}</span></button>`)}</div>
      ${hp().tags?.length ? html`<div style="margin-top:.6rem">${h.tags(hp().tags)}</div>` : ''}
      ${cap.warnings?.length ? html`<p class="note">Capture notes: ${cap.warnings.join('; ')}</p>` : ''}
    </div>
  </section>`;
}

function readout() {
  const cards = ordered().filter((r) => r.summary?.length || r.status === 'error');
  if (!cards.length) return html`<p class="muted">No plugin readings yet.</p>`;
  const groupOf = (r) => pluginById(plugins, r.id)?.group || 'other';
  return html`${Object.entries(GROUP_LABELS).map(([group, label]) => {
    const list = cards.filter((r) => groupOf(r) === group);
    if (!list.length) return '';
    return html`<h3 class="readout-group">${label}</h3><div class="readout">${list.map((r) => html`
      <article class="card card-${r.status}">
        <h3><span class="status-dot status-${r.status}"></span><a href="#p-${r.id}">${r.name}</a></h3>
        ${r.summary?.length ? h.kv(r.summary.map((s) => [s.label, s.value])) : html`<p class="error">${r.error}</p>`}
      </article>`)}</div>`;
  })}`;
}

function screens() {
  const shots = (hp().screenshots || []).filter((s) => s.kind !== 'thumbnail');
  if (!shots.length) return html`<p class="muted">No screenshots in this reading.</p>`;
  return html`<div class="shots">${shots.map((s) => html`
    <figure>
      <div class="frame"><img src="${screenshotURL(s)}" alt="${s.kind === 'fullpage' ? 'Full-page' : 'Viewport'} screenshot" data-zoom="${s.kind}" loading="lazy"></div>
      <figcaption>${s.kind === 'fullpage' ? 'Full page' : 'Viewport'} · ${s.cssWidth}×${s.cssHeight} CSS px · ${s.dpr}× DPR${s.truncated ? ' · truncated' : ''}</figcaption>
    </figure>`)}</div>`;
}

function findingTools() {
  const cats = [...new Set(allFindings(reading).map((f) => f.category))].sort();
  return html`
    <div class="chips" role="group" aria-label="Severity">${SEVERITIES.map((s) => html`<button type="button" class="chip" data-sev="${s}" aria-pressed="${String(state.sev.has(s))}"><span class="sev sev-${s}">${s}</span></button>`)}</div>
    <select id="f-cat" aria-label="Category"><option value="">All categories</option>${cats.map((c) => html`<option ${c === state.category ? 'selected' : ''}>${c}</option>`)}</select>
    <input type="search" id="f-q" placeholder="Filter findings" aria-label="Filter findings" value="${state.q}">`;
}

function renderFindings() {
  const list = allFindings(reading).filter((f) => state.sev.has(f.severity) &&
    (!state.category || f.category === state.category) &&
    (!state.q || `${f.title} ${f.detail || ''} ${f.pluginName}`.toLowerCase().includes(state.q)));
  $('#findings-table').innerHTML = list.length ? String(html`<div class="table-wrap findings"><table class="data">
    <thead><tr><th scope="col">Severity</th><th scope="col">Category</th><th scope="col">Finding</th><th scope="col">Source</th></tr></thead>
    <tbody>${list.map((f) => html`<tr>
      <td>${h.sev(f.severity)}</td>
      <td>${f.category}</td>
      <td>${f.title}${f.detail ? html`<div class="detail">${f.detail}</div>` : ''}
        ${f.evidence ? html`<details><summary>evidence</summary><pre>${typeof f.evidence === 'string' ? f.evidence : JSON.stringify(f.evidence, null, 2)}</pre></details>` : ''}
        ${f.ref ? html`<div class="detail">${h.link(f.ref, 'reference')}</div>` : ''}</td>
      <td><a href="#p-${f.plugin}">${f.pluginName}</a></td>
    </tr>`)}</tbody></table></div>`) : '<p class="muted">No findings match.</p>';
}

function pluginPanels() {
  const ran = ordered();
  const notRun = plugins.filter((p) => !hp().plugins?.[p.id]);
  return html`
    ${ran.map((r) => html`<details class="plugin" id="p-${r.id}">
      <summary>
        <span class="status-dot status-${r.status}" title="${r.status}"></span>
        <span class="name">${r.name}</span>
        <span class="tag">${r.phase}</span>
        ${r.findings?.length ? html`<span class="muted">${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}</span>` : ''}
        <span class="meta">${r.status} · ${formatMs(r.durationMs)}${r.contacted?.length ? ` · contacted ${r.contacted.map((c) => `${c.host} ×${c.count}`).join(', ')}` : ''}</span>
      </summary>
      <div class="content">
        ${renderResult(pluginById(plugins, r.id), r)}
        ${r.data != null ? html`<details class="raw" data-raw="${r.id}"><summary>Raw data</summary></details>` : ''}
      </div>
    </details>`)}
    ${notRun.length ? html`<p class="note">Not run: ${notRun.map((p) => `${p.name}${pluginEnabled(p, settings) ? '' : ' (disabled)'}`).join(', ')}. Enable plugins in the popup or Options, then re-run.</p>` : ''}`;
}

function netTools() {
  const types = ['document', 'script', 'stylesheet', 'image', 'font', 'xhr', 'media', 'other'];
  return html`
    <input type="search" id="n-q" placeholder="Filter URLs" aria-label="Filter requests" value="${state.netQ}">
    <select id="n-type" aria-label="Type"><option value="">All types</option>${types.map((t) => html`<option ${t === state.netType ? 'selected' : ''}>${t}</option>`)}</select>
    <select id="n-party" aria-label="Party">${[['', 'First & third party'], ['first', 'First party'], ['third', 'Third party']].map(([v, l]) => html`<option value="${v}" ${v === state.netParty ? 'selected' : ''}>${l}</option>`)}</select>`;
}

function renderNetwork() {
  const entries = reading.log.entries;
  if (!entries.length) { $('#net-table').innerHTML = '<p class="muted">No requests recorded.</p>'; return; }
  const site = hp().target?.site;
  const starts = entries.map((e) => Date.parse(e.startedDateTime));
  const t0 = Math.min(...starts);
  const end = Math.max(1, ...entries.map((e, i) => starts[i] - t0 + Math.max(0, e.time || 0)));
  const pct = (n) => Math.max(0, Math.min(100, (n / end) * 100)).toFixed(2);
  const rows = entries.map((e, i) => ({ e, i, host: hostOf(e.request.url), type: resourceType(e) }))
    .filter(({ e, host, type }) => (!state.netQ || e.request.url.toLowerCase().includes(state.netQ)) &&
      (!state.netType || type === state.netType) &&
      (!state.netParty || (state.netParty === 'third') === isThirdParty(host, site)));
  const shown = rows.slice(0, 800);
  $('#net-table').innerHTML = String(html`
    <p class="note">${rows.length} of ${entries.length} requests · span ${formatMs(end)}${rows.length > shown.length ? ` · showing first ${shown.length}` : ''} · amber bars are third-party</p>
    <div class="table-wrap net"><table class="data">
      <thead><tr><th scope="col">#</th><th scope="col">Status</th><th scope="col">Method</th><th scope="col">Type</th><th scope="col">URL</th><th scope="col">Size</th><th scope="col">Time</th><th scope="col">Waterfall</th></tr></thead>
      <tbody>${shown.map(({ e, i, host, type }) => {
        const start = starts[i] - t0;
        let path = e.request.url;
        try { const u = new URL(e.request.url); path = u.pathname + u.search; } catch { /* keep raw */ }
        const bad = e._error || e.response.status >= 400 || e.response.status === 0;
        return html`<tr data-entry="${i}" tabindex="0">
          <td class="num">${i + 1}</td>
          <td class="num ${bad ? 'status-err' : ''}">${e._error ? 'ERR' : e.response.status || '—'}</td>
          <td>${e.request.method}</td>
          <td>${type}</td>
          <td class="url" title="${e.request.url}">${host}<span class="muted">${path.slice(0, 90)}</span></td>
          <td class="num">${formatBytes(transferSize(e))}</td>
          <td class="num">${formatMs(e.time)}</td>
          <td><div class="wf"><span class="${isThirdParty(host, site) ? 'third' : ''}" style="left:${pct(start)}%;width:${pct(Math.max(0, e.time || 0))}%"></span></div></td>
        </tr>`;
      })}</tbody>
    </table></div>`);
}

function notesForm() {
  return html`<form id="notes-form" class="notes card">
    <label>Tags <input type="text" name="tags" value="${(hp().tags || []).join(', ')}" placeholder="prospect, competitor, audit-q4" style="width:100%"></label>
    <label>Notes <textarea name="notes" placeholder="What did you learn from this reading?">${hp().notes || ''}</textarea></label>
    <div><button class="btn primary" type="submit">Save notes</button></div>
  </form>`;
}

function render() {
  const t = hp().target || {};
  document.title = `${t.title || t.host || 'Reading'} — HAR-PLUS`;
  $('#app').innerHTML = String(html`
    ${hero()}
    <section class="block" id="readout"><header><h2>Readout</h2></header>${readout()}</section>
    <section class="block" id="screens"><header><h2>Screens</h2></header>${screens()}</section>
    <section class="block" id="findings"><header><h2>Findings</h2><div class="tools">${findingTools()}</div></header><div id="findings-table"></div></section>
    <section class="block" id="plugins"><header><h2>Plugins</h2></header>${pluginPanels()}</section>
    <section class="block" id="network"><header><h2>Network</h2><div class="tools">${netTools()}</div></header><div id="net-table"></div></section>
    <section class="block" id="notes"><header><h2>Notes &amp; tags</h2></header>${notesForm()}</section>`);
  renderFindings();
  renderNetwork();
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
  const zoom = t.closest('[data-zoom]');
  if (zoom) {
    const shot = hp().screenshots.find((s) => s.kind === zoom.dataset.zoom);
    openDialog(zoom.dataset.zoom === 'fullpage' ? 'Full-page screenshot' : 'Viewport screenshot',
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
  const only = t.closest('[data-sev-only]');
  if (only) {
    state.sev = new Set([only.dataset.sevOnly]);
    document.querySelectorAll('[data-sev]').forEach((b) => b.setAttribute('aria-pressed', String(state.sev.has(b.dataset.sev))));
    renderFindings();
    $('#findings').scrollIntoView({ behavior: 'smooth' });
    return;
  }
  const exp = t.closest('[data-export]');
  if (exp) {
    $('#export-menu').hidePopover();
    const stem = fileStem(reading);
    if (exp.dataset.export === 'full') download(`${stem}.har`, JSON.stringify(reading));
    if (exp.dataset.export === 'lite') download(`${stem}.lite.har`, JSON.stringify(stripForSharing(reading)));
    if (exp.dataset.export === 'markdown') download(`${stem}.md`, toMarkdown(reading), 'text/markdown');
    if (exp.dataset.export === 'copy') { await navigator.clipboard.writeText(toMarkdown(reading)); toast('Brief copied'); }
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

$('#dlg-close').addEventListener('click', () => $('#dlg').close());

$('#rerun').addEventListener('click', async () => {
  const btn = $('#rerun');
  btn.disabled = true;
  settings = await getSettings();
  plugins = getPlugins(settings);
  await runPlugins(reading, plugins, {
    phases: ['analyze', 'enrich'],
    settings,
    onProgress: (p) => { btn.textContent = `${p.name}…`; },
  });
  await saveReading(reading);
  btn.textContent = 'Re-run analysis';
  btn.disabled = false;
  render();
  toast('Analysis updated');
});

$('#delete').addEventListener('click', async () => {
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
  reading = id ? await getReading(id) : null;
  if (!reading) {
    $('#app').innerHTML = '<p class="empty">Reading not found. <a href="library.html">Back to readings</a></p>';
    return;
  }
  render();
}

init();
