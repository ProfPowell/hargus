import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetKind, ASSET_KINDS } from '../extension/core/broken.js';
import { isThirdParty, mainEntry } from '../extension/core/har-util.js';
import network from '../extension/plugins/network.js';

const entry = (url, status, type, extra = {}) => ({
  startedDateTime: '2026-01-01T00:00:00Z', time: 10,
  request: { method: 'GET', url, headers: [] },
  response: { status, httpVersion: 'h2', headers: [], content: { size: 0, mimeType: '' } },
  _resourceType: type, ...extra,
});
const reading = (entries) => ({
  log: { pages: [], entries, _harplus: { target: { finalUrl: 'https://example.com/' } } },
});
const ctx = { target: { site: 'example.com' }, util: { isThirdParty }, skip: (m) => { throw new Error(m); } };

test('ASSET_KINDS lists the kinds that can be broken', () => {
  assert.deepEqual(ASSET_KINDS, ['image', 'script', 'stylesheet', 'font', 'media', 'frame']);
});

test('assetKind gives the kind of each asset entry', () => {
  const main = mainEntry(reading([entry('https://example.com/', 200, 'document')]));
  for (const k of ['image', 'script', 'stylesheet', 'font', 'media']) {
    assert.equal(assetKind(entry(`https://example.com/x.${k}`, 404, k), main), k);
  }
});

test('assetKind: sub-frame documents are frames; main document, xhr and fetch are not assets', () => {
  const main = entry('https://example.com/', 200, 'document');
  assert.equal(assetKind(entry('https://example.com/frame.html', 404, 'document'), main), 'frame');
  assert.equal(assetKind(entry('https://example.com/frame.html', 404, 'iframe'), main), 'frame');
  assert.equal(assetKind(main, main), null);
  assert.equal(assetKind(entry('https://example.com/api', 500, 'xhr'), main), null);
  assert.equal(assetKind(entry('https://example.com/api', 500, 'fetch'), main), null);
  assert.equal(assetKind(entry('https://example.com/ping', 500, 'ping'), main), null);
});

test('assetKind: a redirect hop before the main document is not a frame', () => {
  const hop = entry('http://example.com/', 301, 'document');
  const main = entry('https://example.com/', 200, 'document');
  assert.equal(assetKind(hop, main), null);
});

test('Network splits asset errors from other request errors', () => {
  const r = reading([
    entry('https://example.com/', 200, 'document'),
    entry('https://example.com/a.png', 404, 'image'),
    entry('https://example.com/api', 500, 'xhr'),
    entry('https://example.com/f.woff2', 404, 'font'),
  ]);
  const { findings } = network.run(r, ctx);
  const a = findings.find((f) => f.id === 'asset-errors');
  const o = findings.find((f) => f.id === 'request-errors');
  assert.equal(a.title, '2 asset requests returned HTTP errors');
  assert.equal(o.title, '1 other request returned HTTP errors');
  for (const f of [a, o]) { assert.equal(f.severity, 'medium'); assert.equal(f.category, 'quality'); }
  assert.equal(a.evidence, '404 https://example.com/a.png\n404 https://example.com/f.woff2');
  assert.equal(o.evidence, '500 https://example.com/api');
});

test('Network emits each error finding only when non-empty', () => {
  const ids = (e) => network.run(reading([entry('https://example.com/', 200, 'document'), e]), ctx).findings.map((f) => f.id).filter(Boolean);
  assert.deepEqual(ids(entry('https://example.com/a.png', 404, 'image')), ['asset-errors']);
  assert.deepEqual(ids(entry('https://example.com/api', 500, 'xhr')), ['request-errors']);
});
