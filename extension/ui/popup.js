import { getSettings, updateSettings } from '../browser/settings.js';
import { getPlugins, PHASE_LABELS } from '../plugins/index.js';
import { pluginEnabled } from '../core/plugin-host.js';
import { html, raw } from './render.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });
const BLOCKED = /^(chrome|edge|about|chrome-extension|devtools|view-source):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/;

let tab;
let settings;
let recording = false;

async function currentTab() {
  if (params.has('tab')) return chrome.tabs.get(Number(params.get('tab')));
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}

function setStatus(text, { error = false, link } = {}) {
  const out = $('#status');
  out.classList.toggle('error', error);
  out.innerHTML = link ? html`${text} — <a href="${link}" target="_blank">open</a>` : html`${text}`;
}

function setBusy(busy) {
  for (const b of ['#take', '#snapshot']) $(b).disabled = busy || recording;
  $('#record').disabled = busy && !recording;
  $('#record').textContent = recording ? '■ Stop recording' : '● Record';
  $('#record').classList.toggle('danger', recording);
}

function renderPlugins() {
  const plugins = getPlugins(settings);
  const on = plugins.filter((p) => pluginEnabled(p, settings)).length;
  $('#plugin-count').textContent = `(${on} of ${plugins.length} on)`;
  const checked = (b) => raw(b ? 'checked' : '');
  $('#plugins').innerHTML = String(html`${Object.entries(PHASE_LABELS).map(([phase, label]) => html`
    <fieldset>
      <legend>${label}${phase === 'enrich' ? html`<label style="margin-inline-start:auto"><input type="checkbox" data-phase="enrich" ${checked(settings.phases.enrich !== false)}> enabled</label>` : ''}</legend>
      ${plugins.filter((p) => p.phase === phase).map((p) => html`
        <label title="${p.disclosure || p.description || ''}">
          <input type="checkbox" data-plugin="${p.id}" ${checked(settings.plugins[p.id]?.enabled ?? p.defaultEnabled !== false)}>
          <span>${p.name}${p.disclosure ? html` <small>↗</small>` : ''}</span>
        </label>`)}
    </fieldset>`)}`);
}

function renderCaptureOptions() {
  for (const el of $('#capture-opts').querySelectorAll('[name]')) {
    const v = settings.capture[el.name];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
}

async function init() {
  settings = await getSettings();
  tab = await currentTab();
  $('#title').textContent = tab?.title || 'No tab';
  $('#url').textContent = tab?.url || '';
  renderCaptureOptions();
  renderPlugins();

  if (!tab || BLOCKED.test(tab.url || '')) {
    setBusy(true);
    $('#record').disabled = true;
    setStatus('Browser pages and the Web Store cannot be inspected.', { error: true });
    return;
  }
  const st = await send('harplus:status', { tabId: tab.id });
  recording = !!st?.recording;
  setBusy(!!st?.busy);
  if (st?.busy || recording) setStatus(st.status?.text || (recording ? 'Recording…' : 'Working…'));
}

$('#capture-opts').addEventListener('change', async (e) => {
  const el = e.target;
  settings = await updateSettings((s) => { s.capture[el.name] = el.type === 'checkbox' ? el.checked : el.value; });
});

$('#plugins').addEventListener('change', async (e) => {
  const el = e.target;
  settings = await updateSettings((s) => {
    if (el.dataset.phase) s.phases[el.dataset.phase] = el.checked;
    if (el.dataset.plugin) s.plugins[el.dataset.plugin] = { ...s.plugins[el.dataset.plugin], enabled: el.checked };
  });
  renderPlugins();
});

async function start(mode) {
  setBusy(true);
  setStatus(mode === 'snapshot' ? 'Taking a snapshot…' : 'Starting…');
  const r = await send('harplus:capture', { tabId: tab.id, options: { mode } });
  if (r?.error) { setStatus(r.error, { error: true }); setBusy(recording); }
}

$('#take').addEventListener('click', () => start('reload'));
$('#snapshot').addEventListener('click', () => start('snapshot'));
$('#record').addEventListener('click', async () => {
  if (recording) {
    recording = false;
    setBusy(true);
    setStatus('Finishing recording…');
    await send('harplus:record-stop', { tabId: tab.id });
    return;
  }
  const r = await send('harplus:record-start', { tabId: tab.id, options: {} });
  if (r?.error) { setStatus(r.error, { error: true }); return; }
  recording = true;
  setBusy(true);
  setStatus('Recording — browse, then press Stop');
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'harplus:progress' || msg.tabId !== tab?.id) return;
  if (msg.stage === 'done') {
    setStatus('Reading saved', { link: `reading.html?id=${msg.readingId}` });
    setBusy(false);
  } else if (msg.stage === 'error') {
    recording = false;
    setStatus(msg.text, { error: true });
    setBusy(false);
  } else if (msg.stage !== 'recording') {
    setStatus(msg.text);
  }
});

init();
