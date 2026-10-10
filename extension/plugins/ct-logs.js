// Subdomains from Certificate Transparency logs (crt.sh). Every publicly trusted TLS certificate
// is logged, so CT reveals hostnames a company has issued certificates for — staging, VPN, mail,
// regional sites, acquisitions. crt.sh is a free community service and can be slow: off by default.

import { HttpError } from '../core/plugin-host.js';

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
      severity: 'low', category: 'security',
      title: `${notable.length} non-production or admin-looking hostnames in CT logs`,
      detail: 'Publicly discoverable; make sure they are meant to be reachable.',
      evidence: notable.slice(0, 25).join('\n'),
    });
  }
  if (subdomains.length > 1) findings.push({ severity: 'info', category: 'intel', title: `${subdomains.length} hostnames on certificates for ${domain}` });

  return {
    data: { domain, certificates: rows.length, subdomains: subdomains.slice(0, 1000), notable, issuers: [...issuers].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })) },
    findings,
    summary: [
      { label: 'Hostnames', value: `${subdomains.length} from ${rows.length} certificates${ctx.options.includeExpired ? '' : ' (unexpired)'}` },
      { label: 'Notable', value: notable.slice(0, 6).join(', ') },
      { label: 'Issuers', value: [...issuers.keys()].slice(0, 4).join(', ') },
    ],
  };
}

function render(r, h) {
  const d = r.data;
  return h.html`
    ${h.sub('Certificate authorities', h.table(d.issuers, ['name', 'count']))}
    ${h.sub(`Hostnames (${d.subdomains.length})`, h.table(d.subdomains.slice(0, 300).map((s) => ({
      name: s.name, certs: s.certs, 'first seen': String(s.firstSeen || '').slice(0, 10), 'last seen': String(s.lastSeen || '').slice(0, 10), wildcard: s.wildcard,
    })), ['name', 'certs', 'first seen', 'last seen', 'wildcard']))}`;
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
