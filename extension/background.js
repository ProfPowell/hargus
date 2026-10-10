// Service worker: orchestrates readings. Capture (live page) → analyze + enrich (offline/lookups) → store.

import { takeReading, startRecording, stopRecording, isBusy, isRecording, discard } from './browser/capture.js';
import { getSettings } from './browser/settings.js';
import { saveReading } from './browser/store.js';
import { getPlugins } from './plugins/index.js';
import { runPlugins } from './core/plugin-host.js';

const status = new Map(); // tabId → latest progress

function report(tabId, stage, detail) {
  const text = typeof detail === 'string' ? detail
    : detail?.name ? `${detail.name} — ${detail.status}${detail.error ? `: ${detail.error}` : ''}` : '';
  const s = { ...status.get(tabId), tabId, stage, text, at: Date.now() };
  if (detail?.readingId) s.readingId = detail.readingId;
  status.set(tabId, s);
  chrome.runtime.sendMessage({ type: 'harplus:progress', ...s }).catch(() => {});
}

function badge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

async function complete(tabId, reading, settings, plugins) {
  report(tabId, 'analyzing', 'Analyzing and looking things up');
  await runPlugins(reading, plugins, {
    phases: ['analyze', 'enrich'],
    settings,
    onProgress: (p) => report(tabId, 'plugin', p),
  });
  const id = await saveReading(reading);
  report(tabId, 'done', { readingId: id });
  badge(tabId, '✓', '#2b8a3e');
  setTimeout(() => badge(tabId, ''), 5000);
  if (settings.ui.openWhenDone) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    chrome.tabs.create({ url: chrome.runtime.getURL(`ui/reading.html?id=${id}`), index: tab ? tab.index + 1 : undefined });
  }
  return id;
}

async function fail(tabId, e) {
  report(tabId, 'error', e.message);
  badge(tabId, '!', '#c92a2a');
}

function assertIdle(tabId) {
  if (isBusy(tabId)) throw new Error(isRecording(tabId) ? 'This tab is being recorded — press Stop first' : 'Already capturing this tab');
}

export async function capture(tabId, overrides = {}) {
  assertIdle(tabId);
  const settings = await getSettings();
  const opts = { ...settings.capture, ...overrides };
  if (opts.mode === 'record') return record(tabId, overrides);
  const plugins = getPlugins(settings);
  status.set(tabId, { startedAt: Date.now() });
  badge(tabId, '…', '#1971c2');
  try {
    const reading = await takeReading(tabId, opts, { plugins, settings, report: (st, d) => report(tabId, st, d) });
    return await complete(tabId, reading, settings, plugins);
  } catch (e) {
    await fail(tabId, e);
    throw e;
  }
}

export async function record(tabId, overrides = {}) {
  assertIdle(tabId);
  const settings = await getSettings();
  const opts = { ...settings.capture, ...overrides };
  status.set(tabId, { startedAt: Date.now() });
  await startRecording(tabId, opts, { report: (st, d) => report(tabId, st, d) });
  report(tabId, 'recording', 'Recording — browse, then press Stop');
  badge(tabId, 'REC', '#c92a2a');
}

export async function stop(tabId) {
  const settings = await getSettings();
  const plugins = getPlugins(settings);
  badge(tabId, '…', '#1971c2');
  try {
    const reading = await stopRecording(tabId, { plugins, settings, report: (st, d) => report(tabId, st, d) });
    return await complete(tabId, reading, settings, plugins);
  } catch (e) {
    await fail(tabId, e);
    throw e;
  }
}

const handlers = {
  'harplus:capture': (m) => { assertIdle(m.tabId); capture(m.tabId, m.options).catch(() => {}); return { started: true }; },
  'harplus:record-start': async (m) => { await record(m.tabId, m.options); return { recording: true }; },
  'harplus:record-stop': (m) => { stop(m.tabId).catch(() => {}); return { stopping: true }; },
  'harplus:status': (m) => ({ busy: isBusy(m.tabId), recording: isRecording(m.tabId), status: status.get(m.tabId) || null }),
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve().then(() => h(msg)).then(reply, (e) => reply({ error: e.message }));
  return true;
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'take-reading' && tab?.id != null) capture(tab.id).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => { status.delete(tabId); discard(tabId); });

// Handy from the service-worker console: harplus.capture(tabId, { device: 'mobile' })
globalThis.harplus = { capture, record, stop, status };
