import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarRecorder } from '../extension/core/recorder.js';

const W = 1_760_000_000;
const req = (rec, id, type, ts, url = `https://x.test/${id}`) => rec.handle('Network.requestWillBeSent', {
  requestId: id, loaderId: 'L', frameId: 'F', type, timestamp: ts, wallTime: W + ts, request: { url, method: 'GET', headers: {} },
});

test('WebSocket, EventSource and Media never count', () => {
  const rec = new HarRecorder();
  req(rec, '1', 'WebSocket', 1); req(rec, '2', 'EventSource', 1); req(rec, '3', 'Media', 1); req(rec, '4', 'Script', 1);
  assert.equal(rec.busy(Date.now(), null), 1);
});

test('a request open > 5 s after load stops counting; before load it still counts', () => {
  const rec = new HarRecorder();
  const r = req(rec, '1', 'XHR', 1);
  const now = Date.now();
  r.startedAt = now - 6000;
  assert.equal(rec.counts(r, now, now - 1000), false, 'long-lived after load');
  assert.equal(rec.counts(r, now, null), true, 'no load yet');
  assert.equal(rec.counts(r, now, now + 1), true, 'load not reached at now');
  r.startedAt = now - 1000;
  assert.equal(rec.counts(r, now, now - 500), true, 'young request');
});

test('data on a non-counting request does not move lastBusyActivity; lastActivity still moves', () => {
  const rec = new HarRecorder();
  req(rec, 'ws', 'EventSource', 1);
  const before = rec.lastBusyActivity;
  const t0 = rec.lastActivity;
  const later = Date.now() + 50;
  while (Date.now() < later) { /* let the clock move */ }
  rec.handle('Network.dataReceived', { requestId: 'ws', dataLength: 10 });
  assert.equal(rec.lastBusyActivity, before);
  assert.ok(rec.lastActivity > t0);
  req(rec, 's', 'Script', 2);
  assert.ok(rec.lastBusyActivity > before, 'a counting request moves it');
});

test('busy drops when the request finishes', () => {
  const rec = new HarRecorder();
  req(rec, '1', 'Script', 1);
  assert.equal(rec.busy(Date.now(), null), 1);
  rec.handle('Network.loadingFinished', { requestId: '1', timestamp: 2 });
  assert.equal(rec.busy(Date.now(), null), 0);
});
