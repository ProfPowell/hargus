// Who serves this site? For each server IP in the recording: reverse DNS, ASN and network name
// (Team Cymru over DoH), RDAP network owner, optional geolocation, and hosting/CDN classification.

import { serverIPs, isPrivateIP } from '../core/har-util.js';
import { reverseName, cymruOriginName, txtValue, stripDot } from '../core/doh.js';
import { ASN_PROVIDERS, classify } from './kb/providers.js';

const txt = (res) => (res?.answers || []).filter((a) => a.type === 'TXT').map((a) => txtValue(a.data));
const ok = (res) => {
  if (res?.status === 'ERROR') throw new Error(res.error);
  return res;
};

function rdapOrg(j) {
  const ent = (j.entities || []).find((e) => (e.roles || []).some((r) => /registrant|administrative/.test(r))) || j.entities?.[0];
  return ent?.vcardArray?.[1]?.find((p) => p[0] === 'fn')?.[3];
}

async function lookup(ctx, ip, { rdap, geo }) {
  const out = { ip };
  if (isPrivateIP(ip)) return { ...out, private: true };
  const tasks = [
    ctx.dns(reverseName(ip), 'PTR').then(ok).then((r) => {
      out.ptr = r.answers.filter((a) => a.type === 'PTR').map((a) => stripDot(a.data));
    }),
    ctx.dns(cymruOriginName(ip), 'TXT').then(ok).then(async (r) => {
      const rec = txt(r)[0];
      if (!rec) return;
      const [asns, prefix, cc, rir, allocated] = rec.split('|').map((s) => s.trim());
      const asn = asns.split(/\s+/)[0];
      Object.assign(out, { asn: Number(asn), prefix, country: cc, rir, allocated });
      const name = txt(await ctx.dns(`AS${asn}.asn.cymru.com`, 'TXT'))[0];
      if (name) out.asName = name.split('|').map((s) => s.trim())[4];
    }),
  ];
  if (rdap) {
    const base = String(ctx.options.rdapEndpoint || 'https://rdap.org').replace(/\/$/, '');
    tasks.push(ctx.fetchJSON(`${base}/ip/${ip}`, { headers: { accept: 'application/rdap+json, application/json' } }).then((j) => {
      out.network = {
        name: j.name, handle: j.handle, type: j.type, country: j.country, org: rdapOrg(j),
        range: j.startAddress && j.endAddress ? `${j.startAddress} – ${j.endAddress}` : undefined,
        cidr: (j.cidr0_cidrs || []).map((c) => `${c.v4prefix || c.v6prefix}/${c.length}`).join(', ') || undefined,
      };
    }));
  }
  if (geo === 'ipinfo') {
    const token = ctx.keys.ipinfo ? `?token=${encodeURIComponent(ctx.keys.ipinfo)}` : '';
    tasks.push(ctx.fetchJSON(`https://ipinfo.io/${ip}/json${token}`).then((j) => {
      out.geo = {
        city: j.city, region: j.region, country: j.country, loc: j.loc, org: j.org,
        hostname: j.hostname, anycast: j.anycast || undefined, timezone: j.timezone,
      };
    }));
  }
  const errors = [];
  await Promise.all(tasks.map((t) => t.catch((e) => errors.push(String(e.message || e)))));
  if (errors.length) out.errors = errors;
  const provider = classify(ASN_PROVIDERS, [out.asName, out.network?.org, out.network?.name, out.geo?.org].filter(Boolean).join(' '));
  out.provider = provider?.label;
  out.kind = provider?.kind;
  return out;
}

