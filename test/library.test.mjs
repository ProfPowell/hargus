import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardHtml, setCardHtml } from '../extension/ui/library-card.js';

const base = { id: 'a1', title: 'Example', host: 'example.com', capturedAt: 0, entries: 3, bytes: 100, mode: 'load' };

test('library card: severity chips carry a glyph and an sr word; ring has its grade word', () => {
  const out = String(cardHtml({ ...base, score: 78, status: 'warning', counts: { high: 6, medium: 2, low: 0 } }));
  assert.match(out, /data-sev="high"[^>]*><span class="sev-ico" aria-hidden="true"><\/span><span class="sr-only">6 high<\/span><\/span>\s*<span aria-hidden="true">6<\/span>/);
  assert.match(out, /<span class="sr-only">2 medium<\/span>/);
  assert.doesNotMatch(out, /data-sev="low"/);
  assert.doesNotMatch(out, /sev-high/);
  assert.match(out, /C\+ · needs work/);
});

test('library card: no scores gives no ring, grade word or chips', () => {
  const out = String(cardHtml(base));
  assert.doesNotMatch(out, /card-score|card-grade|class="chips"|data-sev/);
});

test('library card: ×N after the mode when the reading had several runs', () => {
  assert.match(String(cardHtml({ ...base, runs: 3 })), /load · ×3/);
  assert.doesNotMatch(String(cardHtml({ ...base, runs: 1 })), /×/);
  assert.doesNotMatch(String(cardHtml(base)), /×/);
});

test('card: checkbox, and record-mode checkbox disabled with the copy', () => {
  assert.doesNotMatch(String(cardHtml(base)), /type="checkbox"/);
  const on = String(cardHtml(base, { selectable: true, sets: [] }));
  assert.match(on, /<input type="checkbox"[^>]*data-select="a1"/);
  assert.doesNotMatch(on, /disabled/);
  const rec = String(cardHtml({ ...base, mode: 'record' }, { selectable: true, sets: [] }));
  assert.match(rec, /data-select="a1"[^>]*disabled|disabled[^>]*data-select="a1"/);
  assert.match(rec, /Recordings of several pages can(&#39;|')t be compared yet/);
});

test('card: set chips link to compare.html?set=', () => {
  const sets = [{ id: 's1', name: 'Q<4', rounds: [{ readings: [{ id: 'a1' }] }] }, { id: 's2', name: 'Other', rounds: [{ readings: [{ id: 'zz' }] }] }];
  const out = String(cardHtml(base, { selectable: true, sets }));
  assert.match(out, /href="compare\.html\?set=s1"/);
  assert.match(out, /Q&lt;4/);
  assert.doesNotMatch(out, /compare\.html\?set=s2/);
  assert.match(out, /data-add-menu="a1"/);
});

test('setCardHtml: name, rounds, last date, buttons, escaped name', () => {
  const set = { id: 's1', name: '<b>Peers</b>', urls: ['https://a.com/', 'https://b.org/'], rounds: [{ at: 0 }, { at: Date.UTC(2026, 9, 31) }] };
  const out = String(setCardHtml(set));
  assert.doesNotMatch(out, /<b>Peers/);
  assert.match(out, /&lt;b&gt;Peers/);
  assert.match(out, /2 rounds/);
  assert.ok(out.includes(new Date(Date.UTC(2026, 9, 31)).toLocaleDateString()));
  assert.match(out, /href="compare\.html\?set=s1"[^>]*>Compare/);
  assert.match(out, /data-record="s1"[^>]*>Record again/);
  assert.match(out, /data-delete-set="s1"[^>]*>Delete/);
  assert.match(out, />A</);
  assert.match(String(setCardHtml({ ...set, rounds: [] })), /no rounds yet/);
  assert.match(String(setCardHtml({ ...set, rounds: [{ at: 1 }] })), /1 round[^s]/);
});

test('setCardHtml: the recording set shows its progress line; others leave it empty', () => {
  const round = { at: 1, state: 'running', readings: [
    { url: 'https://a.com/', state: 'done', id: 'r1' }, { url: 'https://b.org/', state: 'analysing', id: 'r2' }, { url: 'https://c.net/', state: 'waiting' }] };
  const set = { id: 's1', name: 'Peers', urls: ['https://a.com/', 'https://b.org/', 'https://c.net/'], rounds: [round] };
  assert.match(String(setCardHtml(set, { running: true })), /data-progress="s1"[^>]*>Recording · site 2 of 3: b\.org, analysing</);
  assert.match(String(setCardHtml(set, { running: false })), /data-progress="s1"[^>]*><\/div>/);
  assert.match(String(setCardHtml(set)), /data-progress="s1"[^>]*><\/div>/);
  const between = { ...set, rounds: [{ ...round, readings: [{ url: 'https://a.com/', state: 'done' }, { url: 'https://b.org/', state: 'waiting' }] }] };
  assert.match(String(setCardHtml(between, { running: true })), /Recording · 1 of 2 sites finished/);
});
