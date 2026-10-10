// Environment-neutral helpers for HAR / HAR-PLUS data.
// Used by the extension, the viewer, plugins and the Node CLI — no browser or chrome.* APIs here.

export const SEVERITIES = ['high', 'medium', 'low', 'info'];
export const SEVERITY_RANK = { high: 0, medium: 1, low: 2, info: 3 };
export const CATEGORIES = [
  'security', 'performance', 'accessibility', 'seo', 'privacy', 'quality', 'infrastructure', 'intel',
];

/* ------------------------------------------------------------------ hosts */

// Second-level public suffixes under ccTLDs. Not the full Public Suffix List,
// but covers the registries people actually run into. Swap in the PSL if you need precision.
const CC_SLDS = {
  uk: 'co org me ltd plc net ac gov nhs sch police',
  au: 'com net org edu gov asn id',
  nz: 'co org net ac govt geek school',
  jp: 'co ne or ac go ad ed gr lg',
  kr: 'co or ne ac go re',
  cn: 'com net org gov edu ac',
  hk: 'com org net edu gov',
  tw: 'com org net edu gov',
  sg: 'com org net edu gov',
  my: 'com org net edu gov',
  in: 'co net org firm gen ind ac edu res gov',
  br: 'com net org gov edu art blog app',
  mx: 'com org gob edu net',
  ar: 'com org gob net edu',
  co: 'com org net edu gov',
  za: 'co org net gov ac web',
  tr: 'com org net gov edu gen biz info',
  il: 'co org net ac gov',
  ua: 'com org net gov',
  pl: 'com net org gov edu',
  es: 'com org nom gob edu',
  pe: 'com org net gob edu',
  ph: 'com org net gov edu',
  id: 'co or ac go web net my sch',
  th: 'co or ac go in net',
  vn: 'com net org gov edu',
  pk: 'com net org gov edu',
  ng: 'com org gov edu net',
  ke: 'co or go ac ne',
  eg: 'com org gov edu net',
  sa: 'com net org gov edu',
  ae: 'co net org gov ac',
  qa: 'com net org gov edu',
};
const ICANN_MULTI = new Set(
  Object.entries(CC_SLDS).flatMap(([cc, slds]) => slds.split(' ').map((s) => `${s}.${cc}`)),
);

// Platform ("private") suffixes: each subdomain is a different site/owner.
const PRIVATE_SUFFIXES = new Set(`github.io gitlab.io pages.dev workers.dev vercel.app netlify.app
  herokuapp.com web.app firebaseapp.com appspot.com azurewebsites.net azureedge.net cloudfront.net
  blogspot.com myshopify.com wordpress.com wpengine.com wixsite.com squarespace.com webflow.io
  framer.website fly.dev onrender.com glitch.me replit.app s3.amazonaws.com amazonaws.com
  elasticbeanstalk.com ngrok.io ngrok-free.app trycloudflare.com translate.goog`.split(/\s+/));

