// Service worker: orchestrates readings. Capture (live page) → save at once → the reading tab finishes analysis.

import { takeReading, startRecording, stopRecording, isBusy, isRecording, discard } from './browser/capture.js';
import { getSettings } from './browser/settings.js';
import { saveReading, saveViewsPatch } from './browser/store.js';
import { getPlugins } from './plugins/index.js';
import { addStep, badgeFor, labelFor } from './core/progress.js';

const status = new Map(); // tabId → latest progress
const starting = new Set(); // tabIds with a capture/record/stop in flight before the session registers

const COLORS = { error: '#c92a2a', done: '#2b8a3e', recording: '#c92a2a' };

function badge(tabId, text, color = '#1971c2') {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

function report(tabId, stage, detail) {
  const text = typeof detail === 'string' ? detail
    : detail?.text ?? (detail?.name ? `${detail.name} — ${detail.status}${detail.error ? `: ${detail.error}` : ''}` : '');
  const prev = status.get(tabId) || {};
  const at = Date.now();
  const s = { ...prev, tabId, stage: stage === 'plugin' ? prev.stage || 'analyzing' : stage, text, at, steps: addStep(prev.steps, { stage, text, at }) };
  delete s.paused;
  if (detail?.readingId) s.readingId = detail.readingId;
  if (stage !== 'plugin') {
    const code = badgeFor(stage);
    const badges = prev.badges || [];
    s.badges = badges[badges.length - 1] === code ? badges : [...badges, code];
    badge(tabId, code, COLORS[stage]);
  }
  chrome.action.setTitle({ tabId, title: `HARgus — ${labelFor(s.stage)}${text ? `: ${text}` : ''}` }).catch(() => {});
  status.set(tabId, s);
  chrome.runtime.sendMessage({ type: 'harplus:progress', ...s }).catch(() => {});
}

/** A background tab next to the captured one that shows progress and becomes the report. */
async function openProgressTab(tabId, query) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const t = await chrome.tabs.create({ url: chrome.runtime.getURL(`ui/reading.html?${query}`), active: false, index: tab.index + 1, windowId: tab.windowId });
    return t.id;
  } catch {
    return null;
  }
}

/** Save the captured reading at once (analysis pending); the reading tab finishes it. */
async function complete(tabId, reading) {
  report(tabId, 'saving', 'Saving the reading');
  const hp = reading.log._harplus;
  hp.timing = { ...(hp.timing || {}), coreMs: Date.now() - Date.parse(hp.capture.startedAt) };
  reading.log._harplus.analysis = 'pending';
  const id = await saveReading(reading);
  const s = status.get(tabId) || {};
  const alive = s.progressTabId != null && await chrome.tabs.get(s.progressTabId).then(() => true, () => false);
  if (!alive) status.set(tabId, { ...s, progressTabId: await openProgressTab(tabId, `id=${id}&tab=${tabId}`) });
  report(tabId, 'analyzing', { readingId: id, text: 'Finishing lookups in the reading tab' });
  return id;
}

/** Views finished (or failed): store the patch for the reading tab and tell it. */
async function viewsDone(tabId, patch) {
  try {
    await saveViewsPatch(patch);
  } catch (e) {
    report(tabId, 'error', `views could not be saved: ${e.message}`);
    return;
  }
  // Only while the capture is still being followed: a closed source tab has no status, a closed reading tab left it
  // paused ("open the reading to finish"), and a finished reading is done — re-reporting would undo those.
  const s = status.get(tabId);
  if (s && !s.paused && s.stage !== 'done') report(tabId, 'analyzing', { readingId: patch.id, text: 'Finishing lookups in the reading tab' });
  chrome.runtime.sendMessage({ type: 'harplus:views', readingId: patch.id, tabId }).catch(() => {});
}

async function fail(tabId, e) {
  report(tabId, 'error', e.message);
  badge(tabId, '!', '#c92a2a');
}

function assertIdle(tabId) {
  if (starting.has(tabId)) throw new Error('Already capturing this tab');
  if (isBusy(tabId)) throw new Error(isRecording(tabId) ? 'This tab is being recorded — press Stop first' : 'Already capturing this tab');
}

async function begin(tabId, progressTab) {
  status.set(tabId, { startedAt: Date.now(), steps: [], badges: [] });
  const progressTabId = progressTab ?? await openProgressTab(tabId, `capture=${tabId}`);
  status.set(tabId, { ...status.get(tabId), progressTabId });
  badge(tabId, '…');
}

