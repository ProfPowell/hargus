// Internet exposure of the site's servers from Shodan InternetDB (free, no key):
// open ports, known CVEs (version-inferred), tags and hostnames seen on each IP.

import { serverIPs, isPrivateIP } from '../core/har-util.js';
import { HttpError } from '../core/plugin-host.js';

const SERVICES = {
  21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 110: 'POP3', 135: 'MS RPC', 139: 'NetBIOS', 445: 'SMB',
  1433: 'MS SQL', 1521: 'Oracle DB', 2375: 'Docker API', 3306: 'MySQL', 3389: 'RDP', 5432: 'PostgreSQL',
  5900: 'VNC', 5984: 'CouchDB', 6379: 'Redis', 9200: 'Elasticsearch', 11211: 'Memcached', 27017: 'MongoDB',
};
const HIGH_RISK = new Set([23, 135, 139, 445, 1433, 1521, 2375, 3306, 3389, 5432, 5900, 5984, 6379, 9200, 11211, 27017]);
const TAG_SEVERITY = {
  compromised: 'high', malware: 'high', c2: 'high', doublepulsar: 'high',
  'eol-os': 'medium', 'eol-product': 'medium', 'ssh-bad-key': 'medium', 'self-signed': 'low',
};

async function run(reading, ctx) {
  const intel = ctx.results['ip-intel']?.data?.servers || [];
  let ips = serverIPs(reading).filter((s) => !isPrivateIP(s.ip));
  if (ctx.options.scope !== 'all') ips = ips.filter((s) => s.main || s.hosts.some((h) => !ctx.util.isThirdParty(h, ctx.target.site)));
  ips = ips.slice(0, Number(ctx.options.maxIps) || 4);
  if (!ips.length) ctx.skip('no public first-party server IPs');

  const hosts = await Promise.all(ips.map(async (s) => {
    const url = `https://internetdb.shodan.io/${s.ip}`;
    const r = await ctx.fetch(url);
    if (r.status === 404) return { ip: s.ip, main: s.main, found: false, ports: [], vulns: [], tags: [], hostnames: [], cpes: [] };
    if (!r.ok) throw new HttpError(r.status, url);
    const j = await r.json();
    const cdn = intel.find((x) => x.ip === s.ip)?.kind === 'cdn' || (j.tags || []).includes('cdn');
    return { ip: s.ip, main: s.main, found: true, cdn, ports: j.ports || [], vulns: j.vulns || [], tags: j.tags || [], hostnames: j.hostnames || [], cpes: j.cpes || [] };
  }));

  const findings = [];
  for (const h of hosts) {
    if (!h.found) continue;
    if (h.cdn) {
      findings.push({ severity: 'info', category: 'security', title: `${h.ip} is a CDN edge — exposure data describes the CDN, not the origin` });
      continue;
    }
    if (h.vulns.length) {
      findings.push({
        severity: 'high', category: 'security', title: `${h.vulns.length} known CVEs associated with ${h.ip}`,
        detail: 'Inferred from service banners/versions; confirm before acting.', evidence: h.vulns.slice(0, 15).join(', '),
        ref: `https://www.shodan.io/host/${h.ip}`,
      });
    }
    const risky = h.ports.filter((p) => HIGH_RISK.has(p));
    if (risky.length) findings.push({ severity: 'high', category: 'security', title: `Sensitive services reachable on ${h.ip}`, detail: risky.map((p) => `${p} ${SERVICES[p]}`).join(', ') });
    const other = h.ports.filter((p) => !HIGH_RISK.has(p) && ![80, 443].includes(p));
    if (other.length) findings.push({ severity: 'low', category: 'security', title: `Additional open ports on ${h.ip}`, detail: other.map((p) => (SERVICES[p] ? `${p} ${SERVICES[p]}` : p)).join(', ') });
    for (const tag of h.tags) {
      if (TAG_SEVERITY[tag]) findings.push({ severity: TAG_SEVERITY[tag], category: 'security', title: `Shodan tags ${h.ip} as "${tag}"` });
    }
  }
  const main = hosts.find((x) => x.main) || hosts[0];
  const vulnCount = hosts.reduce((n, x) => n + (x.cdn ? 0 : x.vulns.length), 0);
  return {
    data: { hosts },
    findings,
    summary: [
      { label: 'Main IP ports', headline: true, value: main.found ? main.ports.join(', ') || 'none seen' : 'not in InternetDB' },
      { label: 'CVEs (non-CDN)', headline: true, value: vulnCount },
      { label: 'Tags', value: [...new Set(hosts.flatMap((x) => x.tags))].join(', ') },
      { label: 'Other hostnames on IP', value: main.hostnames?.slice(0, 5).join(', ') },
    ],
  };
}

/**
 * Answer first (IPs looked up, open ports, sensitive services, CVEs), then one row per IP, showing the first 20 CVEs as
 * tags. CVE IDs name weaknesses, not places on the site, so the finding keeps them as evidence.
 */
function render(r, h) {
  const hosts = Array.isArray(r.data?.hosts) ? r.data.hosts : [];
  const own = hosts.filter((x) => x.found && !x.cdn);
  const rows = hosts.map((x) => {
    const vulns = x.vulns || [];
    return {
      ip: h.link(`https://www.shodan.io/host/${x.ip}`, x.ip),
      seen: !x.found ? 'not in InternetDB' : x.cdn ? 'CDN edge' : 'yes',
      ports: (x.ports || []).map((p) => (SERVICES[p] ? `${p}/${SERVICES[p]}` : p)).join(', '),
      tags: h.tags(x.tags || []),
      cves: vulns.length ? h.html`${h.tags(vulns.slice(0, 20))}${vulns.length > 20 ? ` +${vulns.length - 20} more` : ''}` : '',
      hostnames: h.list((x.hostnames || []).slice(0, 8)),
      software: h.list((x.cpes || []).slice(0, 8)),
    };
  });
  return h.html`${h.stats([
    h.stat({ label: 'IPs looked up', value: hosts.length, note: hosts.length > own.length ? `${hosts.length - own.length} CDN or not listed` : '' }),
    h.stat({ label: 'Open ports', value: own.reduce((n, x) => n + (x.ports || []).length, 0) }),
    h.stat({ label: 'Sensitive services', value: own.reduce((n, x) => n + (x.ports || []).filter((p) => HIGH_RISK.has(p)).length, 0) }),
    h.stat({ label: 'CVEs (non-CDN)', value: own.reduce((n, x) => n + (x.vulns || []).length, 0) }),
  ])}
    ${h.table(rows, [
    { key: 'ip', label: 'IP' }, { key: 'seen', label: 'Listed' }, { key: 'ports', label: 'Ports' }, { key: 'tags', label: 'Tags' },
    { key: 'cves', label: 'CVEs' }, { key: 'hostnames', label: 'Hostnames' }, { key: 'software', label: 'Software' },
  ])}
    <p class="note">Shodan InternetDB, refreshed weekly. CVEs are inferred from versions, not verified.</p>`;
}

export default {
  id: 'exposure',
  group: 'security',
  name: 'Exposure (Shodan)',
  version: '0.1.0',
  phase: 'enrich',
  after: ['ip-intel'],
  description: 'Open ports, CVEs, tags and co-hosted names for first-party server IPs from Shodan InternetDB.',
  disclosure: 'Sends first-party server IPs to internetdb.shodan.io.',
  tags: ['security'],
  options: [
    { key: 'scope', label: 'Which IPs', type: 'select', default: 'first-party', choices: ['first-party', 'all'] },
    { key: 'maxIps', label: 'Max IPs', type: 'number', default: 4 },
  ],
  run,
  render,
};
