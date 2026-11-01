// Sets: named groups of URLs and their rounds of readings. Pure; every function returns new objects.
import { MAX_SITES } from './compare.js';

/** The capture settings a set remembers and "Record again" reuses. */
export const SETTINGS_KEYS = ['device', 'throttle', 'bypassCache', 'runs', 'coverage'];

function normalise(line) {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(line) ? line : `https://${line}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch { return null; }
}

/** Parse pasted lines into up to MAX_SITES normalised http(s) URLs; junk and overflow go to `bad`. */
export function parseUrlList(text) {
  const urls = [];
  const bad = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const url = normalise(line);
    if (!url) { bad.push(line); continue; }
    if (urls.includes(url)) continue;
    if (urls.length >= MAX_SITES) { bad.push(`${url} (more than ${MAX_SITES})`); continue; }
    urls.push(url);
  }
  return { urls, bad };
}

const pickSettings = (s = {}) => ({
  device: s.device, throttle: s.throttle, bypassCache: !!s.bypassCache, runs: s.runs ?? 1, coverage: !!s.coverage,
});

/** A new empty set. */
export function newSet({ name, urls, settings }, now = Date.now()) {
  return { id: crypto.randomUUID(), name, createdAt: now, urls: [...urls], settings: pickSettings(settings), rounds: [] };
}

const readingUrl = (reading) => {
  const t = reading.log?._harplus?.target ?? {};
  return t.finalUrl || t.url;
};
const doneEntry = (reading) => ({ url: readingUrl(reading), id: reading.log?._harplus?.id ?? null, error: null, state: 'done' });

/** A set with one finished round holding these readings; settings come from the first reading's capture. */
export function setFromReadings(name, readings, now = Date.now()) {
  const entries = readings.map(doneEntry);
  const capture = readings[0]?.log?._harplus?.capture ?? {};
  const set = newSet({ name, urls: entries.map((e) => e.url), settings: capture }, now);
  return { ...set, rounds: [{ at: now, state: 'done', readings: entries }] };
}

/** Append a running round with every URL waiting. */
export function startRound(set, now = Date.now()) {
  const round = {
    at: now, state: 'running',
    readings: set.urls.map((url) => ({ url, id: null, error: null, state: 'waiting' })),
  };
  return { ...set, rounds: [...set.rounds, round] };
}

const withRound = (set, i, fn) => ({ ...set, rounds: set.rounds.map((r, j) => (j === i ? fn(r) : r)) });

/** Patch one site's entry in a round. */
export function updateSite(set, roundIndex, url, patch) {
  return withRound(set, roundIndex, (r) => ({ ...r, readings: r.readings.map((e) => (e.url === url ? { ...e, ...patch } : e)) }));
}

/** Mark a round done or stopped. */
export function endRound(set, roundIndex, state) {
  return withRound(set, roundIndex, (r) => ({ ...r, state }));
}

/** Add a reading to the latest round: replace its URL's entry, or append the URL. Settings stay as they are. */
export function addToSet(set, reading, now = Date.now()) {
  const entry = doneEntry(reading);
  const urls = set.urls.includes(entry.url) ? [...set.urls] : [...set.urls, entry.url];
  if (!set.rounds.length) return { ...set, urls, rounds: [{ at: now, state: 'done', readings: [entry] }] };
  const last = set.rounds.length - 1;
  const rounds = withRound(set, last, (r) => ({
    ...r,
    readings: r.readings.some((e) => e.url === entry.url)
      ? r.readings.map((e) => (e.url === entry.url ? entry : e))
      : [...r.readings, entry],
  })).rounds;
  return { ...set, urls, rounds };
}

/** A round's state; one stored as running reads as incomplete when nothing is recording it. */
export function roundState(round, { alive }) {
  return round.state === 'running' && !alive ? 'incomplete' : round.state;
}