export function isIP(host = '') {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

export function isPrivateIP(ip = '') {
  if (ip.includes(':')) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || /^f[cd]/.test(l) || l.startsWith('fe80') || l.startsWith('::ffff:127.');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * The registrable domain ("eTLD+1") of a host.
 * includePrivate: treat platform suffixes (github.io, vercel.app…) as public — right for
 * first/third-party decisions, wrong for WHOIS (which needs the ICANN-level domain).
 */
export function registrableDomain(host = '', { includePrivate = false } = {}) {
  host = host.toLowerCase().replace(/\.$/, '');
  if (!host || isIP(host) || !host.includes('.')) return host;
  const labels = host.split('.');
  let suffixLen = 1;
  for (let n = Math.min(3, labels.length - 1); n >= 2; n--) {
    const s = labels.slice(-n).join('.');
    if (ICANN_MULTI.has(s) || (includePrivate && PRIVATE_SUFFIXES.has(s))) { suffixLen = n; break; }
  }
  if (labels.length <= suffixLen) return host;
  return labels.slice(-(suffixLen + 1)).join('.');
}

export const siteOf = (host) => registrableDomain(host, { includePrivate: true });
export const isThirdParty = (host, site) => siteOf(host) !== site;

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}
export function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

/* ---------------------------------------------------------------- headers */

export function header(headers, name) {
  const n = name.toLowerCase();
  const h = headers?.find((x) => x.name.toLowerCase() === n);
  return h ? h.value : undefined;
}
export function headerAll(headers, name) {
  const n = name.toLowerCase();
  return (headers || []).filter((x) => x.name.toLowerCase() === n).map((x) => x.value);
}
export const reqHeader = (entry, name) => header(entry?.request?.headers, name);
export const resHeader = (entry, name) => header(entry?.response?.headers, name);

/* ---------------------------------------------------------------- entries */

const isRedirect = (e) => e?.response?.status >= 300 && e?.response?.status < 400;

export function resourceType(entry) {
  const t = entry._resourceType;
  if (t) {
    if (t === 'fetch' || t === 'xhr') return 'xhr';
    if (['document', 'script', 'stylesheet', 'image', 'font', 'media'].includes(t)) return t;
    return 'other';
  }
  const m = entry.response?.content?.mimeType || '';
  if (/html/.test(m)) return 'document';
  if (/javascript|ecmascript/.test(m)) return 'script';
  if (/css/.test(m)) return 'stylesheet';
  if (/^image\//.test(m)) return 'image';
  if (/font|woff/.test(m)) return 'font';
  if (/^(audio|video)\//.test(m)) return 'media';
  if (/json|xml/.test(m)) return 'xhr';
  return 'other';
}

/** The response that delivered the page being read (end of the redirect chain). */
export function mainEntry(har) {
  const entries = har?.log?.entries || [];
  const finalUrl = har?.log?._harplus?.target?.finalUrl;
  const docs = entries.filter((e) => resourceType(e) === 'document');
  if (finalUrl) {
    const m = docs.filter((e) => e.request.url === finalUrl && !isRedirect(e));
    if (m.length) return m[m.length - 1];
  }
  return docs.find((e) => !isRedirect(e) && e.response.status > 0) || docs[0] || entries[0];
}

/** Entries that redirected to the main document, oldest first, ending with the main entry. */
export function redirectChain(har, final = mainEntry(har)) {
  if (!final) return [];
  const entries = har.log.entries;
  const chain = [final];
  let url = final.request.url;
  for (let i = 0; i < 10; i++) {
    const prev = entries.find((e) => isRedirect(e) && !chain.includes(e) &&
      resolveUrl(e.response.redirectURL || header(e.response.headers, 'location'), e.request.url) === url);
    if (!prev) break;
    chain.unshift(prev);
    url = prev.request.url;
  }
  return chain;
}

export function resolveUrl(href, base) {
  try { return new URL(href, base).href; } catch { return ''; }
}

export function transferSize(entry) {
  const r = entry.response || {};
  if (typeof r._transferSize === 'number' && r._transferSize >= 0) return r._transferSize;
  const body = r.bodySize > 0 ? r.bodySize : 0;
  const head = r.headersSize > 0 ? r.headersSize : 0;
  return body + head;
}
export const decodedSize = (entry) => Math.max(0, entry.response?.content?.size || 0);

/** Unique server IPs with the hosts they served. */
export function serverIPs(har) {
  const main = mainEntry(har);
  const map = new Map();
  for (const e of har.log.entries) {
    const ip = (e.serverIPAddress || '').replace(/^\[|\]$/g, '');
    if (!ip) continue;
    const rec = map.get(ip) || { ip, hosts: new Set(), requests: 0, bytes: 0, main: false };
    rec.hosts.add(hostOf(e.request.url));
    rec.requests++;
    rec.bytes += transferSize(e);
    if (e === main) rec.main = true;
    map.set(ip, rec);
  }
  return [...map.values()]
    .map((r) => ({ ...r, hosts: [...r.hosts] }))
    .sort((a, b) => (b.main - a.main) || (b.requests - a.requests));
}

export function cookieNames(har) {
  const names = new Set();
  for (const e of har.log.entries) {
    for (const c of e.request?.cookies || []) names.add(c.name);
    for (const c of e.response?.cookies || []) names.add(c.name);
  }
  return names;
}

/* ------------------------------------------------------------- formatting */

export function formatBytes(n) {
  if (n == null || isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
export function formatMs(ms) {
  if (ms == null || isNaN(ms) || ms < 0) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
export function daysBetween(a, b = Date.now()) {
  return Math.round((new Date(b) - new Date(a)) / 86_400_000);
}
export function truncate(s = '', n = 120) {
  s = String(s);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Response body as text (decodes base64 bodies); '' when not captured. */
export function bodyText(entry) {
  const c = entry?.response?.content;
  if (!c?.text) return '';
  if (c.encoding !== 'base64') return c.text;
  try { return new TextDecoder().decode(Uint8Array.from(atob(c.text), (ch) => ch.charCodeAt(0))); } catch { return ''; }
}
