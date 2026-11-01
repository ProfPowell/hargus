import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseUrlList, newSet, setFromReadings, startRound, updateSite, endRound, addToSet, roundState, SETTINGS_KEYS,
} from '../extension/core/sets.js';

const settings = { device: 'desktop', throttle: 'none', bypassCache: false, runs: 1, coverage: false };
const reading = (id, url, finalUrl, capture = {}) => ({ log: { _harplus: { id, target: { url, finalUrl }, capture } } });

test('parseUrlList: bare hosts, junk and duplicates', () => {
  const r = parseUrlList('ucsd.edu\nhttps://UCSD.edu/\nftp://x\n\nhttps://a.com/p');
  assert.deepEqual(r.urls, ['https://ucsd.edu/', 'https://a.com/p']);
  assert.deepEqual(r.bad, ['ftp://x']);
});

test('parseUrlList: 9 URLs keep 8', () => {
  const text = Array.from({ length: 9 }, (_, i) => `https://s${i}.com/`).join('\n');
  const r = parseUrlList(text);
  assert.equal(r.urls.length, 8);
  assert.deepEqual(r.bad, ['https://s8.com/ (more than 8)']);
});

test('newSet: id, empty rounds', () => {
  const s = newSet({ name: 'A', urls: ['https://a.com/'], settings }, 5);
  assert.equal(s.createdAt, 5);
  assert.deepEqual(s.rounds, []);
  assert.ok(s.id);
});

test('setFromReadings: one done round, settings from first capture', () => {
  const s = setFromReadings('X', [
    reading('r1', 'https://a.com/', 'https://www.a.com/', { device: 'mobile', throttle: '4g', bypassCache: true, runs: 3, coverage: 1, extra: 1 }),
    reading('r2', 'https://b.com/', undefined),
  ], 9);
  assert.deepEqual(s.urls, ['https://www.a.com/', 'https://b.com/']);
  assert.deepEqual(s.settings, { device: 'mobile', throttle: '4g', bypassCache: true, runs: 3, coverage: true });
  assert.deepEqual(s.rounds, [{ at: 9, state: 'done', readings: [
    { url: 'https://www.a.com/', id: 'r1', error: null, state: 'done' },
    { url: 'https://b.com/', id: 'r2', error: null, state: 'done' }] }]);
});

test('startRound/updateSite/endRound', () => {
  const s0 = newSet({ name: 'A', urls: ['https://a.com/', 'https://b.com/'], settings }, 1);
  const s1 = startRound(s0, 2);
  assert.equal(s0.rounds.length, 0);
  assert.equal(s1.rounds[0].state, 'running');
  assert.deepEqual(s1.rounds[0].readings.map((r) => r.state), ['waiting', 'waiting']);
  let s = s1;
  for (const st of ['recording', 'analysing']) {
    s = updateSite(s, 0, 'https://a.com/', { state: st });
    assert.equal(s.rounds[0].readings[0].state, st);
  }
  s = updateSite(s, 0, 'https://a.com/', { state: 'done', id: 'r1' });
  s = updateSite(s, 0, 'https://b.com/', { state: 'failed', error: 'timeout' });
  assert.deepEqual(s.rounds[0].readings[0], { url: 'https://a.com/', id: 'r1', error: null, state: 'done' });
  assert.equal(s.rounds[0].readings[1].error, 'timeout');
  assert.equal(s1.rounds[0].readings[0].state, 'waiting');
  assert.equal(endRound(s, 0, 'done').rounds[0].state, 'done');
  assert.equal(endRound(s, 0, 'stopped').rounds[0].state, 'stopped');
});

test("addToSet: replaces the URL's reading in the latest round", () => {
  const s = setFromReadings('X', [reading('r1', 'https://a.com/')], 1);
  const t = addToSet(s, reading('r9', 'https://a.com/', undefined, { device: 'mobile' }));
  assert.equal(t.rounds[0].readings.length, 1);
  assert.equal(t.rounds[0].readings[0].id, 'r9');
  assert.deepEqual(t.urls, s.urls);
  assert.deepEqual(t.settings, s.settings);
  assert.equal(s.rounds[0].readings[0].id, 'r1');
});

test('addToSet: a new URL is appended to urls and the round', () => {
  const s = setFromReadings('X', [reading('r1', 'https://a.com/')], 1);
  const t = addToSet(s, reading('r2', 'https://b.com/'));
  assert.deepEqual(t.urls, ['https://a.com/', 'https://b.com/']);
  assert.equal(t.rounds[0].readings[1].id, 'r2');
  assert.deepEqual(t.settings, s.settings);
});

test('addToSet: a set with no rounds gets a first round', () => {
  const s = newSet({ name: 'A', urls: [], settings }, 1);
  const t = addToSet(s, reading('r1', 'https://a.com/'), 7);
  assert.equal(t.rounds.length, 1);
  assert.equal(t.rounds[0].state, 'done');
  assert.equal(t.rounds[0].readings[0].id, 'r1');
  assert.deepEqual(t.urls, ['https://a.com/']);
});

test('a stale running round reads as incomplete', () => {
  assert.equal(roundState({ state: 'running' }, { alive: false }), 'incomplete');
  assert.equal(roundState({ state: 'running' }, { alive: true }), 'running');
  assert.equal(roundState({ state: 'done' }, { alive: false }), 'done');
  assert.equal(roundState({ state: 'stopped' }, { alive: false }), 'stopped');
});

test('SETTINGS_KEYS', () => {
  assert.deepEqual(SETTINGS_KEYS, ['device', 'throttle', 'bypassCache', 'runs', 'coverage']);
});

test('the store opens version 3 with a sets store', async () => {
  const src = readFileSync(new URL('../extension/browser/store.js', import.meta.url), 'utf8');
  let version;
  try { ({ VERSION: version } = await import('../extension/browser/store.js')); } catch { /* browser-only imports */ }
  version ??= Number(/export const VERSION = (\d+);/.exec(src)?.[1]);
  assert.equal(version, 3);
  assert.match(src, /objectStoreNames\.contains\('sets'\)\) d\.createObjectStore\('sets', \{ keyPath: 'id' \}\)/);
});
