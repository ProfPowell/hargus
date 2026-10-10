import { getSettings, updateSettings } from '../browser/settings.js';
import { listReadings, deleteAll } from '../browser/store.js';
import { BUILTIN, PHASE_LABELS } from '../plugins/index.js';
import { formatBytes } from '../core/har-util.js';
import { html, toast } from './render.js';
import { getIn, setIn } from './paths.js';

const $ = (s) => document.querySelector(s);
let settings;

function field(o, path) {
  if (o.type === 'checkbox') return html`<label class="chip"><input type="checkbox" data-path="${path}" data-default="${String(!!o.default)}"> ${o.label}</label>`;
  if (o.type === 'select') {
    return html`<label>${o.label}<select data-path="${path}" data-default="${o.default}">${o.choices.map((c) => html`<option>${c}</option>`)}</select></label>`;
  }
  return html`<label>${o.label}<input type="${o.type === 'number' ? 'number' : 'text'}" data-path="${path}" data-default="${o.default ?? ''}"></label>`;
}

function renderPlugins() {
  $('#plugins').innerHTML = String(html`${Object.entries(PHASE_LABELS).map(([phase, label]) => html`
    <h3 style="margin-top:1rem">${label}
      ${phase === 'enrich' ? html`<label class="chip" style="margin-inline-start:.5rem"><input type="checkbox" data-path="phases.enrich" data-default="true"> enabled</label>` : ''}
    </h3>
    ${BUILTIN.filter((p) => p.phase === phase).map((p) => html`
      <div class="card" style="margin-top:.5rem;padding:.75rem">
        <label><input type="checkbox" data-path="plugins.${p.id}.enabled" data-default="${String(p.defaultEnabled !== false)}"> <strong>${p.name}</strong> <span class="muted mono">${p.id}</span></label>
        <p class="note">${p.description}${p.disclosure ? html`<br>↗ ${p.disclosure}` : ''}</p>
        ${p.options?.length ? html`<div class="form-grid" style="margin-top:.5rem">${p.options.map((o) => field(o, `plugins.${p.id}.options.${o.key}`))}</div>` : ''}
      </div>`)}`)}`);
}

function renderRemotes() {
  const list = settings.remotes || [];
  $('#remotes').innerHTML = list.length ? String(html`<div class="table-wrap"><table class="data">
    <thead><tr><th>On</th><th>Name</th><th>Endpoint</th><th>Sends</th><th></th></tr></thead>
    <tbody>${list.map((r, i) => html`<tr>
      <td><input type="checkbox" data-path="remotes.${i}.enabled" data-default="true" aria-label="Enable ${r.name}"></td>
      <td>${r.name}</td><td class="mono">${r.url}</td><td>${r.send}</td>
      <td><button class="btn ghost danger" type="button" data-remove="${i}">Remove</button></td>
    </tr>`)}</tbody></table></div>`) : '<p class="muted">No remote plugins yet.</p>';
}

function bind() {
  for (const el of document.querySelectorAll('[data-path]')) {
    const v = getIn(settings, el.dataset.path);
    const fallback = el.dataset.default;
    if (el.type === 'checkbox') el.checked = v ?? fallback === 'true';
    else el.value = v ?? fallback ?? '';
  }
}

function flashSaved() {
  $('#saved').textContent = 'Saved';
  clearTimeout(flashSaved.t);
  flashSaved.t = setTimeout(() => { $('#saved').textContent = ''; }, 1500);
}

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (!el.dataset?.path) return;
  const value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
  settings = await updateSettings((s) => setIn(s, el.dataset.path, value));
  flashSaved();
});

$('#remote-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const id = `${f.name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'remote';
  settings = await updateSettings((s) => {
    s.remotes = [...(s.remotes || []), { id, name: f.name, url: f.url, send: f.send, token: f.token || undefined, timeoutSec: Number(f.timeoutSec) || 120, enabled: true }];
  });
  e.target.reset();
  renderRemotes();
  bind();
  toast(`Added ${f.name}`);
});

$('#remotes').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  settings = await updateSettings((s) => { s.remotes.splice(Number(btn.dataset.remove), 1); });
  renderRemotes();
  bind();
});

$('#wipe').addEventListener('click', async () => {
  const btn = $('#wipe');
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = 'Really delete every reading?';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Delete all readings'; }, 4000);
    return;
  }
  await deleteAll();
  toast('All readings deleted');
  usage();
});

async function usage() {
  const n = (await listReadings()).length;
  const est = await navigator.storage?.estimate?.();
  $('#usage').textContent = `${n} readings stored${est ? ` · ${formatBytes(est.usage)} used` : ''}.`;
}

async function init() {
  settings = await getSettings();
  renderPlugins();
  renderRemotes();
  bind();
  usage();
}

init();
