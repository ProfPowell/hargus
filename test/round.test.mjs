import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRound, deadlineFor, SITE_DEADLINE_MS } from '../extension/core/round.js';
import { newSet, roundState } from '../extension/core/sets.js';

const settings = { device: 'desktop', throttle: 'none', bypassCache: false, runs: 1, coverage: false };
const makeSet = (urls) => newSet({ name: 'unis', urls, settings }, 1000);

/** Fake deps; `over` replaces any of them. `log` records calls in order. */
function fakeDeps(over = {}) {
  const log = [];
  const saved = [];
  let n = 0;
  const deps = {
    log, saved,
    workingTab: 7,
    save: async (s) => { saved.push(structuredClone(s)); },
    openTab: async (url) => { log.push(['openTab', url]); return 100 + n++; },
    closeTab: async (id) => { log.push(['closeTab', id]); },
    navigate: async (tabId, url) => { log.push(['navigate', tabId, url]); },
    capture: async (tabId, s) => { log.push(['capture', tabId, s.mode]); return `r${log.filter((x) => x[0] === 'capture').length}`; },
    analysisDone: async (id) => { log.push(['analysisDone', id]); return 'done'; },
    abandon: async (tabId) => { log.push(['abandon', tabId]); },
    busy: () => false,
    deadlineMs: () => 10_000,
    stopped: () => false,
    now: () => 5000,
    ...over,
  };
  return deps;
}

const last = (set) => set.rounds[set.rounds.length - 1];

test('deadline: 300 s per run, 1 run by default', () => {
  assert.equal(SITE_DEADLINE_MS, 300_000);
  assert.equal(deadlineFor({ runs: 3 }), 900_000);
  assert.equal(deadlineFor({}), 300_000);
});

test('sites run in order, one at a time', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const deps = fakeDeps({
    analysisDone: async (id) => { deps.log.push(['analysisDone', id]); if (id === 'r1') await gate; deps.log.push(['analysed', id]); return 'done'; },
  });
  const run = runRound(makeSet(['https://a.com/', 'https://b.com/']), deps);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(deps.log.filter((x) => x[0] === 'capture').length, 1, 'second capture waits for the first analysis');
  release();
  const set = await run;
  const order = deps.log.map((x) => x.join(' '));
  assert.ok(order.indexOf('analysed r1') < order.indexOf('navigate 7 https://b.com/'));
  assert.deepEqual(deps.log.filter((x) => x[0] === 'navigate').map((x) => x[2]), ['https://a.com/', 'https://b.com/']);
  assert.deepEqual(deps.log.filter((x) => x[0] === 'capture').map((x) => x[2]), ['reload', 'reload']);
  assert.equal(last(set).state, 'done');
  assert.deepEqual(last(set).readings.map((e) => [e.state, e.id, e.error]), [['done', 'r1', null], ['done', 'r2', null]]);
  assert.equal(last(set).at, 5000);
});

test('a failed capture is recorded and the round moves on', async () => {
  let calls = 0;
  const deps = fakeDeps({ capture: async () => { calls++; if (calls === 1) throw new Error('boom'); return 'rb'; } });
  const set = await runRound(makeSet(['https://a.com/', 'https://b.com/']), deps);
  const [a, b] = last(set).readings;
  assert.equal(a.state, 'failed');
  assert.equal(a.error, 'boom');
  assert.equal(b.state, 'done');
  assert.equal(b.id, 'rb');
  assert.equal(last(set).state, 'done');
});

test('a deadline marks the site failed with "timed out"', async () => {
  let calls = 0;
  const deps = fakeDeps({
    deadlineMs: () => 15,
    capture: (tabId) => { calls++; deps.log.push(['capture', tabId]); return calls === 1 ? new Promise(() => {}) : Promise.resolve('rb'); },
  });
  const set = await runRound(makeSet(['https://a.com/', 'https://b.com/']), deps);
  const [a, b] = last(set).readings;
  assert.equal(a.state, 'failed');
  assert.equal(a.error, 'timed out');
  assert.equal(b.state, 'done');
  assert.ok(deps.log.some((x) => x[0] === 'abandon' && x[1] === 7), 'the timed-out site is abandoned');
});

