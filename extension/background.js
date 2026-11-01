// Service worker: orchestrates readings. Capture (live page) → save at once → the reading tab finishes analysis.

import { takeReading, startRecording, stopRecording, isBusy, isRecording, discard } from './browser/capture.js';
import { getSettings } from './browser/settings.js';
import { saveReading, saveViewsPatch, getSet, saveSet } from './browser/store.js';
import { getPlugins } from './plugins/index.js';
import { addStep, badgeFor, labelFor } from './core/progress.js';
import { runRound } from './core/round.js';

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

/* ------------------------------------------------------- list recording */

// One round at a time, held only in memory: after a worker restart `round` is null and the stored round reads as
// incomplete. The decisions live in core/round.js; this wires them to chrome.
let round = null; // { setId, windowId, tabs: Set<working tab ids>, stop, progressTab }
const finishedReadings = new Set(); // analysis done during the round, kept so a done before the wait isn't missed
const failedTabs = new Set(); // source tabs whose analysis reported an error during the round
const analysisWaits = new Map(); // readingId → { tabId, settle(result) }
const readingTabs = new Map(); // readingId → working tab it was captured in
const NAVIGATE_MS = 20_000;

function analysisDone(readingId, ms) {
  const tabId = readingTabs.get(readingId);
  if (finishedReadings.has(readingId)) return Promise.resolve('done');
  if (failedTabs.has(tabId)) return Promise.resolve('error');
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle('timeout'), ms);
    function settle(result) { clearTimeout(timer); analysisWaits.delete(readingId); resolve(result); }
    analysisWaits.set(readingId, { tabId, settle });
  });
}

function analysisReported(m) {
  if (!round) return;
  if (m.stage === 'done' && m.readingId) {
    finishedReadings.add(m.readingId);
    analysisWaits.get(m.readingId)?.settle('done');
  } else if (m.stage === 'error') {
    failedTabs.add(m.tabId);
    for (const w of [...analysisWaits.values()]) if (w.tabId === m.tabId) w.settle('error');
  }
}

/** Load `url` in the tab; resolves once it has loaded (or after NAVIGATE_MS) — the reload reading takes over. */
function navigate(tabId, url) {
  return new Promise((resolve, reject) => {
    let loading = false;
    const timer = setTimeout(finish, NAVIGATE_MS);
    function finish() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); }
    function onUpdated(id, info) {
      if (id !== tabId) return;
      if (info.status === 'loading') loading = true;
      else if (info.status === 'complete' && loading) finish();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url }).catch((e) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(e);
    });
  });
}

function roundDeps(r) {
  return {
    workingTab: [...r.tabs][0],
    save: async (set) => {
      await saveSet(set);
      chrome.runtime.sendMessage({ type: 'harplus:set-progress', setId: set.id }).catch(() => {});
    },
    openTab: async (url) => {
      const t = await chrome.tabs.create({ windowId: r.windowId, url, active: true });
      r.tabs.add(t.id);
      return t.id;
    },
    closeTab: (tabId) => chrome.tabs.remove(tabId).catch(() => {}),
    navigate,
    capture: async (tabId, settings) => {
      failedTabs.delete(tabId);
      const url = chrome.runtime.getURL(`ui/reading.html?capture=${tabId}&close=1`);
      r.progressTab = await chrome.tabs.create({ windowId: r.windowId, url, active: false }).then((t) => t.id, () => null);
      const id = await capture(tabId, { ...settings, progressTab: r.progressTab ?? undefined });
      readingTabs.set(id, tabId);
      return id;
    },
    analysisDone,
    abandon: async () => {
      if (r.progressTab != null) await chrome.tabs.remove(r.progressTab).catch(() => {});
      r.progressTab = null;
    },
    busy: (tabId) => isBusy(tabId) || starting.has(tabId),
    stopped: () => r.stop,
    now: Date.now,
  };
}

async function recordSet(set, r) {
  try {
    await runRound(set, roundDeps(r));
  } catch {
    // The set could not be saved: the stored round stays "running" and reads as incomplete once `round` clears.
  } finally {
    round = null;
    for (const w of [...analysisWaits.values()]) w.settle('error');
    finishedReadings.clear();
    failedTabs.clear();
    readingTabs.clear();
    chrome.runtime.sendMessage({ type: 'harplus:set-progress', setId: set.id }).catch(() => {});
    const url = chrome.runtime.getURL(`ui/compare.html?set=${encodeURIComponent(set.id)}`);
    await chrome.tabs.create({ windowId: r.windowId, url, active: true }).catch(() => chrome.tabs.create({ url })).catch(() => {});
  }
}

const handlers = {
  'harplus:record-set': async (m) => {
    if (round) throw new Error('A set is already recording');
    const set = await getSet(m.setId);
    if (round) throw new Error('A set is already recording');
    if (!set) throw new Error('This set no longer exists');
    if (!set.urls?.length) throw new Error('This set has no URLs to record');
    const r = { setId: set.id, windowId: null, tabs: new Set(), stop: false, progressTab: null };
    round = r; // claimed before the next await, so a second request is refused
    try {
      const win = await chrome.windows.create({ url: 'about:blank', focused: true, type: 'normal' });
      r.windowId = win.id;
      r.tabs.add(win.tabs[0].id);
    } catch (e) {
      round = null;
      throw e;
    }
    recordSet(set, r);
    return { started: true };
  },
  'harplus:stop-set': (m) => {
    if (round && (m.setId == null || m.setId === round.setId)) round.stop = true;
    return { stopping: !!round?.stop };
  },
  'harplus:set-status': () => ({ running: round?.setId ?? null }),
  'harplus:capture': (m) => { assertIdle(m.tabId); capture(m.tabId, m.options).catch(() => {}); return { started: true }; },
  'harplus:record-start': async (m) => { await record(m.tabId, m.options); return { recording: true }; },
  'harplus:record-stop': (m) => { stop(m.tabId).catch(() => {}); return { stopping: true }; },
  'harplus:status': (m) => ({ busy: isBusy(m.tabId), recording: isRecording(m.tabId), status: status.get(m.tabId) || null }),
  // Are this reading's views still being taken? A restarted worker has no status, so it answers false.
  // (The views patch is saved before the capture session ends, so "not busy" means the patch is stored or never coming.)
  'harplus:views-alive': (m) => ({ alive: [...status].some(([tabId, s]) => s.readingId === m.readingId && isBusy(tabId)) }),
  'harplus:analysis': async (m, sender) => {
    if (m.tabId == null) return { ok: false };
    analysisReported(m);
    if (m.stage === 'done') {
      report(m.tabId, 'done', { readingId: m.readingId, text: 'Reading complete' });
      setTimeout(() => badge(m.tabId, ''), 5000);
      const settings = await getSettings();
      const pt = sender?.tab?.id ?? status.get(m.tabId)?.progressTabId;
      const inRound = round?.tabs.has(m.tabId); // a list recording never brings reading tabs forward
      if (settings.ui.openWhenDone && pt != null && !inRound) {
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

// Closing the recording window stops the round; waits for readings in it would never be answered.
chrome.windows.onRemoved.addListener((windowId) => {
  if (!round || round.windowId !== windowId) return;
  round.stop = true;
  for (const w of [...analysisWaits.values()]) w.settle('error');
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
