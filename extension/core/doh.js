// DNS-over-HTTPS (JSON API) client shared by the lookup plugins.
// Both Cloudflare and Google speak the same "application/dns-json" dialect.

export const RESOLVERS = {
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  google: 'https://dns.google/resolve',
};

export const TYPES = {
  A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, DS: 43, HTTPS: 65, CAA: 257,
};
const TYPE_NAMES = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));

export const RCODES = { 0: 'NOERROR', 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 5: 'REFUSED' };

/**
 * Resolve one name/type. Returns { status, ad, answers: [{ name, type, ttl, data }] }.
 * `fetchFn` is injected so callers can add timeouts, tracking or caching.
 */
export async function resolve(fetchFn, resolver, name, type) {
  const url = new URL(RESOLVERS[resolver] || resolver || RESOLVERS.cloudflare);
  url.searchParams.set('name', name);
  url.searchParams.set('type', type);
  const r = await fetchFn(url.href, { headers: { accept: 'application/dns-json' } });
  if (!r.ok) throw new Error(`DoH ${r.status} for ${name} ${type}`);
  const j = await r.json();
  return {
    status: RCODES[j.Status] || String(j.Status),
    ad: !!j.AD,
    answers: (j.Answer || []).map((a) => ({
      name: String(a.name).replace(/\.$/, ''),
      type: TYPE_NAMES[a.type] || String(a.type),
      ttl: a.TTL,
      data: a.data,
    })),
  };
}

/** Join the quoted character-strings of a TXT record: `"v=spf1 a" " -all"` → `v=spf1 a -all`. */
export function txtValue(data = '') {
  const parts = String(data).match(/"((?:[^"\\]|\\.)*)"/g);
  return parts ? parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, '$1')).join('') : String(data);
}

export const stripDot = (s = '') => String(s).replace(/\.$/, '');

export function expandIPv6(ip) {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail !== undefined ? Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((g) => g.padStart(4, '0')).join(':');
}

function nibbles(ip) {
  return expandIPv6(ip).replace(/:/g, '').split('').reverse().join('.');
}

/** PTR query name for an IP. */
export function reverseName(ip) {
  return ip.includes(':') ? `${nibbles(ip)}.ip6.arpa` : `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
}

/** Team Cymru IP→ASN query name (answered over plain DNS, so DoH works). */
export function cymruOriginName(ip) {
  return ip.includes(':')
    ? `${nibbles(ip)}.origin6.asn.cymru.com`
    : `${ip.split('.').reverse().join('.')}.origin.asn.cymru.com`;
}