test('a timeout from the analysis wait also reads as timed out', async () => {
  const deps = fakeDeps({ analysisDone: async () => 'timeout' });
  const set = await runRound(makeSet(['https://a.com/']), deps);
  assert.deepEqual([last(set).readings[0].state, last(set).readings[0].error], ['failed', 'timed out']);
});

test('a capture still running after its deadline gets a fresh working tab', async () => {
  let calls = 0;
  const deps = fakeDeps({
    deadlineMs: () => 15,
    busy: (id) => id === 7,
    capture: (tabId) => { calls++; deps.log.push(['capture', tabId]); return calls === 1 ? new Promise(() => {}) : Promise.resolve('rb'); },
  });
  await runRound(makeSet(['https://a.com/', 'https://b.com/']), deps);
  const caps = deps.log.filter((x) => x[0] === 'capture').map((x) => x[1]);
  assert.deepEqual(caps, [7, 100]);
  assert.ok(deps.log.some((x) => x[0] === 'openTab'));
  assert.ok(deps.log.some((x) => x[0] === 'closeTab' && x[1] === 7));
});

test('a late finish after the deadline does not overwrite the failure', async () => {
  let finish;
  const deps = fakeDeps({
    deadlineMs: () => 15,
    capture: () => new Promise((r) => { finish = r; }),
  });
  const set = await runRound(makeSet(['https://a.com/']), deps);
  const count = deps.saved.length;
  finish('late');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(deps.saved.length, count, 'nothing saved after the round ended');
  assert.equal(last(deps.saved.at(-1)).readings[0].error, 'timed out');
  assert.equal(last(set).readings[0].state, 'failed');
});

test('a deadline while loading never starts that capture', async () => {
  let loaded;
  const deps = fakeDeps({
    deadlineMs: () => 15,
    navigate: (tabId, url) => (url === 'https://a.com/' ? new Promise((r) => { loaded = r; }) : Promise.resolve()),
  });
  await runRound(makeSet(['https://a.com/', 'https://b.com/']), deps);
  loaded();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(deps.log.filter((x) => x[0] === 'capture').length, 1, 'only the second site was captured');
});

test('a capture that saves no reading fails the site', async () => {
  const deps = fakeDeps({ capture: async () => undefined });
  const set = await runRound(makeSet(['https://a.com/']), deps);
  assert.deepEqual([last(set).readings[0].state, last(set).readings[0].error], ['failed', 'no reading was saved']);
});

test('an analysis error keeps the reading as done', async () => {
  const deps = fakeDeps({ analysisDone: async () => 'error' });
  const set = await runRound(makeSet(['https://a.com/']), deps);
  assert.deepEqual([last(set).readings[0].state, last(set).readings[0].id], ['done', 'r1']);
});

test('the analysis wait starts before the analysing state is saved', async () => {
  const order = [];
  const deps = fakeDeps({
    save: async (s) => { order.push(`save ${last(s).readings[0].state}`); },
    analysisDone: async () => { order.push('wait'); return 'done'; },
  });
  await runRound(makeSet(['https://a.com/']), deps);
  assert.ok(order.indexOf('wait') < order.indexOf('save analysing'));
});

test('stop ends the round as stopped and keeps finished sites', async () => {
  let stop = false;
  const deps = fakeDeps({
    stopped: () => stop,
    analysisDone: async () => { stop = true; return 'done'; }, // stop pressed while the first site analyses
  });
  const set = await runRound(makeSet(['https://a.com/', 'https://b.com/', 'https://c.com/']), deps);
  assert.equal(last(set).state, 'stopped');
  assert.deepEqual(last(set).readings.map((e) => e.state), ['done', 'waiting', 'waiting']);
  assert.equal(deps.log.filter((x) => x[0] === 'capture').length, 1);
  assert.equal(last(deps.saved.at(-1)).state, 'stopped');
});