export async function capture(tabId, overrides = {}) {
  assertIdle(tabId);
  starting.add(tabId);
  try {
    const settings = await getSettings();
    const { progressTab, ...rest } = overrides;
    const opts = { ...settings.capture, ...rest };
    if (opts.mode === 'record') return await startRecord(tabId, rest);
    const plugins = getPlugins(settings);
    await begin(tabId, progressTab);
    try {
      let id;
      await takeReading(tabId, opts, {
        plugins, settings, report: (st, d) => report(tabId, st, d),
        onCore: async (r) => (id = await complete(tabId, r)),
        onViews: (patch) => viewsDone(tabId, patch),
      });
      return id;
    } catch (e) {
      await fail(tabId, e);
      throw e;
    }
  } finally {
    starting.delete(tabId);
  }
}

async function startRecord(tabId, overrides = {}) {
  const settings = await getSettings();
  const opts = { ...settings.capture, ...overrides };
  status.set(tabId, { startedAt: Date.now(), steps: [], badges: [] });
  await startRecording(tabId, opts, { report: (st, d) => report(tabId, st, d) });
  report(tabId, 'recording', 'Recording — browse, then press Stop');
}

export async function record(tabId, overrides = {}) {
  assertIdle(tabId);
  starting.add(tabId);
  try {
    return await startRecord(tabId, overrides);
  } finally {
    starting.delete(tabId);
  }
}

export async function stop(tabId) {
  if (starting.has(tabId)) throw new Error('Already capturing this tab');
  if (!isRecording(tabId)) throw new Error('This tab is not being recorded');
  starting.add(tabId);
  try {
    const settings = await getSettings();
    const plugins = getPlugins(settings);
    const prev = status.get(tabId) || {};
    status.set(tabId, { ...prev, startedAt: Date.now(), progressTabId: await openProgressTab(tabId, `capture=${tabId}`) });
    badge(tabId, '…');
    try {
      let id;
      await stopRecording(tabId, {
        plugins, settings, report: (st, d) => report(tabId, st, d),
        onCore: async (r) => (id = await complete(tabId, r)),
        onViews: (patch) => viewsDone(tabId, patch),
      });
      return id;
    } catch (e) {
      await fail(tabId, e);
      throw e;
    }
  } finally {
    starting.delete(tabId);
  }
}

const handlers = {
  'harplus:capture': (m) => { assertIdle(m.tabId); capture(m.tabId, m.options).catch(() => {}); return { started: true }; },
  'harplus:record-start': async (m) => { await record(m.tabId, m.options); return { recording: true }; },
  'harplus:record-stop': (m) => { stop(m.tabId).catch(() => {}); return { stopping: true }; },
  'harplus:status': (m) => ({ busy: isBusy(m.tabId), recording: isRecording(m.tabId), status: status.get(m.tabId) || null }),
  // Are this reading's views still being taken? A restarted worker has no status, so it answers false.
  // (The views patch is saved before the capture session ends, so "not busy" means the patch is stored or never coming.)
  'harplus:views-alive': (m) => ({ alive: [...status].some(([tabId, s]) => s.readingId === m.readingId && isBusy(tabId)) }),
  'harplus:analysis': async (m, sender) => {
    if (m.tabId == null) return { ok: false };
    if (m.stage === 'done') {
      report(m.tabId, 'done', { readingId: m.readingId, text: 'Reading complete' });
      setTimeout(() => badge(m.tabId, ''), 5000);
      const settings = await getSettings();
      const pt = sender?.tab?.id ?? status.get(m.tabId)?.progressTabId;
      if (settings.ui.openWhenDone && pt != null) {
        chrome.tabs.update(pt, { active: true }).catch(() => {});
        chrome.tabs.get(pt).then((t) => chrome.windows.update(t.windowId, { focused: true })).catch(() => {});
      }
    } else {
      report(m.tabId, m.stage === 'error' ? 'error' : 'plugin', m.text || '');
    }
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve().then(() => h(msg, sender)).then(reply, (e) => reply({ error: e.message }));
  return true;
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'take-reading' && tab?.id != null) capture(tab.id).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  status.delete(tabId);
  discard(tabId);
  // The reading tab closed mid-lookups: nobody will report back, so don't leave the badge on LOOK.
  for (const [srcTab, s] of status) {
    if (s.progressTabId !== tabId || s.stage !== 'analyzing' && s.stage !== 'views') continue;
    const text = 'Lookups paused — open the reading to finish';
    status.set(srcTab, { ...s, text, paused: true, at: Date.now() });
    badge(srcTab, '');
    chrome.action.setTitle({ tabId: srcTab, title: `HARgus — ${text}` }).catch(() => {});
  }
});

// Handy from the service-worker console: harplus.capture(tabId, { device: 'mobile' })
globalThis.harplus = { capture, record, stop, status };
globalThis.hargus = globalThis.harplus;
