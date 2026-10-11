import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectInterstitial } from '../extension/core/interstitial.js';

const doc = (url, status = 200, headers = {}) => ({
  request: { url, method: 'GET' }, _resourceType: 'document',
  response: { status, headers: Object.entries(headers).map(([name, value]) => ({ name, value })), content: { mimeType: 'text/html' } },
});
const sub = (url) => ({ request: { url, method: 'GET' }, _resourceType: 'script', response: { status: 200, headers: [], content: { mimeType: 'text/javascript' } } });
const reading = ({ url = 'https://shop.test/', status = 200, headers = {}, more = [], title = 'Shop', words = 2000, content = true } = {}) => ({
  log: {
    entries: [doc(url, status, headers), ...more.map(sub)],
    _harplus: {
      target: { url, finalUrl: url, title },
      plugins: content ? { content: { status: 'ok', data: { reading: { words } } } } : {},
    },
  },
});

test('Akamai failover page (Patagonia shape) → Akamai, from the request URL', () => {
  const r = detectInterstitial(reading({ title: 'Hang Tight! Routing to checkout...', words: 210, headers: { server: 'AkamaiNetStorage' }, more: ['https://shop.test/home/botfailoveroriginal_files/spin.min.js'] }));
  assert.equal(r.vendor, 'Akamai');
  assert.match(r.reason, /^a request to …\/home\/botfailoveroriginal_files\//);
});

test('cf-mitigated: challenge → Cloudflare, whatever the length', () => {
  assert.equal(detectInterstitial(reading({ status: 403, headers: { 'cf-mitigated': 'challenge' }, words: 5000 })).vendor, 'Cloudflare');
});

test('DataDome: x-datadome with 403, or captcha-delivery request', () => {
  assert.equal(detectInterstitial(reading({ status: 403, headers: { 'x-datadome': 'protected' } })).vendor, 'DataDome');
  assert.equal(detectInterstitial(reading({ more: ['https://geo.captcha-delivery.com/captcha/?x=1'] })).vendor, 'DataDome');
  assert.equal(detectInterstitial(reading({ headers: { 'x-datadome': 'protected' } })), null, '200 with the header is a normal protected page');
});

test('title + thin page → detected; same title on a long page → null', () => {
  const r = detectInterstitial(reading({ title: 'Just a moment...', words: 40, headers: { server: 'cloudflare' } }));
  assert.deepEqual(r, { vendor: 'Cloudflare', reason: 'the title “Just a moment...”' });
  assert.equal(detectInterstitial(reading({ title: 'Just a moment...', words: 2000 })), null);
});

test('error status + thin page → detected; error status on a full page → null', () => {
  assert.deepEqual(detectInterstitial(reading({ status: 403, words: 50 })), { vendor: 'unknown', reason: 'a 403 response with only 50 words' });
  assert.equal(detectInterstitial(reading({ status: 403, words: 1000 })), null);
});

test('vendor scripts on normal protected pages are hints only (Review Focus 2)', () => {
  const more = [
    'https://challenges.cloudflare.com/turnstile/v0/api.js', 'https://shop.test/cdn-cgi/challenge-platform/h/b/scripts/x.js',
    'https://shop.test/_Incapsula_Resource?SWJIYLWA=abc', 'https://static.queue-it.net/script/queueclient.min.js',
    'https://client.perimeterx.net/PXabc/main.min.js',
  ];
  assert.equal(detectInterstitial(reading({ more, words: 2000 })), null);
  assert.equal(detectInterstitial(reading({ more: [more[2]], title: 'Request unsuccessful', words: 30 })).vendor, 'Imperva');
});

test('no content data, no log, empty reading → never throws (Review Focus 4)', () => {
  assert.equal(detectInterstitial(reading({ title: 'Just a moment...', content: false })), null);
  assert.equal(detectInterstitial(reading({ status: 403, content: false })), null);
  assert.equal(detectInterstitial({}), null);
  assert.equal(detectInterstitial(null), null);
  assert.equal(detectInterstitial({ log: { entries: [] } }), null);
});
