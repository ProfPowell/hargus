// Reputation lookups that need your own API keys (Options → API keys):
// AbuseIPDB (server IP), VirusTotal (domain), GreyNoise (server IP; community API).
// Skips quietly when no keys are configured.

import { serverIPs } from '../core/har-util.js';

async function run(reading, ctx) {
  const { abuseipdb, virustotal, greynoise } = ctx.keys;
  const ip = ctx.results['ip-intel']?.data?.mainIp || serverIPs(reading)[0]?.ip;
  const domain = ctx.target.domain;
  const providers = {};
  const tasks = [];

  if (abuseipdb && ip) {
    tasks.push(ctx.fetchJSON(`https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`, {
      headers: { Key: abuseipdb, Accept: 'application/json' },
    }).then(({ data: d }) => {
      providers.abuseipdb = {
        ip, score: d.abuseConfidenceScore, reports: d.totalReports, usage: d.usageType, isp: d.isp,
        tor: d.isTor, whitelisted: d.isWhitelisted, lastReported: d.lastReportedAt,
      };
    }));
  }
  if (virustotal && domain) {
    tasks.push(ctx.fetchJSON(`https://www.virustotal.com/api/v3/domains/${encodeURIComponent(domain)}`, {
      headers: { 'x-apikey': virustotal },
    }).then(({ data }) => {
      const a = data.attributes || {};
      providers.virustotal = {
        domain, stats: a.last_analysis_stats, reputation: a.reputation,
        categories: [...new Set(Object.values(a.categories || {}))],
        popularity: Object.entries(a.popularity_ranks || {}).map(([k, v]) => `${k} #${v.rank}`),
      };
    }));
  }
  if ((greynoise || ctx.options.greynoiseKeyless) && ip) {
    tasks.push(ctx.fetch(`https://api.greynoise.io/v3/community/${encodeURIComponent(ip)}`, {
      headers: greynoise ? { key: greynoise } : {},
    }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (r.status === 404) providers.greynoise = { ip, noise: false, riot: false, message: j.message };
      else if (!r.ok) throw new Error(`GreyNoise ${r.status}${j.message ? `: ${j.message}` : ''}`);
      else providers.greynoise = { ip, noise: j.noise, riot: j.riot, classification: j.classification, name: j.name, lastSeen: j.last_seen, link: j.link };
    }));
  }
  if (!tasks.length) ctx.skip('no reputation API keys configured (Options → API keys)');

  const errors = [];
  await Promise.all(tasks.map((t) => t.catch((e) => errors.push(String(e.message || e)))));
  if (!Object.keys(providers).length) throw new Error(errors.join('; '));

  const findings = [];
  const add = (severity, title, detail) => findings.push({ severity, category: 'security', title, detail });
  const ab = providers.abuseipdb;
  if (ab?.score >= 75) add('high', `AbuseIPDB confidence ${ab.score}% for ${ab.ip}`, `${ab.reports} reports in 90 days`);
  else if (ab?.score >= 25) add('medium', `AbuseIPDB confidence ${ab.score}% for ${ab.ip}`, `${ab.reports} reports in 90 days`);
  const vt = providers.virustotal;
  if (vt?.stats?.malicious) add(vt.stats.malicious >= 3 ? 'high' : 'medium', `${vt.stats.malicious} VirusTotal engines flag ${vt.domain} as malicious`);
  else if (vt?.stats?.suspicious) add('low', `${vt.stats.suspicious} VirusTotal engines flag ${vt.domain} as suspicious`);
  const gn = providers.greynoise;
  if (gn?.classification === 'malicious') add('high', `GreyNoise classifies ${gn.ip} as malicious`);
  else if (gn?.noise) add('medium', `GreyNoise has seen ${gn.ip} scanning the internet`);

  return {
    data: { providers, errors },
    findings,
    summary: [
      { label: 'AbuseIPDB', value: ab ? `${ab.score}% (${ab.reports} reports) · ${ab.usage || ''}` : '' },
      { label: 'VirusTotal', value: vt ? `${vt.stats?.malicious || 0} malicious · ${vt.stats?.suspicious || 0} suspicious · ${vt.categories.slice(0, 3).join(', ')}` : '' },
      { label: 'GreyNoise', value: gn ? (gn.riot ? `known service (${gn.name})` : gn.noise ? gn.classification : 'not observed scanning') : '' },
      { label: 'Errors', value: errors.join('; ') },
    ],
  };
}

export default {
  id: 'reputation',
  group: 'security',
  name: 'Reputation',
  version: '0.1.0',
  phase: 'enrich',
  after: ['ip-intel'],
  description: 'AbuseIPDB, VirusTotal and GreyNoise verdicts for the server IP and domain. Needs API keys.',
  disclosure: 'Sends the main server IP and domain to the reputation services you configure keys for.',
  tags: ['security'],
  options: [
    { key: 'greynoiseKeyless', label: 'Try GreyNoise community API without a key', type: 'checkbox', default: false },
  ],
  run,
};