async function run(reading, ctx) {
  const ips = serverIPs(reading);
  if (!ips.length) ctx.skip('no server IP addresses in the recording');
  const list = ips.slice(0, Number(ctx.options.maxIps) || 8);
  const rdapCount = Number(ctx.options.rdapIps) || 0;
  const looked = await Promise.all(list.map((rec, i) => lookup(ctx, rec.ip, { rdap: i < rdapCount, geo: ctx.options.geo })));
  const servers = looked.map((r, i) => ({
    ...list[i], ...r,
    firstParty: list[i].hosts.some((host) => !ctx.util.isThirdParty(host, ctx.target.site)),
  }));
  if (servers.every((s) => !s.private && !s.asn && !s.network && !s.geo && s.errors?.length)) {
    throw new Error(`lookups failed — ${servers[0].errors[0]}`);
  }
  const main = servers.find((s) => s.main) || servers[0];
  const firstPartyProviders = [...new Set(servers.filter((s) => s.firstParty && s.provider).map((s) => s.provider))];
  const allProviders = [...new Set(servers.filter((s) => s.provider).map((s) => s.provider))];

  const findings = [];
  if (main.kind === 'cdn') {
    findings.push({ severity: 'info', category: 'infrastructure', title: `Origin is behind ${main.provider}`, detail: 'IP, ASN and location describe the CDN edge, not the origin server.' });
  }
  if (main.private) findings.push({ severity: 'info', category: 'infrastructure', title: 'Main document came from a private IP (proxy, VPN or local server in the path)' });
  if (firstPartyProviders.length > 1) findings.push({ severity: 'info', category: 'intel', title: `First-party content is served from ${firstPartyProviders.length} providers`, detail: firstPartyProviders.join(', ') });

  const where = (s) => (s?.geo ? [s.geo.city, s.geo.region, s.geo.country].filter(Boolean).join(', ') + (s.geo.anycast ? ' (anycast)' : '') : s?.country || '');
  return {
    data: { servers, mainIp: main.ip, providers: allProviders, firstPartyProviders },
    findings,
    summary: [
      { label: 'Server IP', value: `${main.ip}${main.ptr?.length ? ` (${main.ptr[0]})` : ''}` },
      { label: 'Network', value: main.asn ? `AS${main.asn} ${main.asName || ''}`.trim() : main.private ? 'private address' : '' },
      { label: 'Hosting', headline: true, value: main.provider ? `${main.provider} · ${main.kind}` : '' },
      { label: 'Location', value: where(main) },
      { label: 'Netblock', value: main.network ? [main.network.name, main.network.cidr || main.prefix, main.network.org].filter(Boolean).join(' · ') : main.prefix },
      { label: 'All providers', value: allProviders.length ? `${allProviders.join(', ')} (${ips.length} IPs)` : `${ips.length} IPs` },
    ],
  };
}

function render(r, h) {
  const rows = r.data.servers.map((s) => ({
    ip: h.html`${s.ip}${s.main ? h.html` <b>main</b>` : ''}`,
    ptr: (s.ptr || []).join(', '),
    asn: s.asn ? `AS${s.asn} ${s.asName || ''}` : s.private ? 'private' : '',
    provider: s.provider ? `${s.provider} (${s.kind})` : '',
    location: s.geo ? [s.geo.city, s.geo.country].filter(Boolean).join(', ') : s.country || '',
    network: s.network ? [s.network.name, s.network.cidr, s.network.org].filter(Boolean).join(' · ') : s.prefix || '',
    hosts: h.list(s.hosts.slice(0, 6)),
    requests: s.requests,
  }));
  return h.html`
    ${h.table(rows, ['ip', 'ptr', 'asn', 'provider', 'location', 'network', 'hosts', 'requests'])}
    <p class="note">ASN via Team Cymru (DNS). Location is approximate; CDN addresses show the nearest edge.</p>
  `;
}

export default {
  id: 'ip-intel',
  group: 'infrastructure',
  name: 'IP & hosting',
  version: '0.1.0',
  phase: 'enrich',
  description: 'Reverse DNS, ASN, network owner (RDAP), geolocation and hosting/CDN provider for each server IP.',
  disclosure: 'Sends server IPs to your DoH resolver (Team Cymru lookups), rdap.org and, if enabled, ipinfo.io.',
  tags: ['intel', 'infrastructure'],
  options: [
    { key: 'maxIps', label: 'Max IPs to look up', type: 'number', default: 8 },
    { key: 'rdapIps', label: 'RDAP lookups for the first N IPs', type: 'number', default: 2 },
    { key: 'geo', label: 'Geolocation provider', type: 'select', default: 'ipinfo', choices: ['ipinfo', 'none'] },
    { key: 'rdapEndpoint', label: 'RDAP bootstrap service', type: 'text', default: 'https://rdap.org' },
  ],
  run,
  render,
};
