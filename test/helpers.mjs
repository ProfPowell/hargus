import assert from 'node:assert/strict';
// Shared test helpers: synthetic CDP traffic and a routing fetch mock.
export const W = 1_760_000_000; // wall-clock seconds
const timing = (requestTime) => ({
  requestTime, proxyStart: -1, proxyEnd: -1, dnsStart: 1, dnsEnd: 11, connectStart: 11, connectEnd: 51,
  sslStart: 21, sslEnd: 51, sendStart: 52, sendEnd: 53, receiveHeadersEnd: 153,
});

export function feedNavigation(rec) {
  rec.mainFrameId = 'F';
  const ev = (m, p, s) => rec.handle(m, p, s);
  // http → https redirect, then the document
  ev('Network.requestWillBeSent', { requestId: 'L1', loaderId: 'L1', frameId: 'F', type: 'Document', timestamp: 100, wallTime: W,
    request: { url: 'http://www.example.com/', method: 'GET', headers: { 'User-Agent': 'x' } } });
  ev('Network.requestWillBeSentExtraInfo', { requestId: 'L1', headers: { cookie: 'a=1; b=2', 'user-agent': 'x' } });
  ev('Network.responseReceivedExtraInfo', { requestId: 'L1', headers: { location: 'https://www.example.com/' }, headersText: 'HTTP/1.1 301\r\nlocation: https://www.example.com/\r\n\r\n' });
  ev('Network.requestWillBeSent', { requestId: 'L1', loaderId: 'L1', frameId: 'F', type: 'Document', timestamp: 100.2, wallTime: W + 0.2,
    request: { url: 'https://www.example.com/', method: 'GET', headers: {} },
    redirectResponse: { url: 'http://www.example.com/', status: 301, statusText: 'Moved', headers: { Location: 'https://www.example.com/' }, mimeType: 'text/html', remoteIPAddress: '93.184.215.14', protocol: 'http/1.1', encodedDataLength: 120 } });
  ev('Network.responseReceivedExtraInfo', { requestId: 'L1', headers: { 'content-type': 'text/html', 'set-cookie': 'sid=abc; Path=/; Secure; HttpOnly; SameSite=Lax\ntrk=1; Path=/', 'strict-transport-security': 'max-age=31536000' } });
  ev('Network.responseReceived', { requestId: 'L1', type: 'Document', timestamp: 100.4, response: {
    url: 'https://www.example.com/', status: 200, statusText: '', headers: { 'content-type': 'text/html' }, mimeType: 'text/html',
    remoteIPAddress: '93.184.215.14', remotePort: 443, protocol: 'h2', connectionId: 7, timing: timing(100.2),
    securityDetails: { protocol: 'TLS 1.3', keyExchange: '', keyExchangeGroup: 'X25519', cipher: 'AES_128_GCM', subjectName: 'www.example.com', sanList: ['www.example.com', 'example.com'], issuer: 'R11', validFrom: W - 86400 * 30, validTo: W + 86400 * 60, signedCertificateTimestampList: [{}, {}], certificateTransparencyCompliance: 'compliant' } } });
  ev('Network.dataReceived', { requestId: 'L1', dataLength: 5000, encodedDataLength: 1500 });
  ev('Network.loadingFinished', { requestId: 'L1', timestamp: 100.5, encodedDataLength: 1800 });
  ev('Page.domContentEventFired', { timestamp: 100.8 });
  // a third-party script
  ev('Network.requestWillBeSent', { requestId: 'R2', loaderId: 'L1', frameId: 'F', type: 'Script', timestamp: 100.6, wallTime: W + 0.6,
    request: { url: 'https://www.googletagmanager.com/gtm.js?id=GTM-1', method: 'GET', headers: {} } });
  ev('Network.responseReceived', { requestId: 'R2', type: 'Script', timestamp: 100.7, response: {
    url: 'https://www.googletagmanager.com/gtm.js?id=GTM-1', status: 200, headers: { 'content-type': 'application/javascript', 'content-encoding': 'br' },
    mimeType: 'application/javascript', remoteIPAddress: '142.250.1.1', protocol: 'h3', timing: timing(100.6) } });
  ev('Network.dataReceived', { requestId: 'R2', dataLength: 90000, encodedDataLength: 30000 });
  ev('Network.loadingFinished', { requestId: 'R2', timestamp: 100.9, encodedDataLength: 30200 });
  ev('Page.loadEventFired', { timestamp: 101.2 });
}


/** fetch() mock: routes = [[RegExp, (url, init) => ({ status?, headers?, body })], …]; unmatched → HTML 404. */
export function mockFetch(routes, log = []) {
  return async (url, init = {}) => {
    const u = String(url);
    log.push(u);
    for (const [re, handler] of routes) {
      if (!re.test(u)) continue;
      const out = typeof handler === 'function' ? await handler(u, init) : handler;
      const body = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
      return new Response(body, { status: out.status || 200, headers: out.headers || { 'content-type': 'application/json' } });
    }
    return new Response('<!doctype html><title>Not found</title>', { status: 404, headers: { 'content-type': 'text/html' } });
  };
}

/** Every non-info finding has a slug rule id (`[a-z0-9-]+`) and no two share plugin + id + subject. `plugin` labels the failure. */
export function assertRuleIds(findings, plugin = '') {
  const seen = new Set();
  for (const f of findings) {
    if (f.severity === 'info' && !f.id) continue;
    assert.match(String(f.id), /^[a-z0-9-]+$/, `${plugin} no valid rule id: ${f.title}`);
    const key = `${plugin}/${f.id}/${f.subject || ''}`;
    assert.ok(!seen.has(key), `${plugin} duplicate rule id/subject: ${key}`);
    seen.add(key);
  }
}
