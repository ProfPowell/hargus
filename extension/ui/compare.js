// The compare page: library readings (?ids=a,b,c) or a set and its rounds (?set=<id>[&after=<i>&before=<j>]).
// Loads, builds the models and draws through compare-view.js; the export reuses the same markup with no script.

import { getReading, getSet } from '../browser/store.js';
import { getSettings } from '../browser/settings.js';
import { getPlugins } from '../plugins/index.js';
import { profileFromSettings } from '../core/score.js';
import { compareReadings, conditions, compareRounds, MAX_SITES } from '../core/compare.js';
import { roundState } from '../core/sets.js';
import { renderCompare, compareDocument, roundPicker, roundProgress } from './compare-view.js';
import { html, toast, download, exportAssets } from './render.js';

const $ = (s) => document.querySelector(s);
let current = null; // { model, opts, stem } of what is on screen, for Export
let busy = false;
let again = false;

const urlOf = (reading) => reading.log._harplus?.target?.finalUrl || reading.log._harplus?.target?.url || '';

// Whether the background is still finishing this reading's analysis; no answer means nothing is.
async function analysing(readingId) {
  try {
    return !!(await chrome.runtime.sendMessage({ type: 'harplus:analysing', readingId }))?.alive;
  } catch {
    return false;
  }
}

// A loaded reading as a compareReadings site, or the word that stands in for its column.
async function siteFor(key, url, reading) {
  if (!reading) return { key, url, gap: 'reading deleted' };
  const hp = reading.log._harplus || {};
  if (hp.analysis === 'pending') {
    return { key, url, gap: await analysing(hp.id) ? 'analysing' : 'analysis not finished — open the reading' };
  }
  if (hp.capture?.mode === 'record') return { key, url, gap: "Recordings of several pages can't be compared yet" };
  return { key, reading };
}

// The background names the set whose round is recording; no handler or an error means none.
async function setStatus() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'harplus:set-status' });
    return r && typeof r === 'object' && 'running' in r ? r : { running: null };
  } catch {
    return { running: null };
  }
}

async function fromIds(raw) {
  const all = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  const notes = all.length > MAX_SITES ? [`Showing the first ${MAX_SITES} of ${all.length} readings`] : [];
  const ids = all.slice(0, MAX_SITES);
  if (ids.length < 2) return { message: 'Pick at least 2 readings to compare.' };
  const readings = await Promise.all(ids.map((id) => getReading(id)));
  const seen = new Set();
  const links = {};
  const sites = await Promise.all(ids.map((id, i) => {
    const r = readings[i];
    const url = r ? urlOf(r) : '';
    // The URL is the key; the same page twice falls back to the reading id so both columns stay.
    const key = url && !seen.has(url) ? url : id;
    seen.add(key);
    if (r) links[key] = id;
    return siteFor(key, url, r);
  }));
  return { sites, notes, links, title: 'Comparing readings' };
}

// One round's sites: errors and deleted readings become gaps; a site still recording shows its state.
async function roundSites(round, state, links) {
  return Promise.all(round.readings.slice(0, MAX_SITES).map(async (e) => {
    if (e.error) return { key: e.url, url: e.url, gap: `not recorded: ${e.error}` };
    if (!e.id) {
      if (state === 'running') return { key: e.url, url: e.url, gap: e.state || 'waiting' };
      return { key: e.url, url: e.url, gap: 'not recorded: the round did not finish' };
    }
    const reading = await getReading(e.id);
    if (reading) links[e.url] = e.id;
    return siteFor(e.url, e.url, reading);
  }));
}