test('a site that fails because the round was stopped says so', async () => {
  let stop = false;
  const deps = fakeDeps({
    stopped: () => stop,
    navigate: async () => { stop = true; throw new Error('No tab with id: 7'); }, // the window was closed
  });
  const set = await runRound(makeSet(['https://a.com/', 'https://b.com/']), deps);
  assert.equal(last(set).state, 'stopped');
  assert.deepEqual(last(set).readings.map((e) => [e.state, e.error]), [['failed', 'stopped'], ['waiting', null]]);
});

test('an analysis wait settled as stopped (the window closed) fails the site as stopped, not done', async () => {
  let stop = false;
  const deps = fakeDeps({
    stopped: () => stop,
    analysisDone: async () => { stop = true; return 'stopped'; },
  });
  const set = await runRound(makeSet(['https://a.com/', 'https://b.com/']), deps);
  assert.equal(last(set).state, 'stopped');
  assert.deepEqual(last(set).readings.map((e) => [e.state, e.error]), [['failed', 'stopped'], ['waiting', null]]);
});

test('a set deleted mid-round stops the round and is not saved again', async () => {
  let gone = false;
  const deps = fakeDeps({
    gone: async () => gone,
    analysisDone: async () => { gone = true; return 'done'; },
  });
  await runRound(makeSet(['https://a.com/', 'https://b.com/']), deps);
  assert.equal(deps.log.filter((x) => x[0] === 'capture').length, 1, 'the second site is never recorded');
  assert.ok(deps.saved.every((s) => last(s).readings[0].state !== 'done'), 'nothing saved once the set was gone');
});

test('every state change is saved', async () => {
  const deps = fakeDeps();
  const urls = ['https://a.com/', 'https://b.com/', 'https://c.com/'];
  const set = await runRound(makeSet(urls), deps);
  assert.ok(deps.saved.length >= 3 * urls.length + 2, `saved ${deps.saved.length} times`);
  assert.equal(deps.saved[0].rounds.length, 1);
  assert.equal(last(deps.saved[0]).state, 'running');
  assert.deepEqual(deps.saved.at(-1), set);
});

test('the round keeps prior rounds and uses the set settings with reload', async () => {
  const seen = [];
  const prior = { ...makeSet(['https://a.com/']), rounds: [{ at: 1, state: 'done', readings: [] }] };
  const deps = fakeDeps({ capture: async (tabId, s) => { seen.push(s); return 'r'; } });
  const set = await runRound({ ...prior, settings: { ...settings, runs: 3 } }, deps);
  assert.equal(set.rounds.length, 2);
  assert.deepEqual(seen[0], { ...settings, runs: 3, mode: 'reload' });
});

test('the working tab is opened when none is given', async () => {
  const deps = fakeDeps({ workingTab: undefined });
  await runRound(makeSet(['https://a.com/']), deps);
  assert.deepEqual(deps.log[0], ['openTab', 'about:blank']);
  assert.equal(deps.log.find((x) => x[0] === 'capture')[1], 100);
});

test('a stale running round reads as incomplete', async () => {
  let stored;
  const deps = fakeDeps({
    save: async (s) => { stored = structuredClone(s); },
    analysisDone: () => new Promise(() => {}), // the worker dies while the first site analyses
    deadlineMs: () => 30,
  });
  const run = runRound(makeSet(['https://a.com/', 'https://b.com/']), deps);
  await new Promise((r) => setTimeout(r, 5));
  const mid = last(stored);
  assert.equal(mid.state, 'running');
  assert.equal(mid.readings[0].state, 'analysing');
  assert.equal(roundState(mid, { alive: false }), 'incomplete');
  assert.equal(roundState(mid, { alive: true }), 'running');
  await run;
});
