// Subdomains from Certificate Transparency logs (crt.sh). Every publicly trusted TLS certificate
// is logged, so CT reveals hostnames a company has issued certificates for — staging, VPN, mail,
// regional sites, acquisitions. crt.sh is a free community service and can be slow: off by default.

import { HttpError } from '../core/plugin-host.js';

const HOSTNAME = /^[a-z0-9.-]+$/i;
const NOTABLE = /^(dev|stage|staging|stg|test|qa|uat|beta|preview|sandbox|demo|admin|internal|intranet|vpn|remote|sso|auth|login|jenkins|gitlab|git|jira|confluence|grafana|kibana|old|legacy|backup)[\d-]*\./;

async function run(reading, ctx) {
  const domain = ctx.target.domain;
  if (!domain || ctx.util.isIP(domain) || !domain.includes('.')) ctx.skip('no registrable domain');
  const url = `https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json${ctx.options.includeExpired ? '' : '&exclude=expired'}`;
  const r = await ctx.fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new HttpError(r.status, url);
  const rows = await r.json();

  const names = new Map();
  const issuers = new Map();
  for (const row of rows) {
    const issuer = (String(row.issuer_name || '').match(/O=([^,]+)/) || [])[1] || row.issuer_name;
    if (issuer) issuers.set(issuer, (issuers.get(issuer) || 0) + 1);
    for (const raw of String(row.name_value || '').split('\n')) {
      const name = raw.trim().toLowerCase().replace(/^\*\./, '');
      if (!name.endsWith(domain)) continue;
      const rec = names.get(name) || { name, certs: 0, firstSeen: row.not_before, lastSeen: row.not_before, wildcard: false };
      rec.certs++;
      if (raw.includes('*')) rec.wildcard = true;
      if (row.not_before < rec.firstSeen) rec.firstSeen = row.not_before;
      if (row.not_before > rec.lastSeen) rec.lastSeen = row.not_before;
      names.set(name, rec);
    }
  }
  const subdomains = [...names.values()].sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
  const notable = subdomains.filter((s) => NOTABLE.test(s.name)).map((s) => s.name);
  const findings = [];
  if (notable.length) {
    findings.push({
      id: 'notable-hostnames', severity: 'low', category: 'security',
      title: `${notable.length} non-production or admin-looking hostnames in CT logs`,
      detail: 'Publicly discoverable; make sure they are meant to be reachable.',
      evidence: notable.slice(0, 25).join('\n'),
      // Every notable hostname (evidence names the first 25) as a place, capped at 200. Only a plain hostname becomes a
      // URL: an email-like SAN (dev.ops@example.com) would parse as a URL for another host, so it stays text.
      places: notable.slice(0, 200).map((name) => (HOSTNAME.test(name) ? { url: `https://${name}/` } : { text: name })),
    });
  }
  if (subdomains.length > 1) findings.push({ id: 'certificate-hostnames', severity: 'info', category: 'intel', title: `${subdomains.length} hostnames on certificates for ${domain}` });

  return {
    // hostnames: the true count (subdomains is capped at 1000).
    data: { domain, certificates: rows.length, hostnames: subdomains.length, subdomains: subdomains.slice(0, 1000), notable, issuers: [...issuers].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })) },
    findings,
    summary: [
      { label: 'Hostnames', headline: true, value: `${subdomains.length} from ${rows.length} certificates${ctx.options.includeExpired ? '' : ' (unexpired)'}` },
      { label: 'Notable', value: notable.slice(0, 6).join(', ') },
      { label: 'Issuers', value: [...issuers.keys()].slice(0, 4).join(', ') },
    ],
  };
}

/**
 * Answer first (hostnames, notable, certificates, issuers), then the issuers and every hostname, both folded past 8.
 * The notable hostnames are also their finding's places; they stay in the hostname table, which lists every name.
 */
function render(r, h) {
  const d = r.data || {};
  const subs = d.subdomains || [];
  const issuers = d.issuers || [];
  const total = d.hostnames ?? subs.length;
  const shown = subs.slice(0, 300);
  return h.html`${h.stats([
    h.stat({ label: 'Hostnames', value: total }),
    h.stat({ label: 'Notable', value: (d.notable || []).length, note: 'non-production or admin' }),
    h.stat({ label: 'Certificates', value: d.certificates ?? 0 }),
    h.stat({ label: 'Issuers', value: issuers.length }),
  ])}
    ${h.sub('Certificate authorities', h.table(issuers, [{ key: 'name', label: 'Issuer' }, { key: 'count', label: 'Certificates' }]))}
    ${h.sub(shown.length < total ? `Hostnames (${shown.length} of ${total})` : 'Hostnames', h.table(shown.map((s) => ({
    name: s.name, certs: s.certs, first: String(s.firstSeen || '').slice(0, 10), last: String(s.lastSeen || '').slice(0, 10), wildcard: !!s.wildcard,
  })), [{ key: 'name', label: 'Hostname' }, { key: 'certs', label: 'Certificates' }, { key: 'first', label: 'First seen' }, { key: 'last', label: 'Last seen' }, { key: 'wildcard', label: 'Wildcard' }]))}`;
}

export default {
  id: 'ct-logs',
  group: 'infrastructure',
  name: 'CT subdomains',
  version: '0.1.0',
  phase: 'enrich',
  defaultEnabled: false,
  description: 'Hostnames found on TLS certificates in Certificate Transparency logs (crt.sh).',
  disclosure: 'Sends the registrable domain to crt.sh.',
  tags: ['intel', 'security'],
  options: [{ key: 'includeExpired', label: 'Include expired certificates', type: 'checkbox', default: false }],
  timeoutMs: 60_000,
  run,
  render,
};