async function fromSet(setId, params) {
  const set = await getSet(setId);
  if (!set) return { message: 'This set no longer exists.' };
  if (!set.rounds.length) return { message: 'This set has no rounds yet.', title: set.name };
  const { running } = await setStatus();
  const alive = running === set.id;
  const list = set.rounds.map((r) => ({ at: r.at, state: roundState(r, { alive }) }));
  const last = list.length - 1;
  const pick = (name, fallback) => {
    const n = params.has(name) ? Number(params.get(name)) : fallback;
    return Number.isInteger(n) && n >= 0 && n <= last ? n : fallback;
  };
  const after = pick('after', last);
  const before = pick('before', after > 0 ? after - 1 : -1);
  const links = {};
  const sites = await roundSites(set.rounds[after], list[after].state, links);
  const beforeSites = before >= 0 && before !== after ? await roundSites(set.rounds[before], list[before].state, {}) : null;
  const progress = list[last].state === 'running' ? set.rounds[last] : null;
  const total = set.rounds[after].readings.length;
  const notes = total > MAX_SITES ? [`Showing the first ${MAX_SITES} of ${total} sites`] : [];
  return {
    sites, beforeSites, links, progress, notes, title: set.name, heading: set.name,
    rounds: list.length >= 2 ? { list, before: before >= 0 ? before : after, after } : null,
  };
}

async function build() {
  const params = new URLSearchParams(location.search);
  const got = params.has('set') ? await fromSet(params.get('set'), params) : await fromIds(params.get('ids') || '');
  $('#appbar-title').textContent = got.title || '';
  document.title = `${got.title || 'Compare'} — HARgus`;
  if (got.message) return { message: got.message, progress: got.progress, rounds: got.rounds };
  const settings = await getSettings();
  const plugins = getPlugins(settings);
  const profile = profileFromSettings(settings);
  const model = compareReadings(got.sites, plugins, { profile });
  const delta = got.beforeSites ? compareRounds(compareReadings(got.beforeSites, plugins, { profile }), model) : null;
  // One site is a comparison only as before and after.
  if (got.sites.length < 2 && !delta) {
    return { message: params.has('set') ? 'Record this set again to compare before and after.' : 'Pick at least 2 readings to compare.', progress: got.progress, rounds: got.rounds };
  }
  const opts = { conditions: conditions(got.sites), delta, rounds: got.rounds, progress: got.progress, notes: got.notes || [], links: got.links, title: got.heading || '' };
  return { model, opts, stem: got.heading };
}

async function render() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    const view = await build();
    if (view.message) {
      current = null;
      $('#app').innerHTML = String(html`${roundProgress(view.progress)}${roundPicker(view.rounds, { interactive: true })}<p class="empty">${view.message}</p>`);
    } else {
      current = view;
      $('#app').innerHTML = String(renderCompare(view.model, { ...view.opts, interactive: true }));
    }
    $('#export').disabled = !current;
    $('#print').disabled = !current;
  } catch (err) {
    $('#app').innerHTML = String(html`<p class="error">The comparison could not be built: ${err.message}</p>`);
  } finally {
    busy = false;
    if (again) { again = false; render(); }
  }
}

$('#app').addEventListener('change', (e) => {
  const sel = e.target.closest('#round-after, #round-before');
  if (!sel) return;
  const params = new URLSearchParams(location.search);
  params.set(sel.id === 'round-after' ? 'after' : 'before', sel.value);
  history.replaceState(null, '', `${location.pathname}?${params}`);
  render();
});

// Stop on the progress card: the round ends after the site it is on.
$('#app').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-stop-set]');
  if (!btn) return;
  btn.disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'harplus:stop-set', setId: new URLSearchParams(location.search).get('set') });
    toast(r?.stopping ? 'Stopping after the current site' : 'Nothing is recording');
  } catch (err) {
    btn.disabled = false;
    toast(err?.message || 'Could not stop the round', 5000);
  }
});

$('#print').addEventListener('click', () => window.print());

$('#export').addEventListener('click', async () => {
  if (!current) return;
  const { css, fonts, fontMissing } = await exportAssets();
  const day = new Date().toISOString().slice(0, 10);
  const stem = String(current.stem || 'comparison').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'comparison';
  download(`${stem}-${day}.compare.html`, compareDocument(current.model, current.opts, { css, fonts }), 'text/html');
  if (fontMissing) toast('Exported without the custom font');
});

chrome.runtime.onMessage.addListener((msg) => {
  const setId = new URLSearchParams(location.search).get('set');
  if (msg?.type === 'harplus:set-progress' && setId && msg.setId === setId) render();
  if (msg?.type === 'harplus:progress' && msg.stage === 'done') render();
});

render();
