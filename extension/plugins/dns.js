// DNS reading over DNS-over-HTTPS: address records, CNAME chain, NS/MX/TXT/CAA/SOA, email
// authentication (SPF, DMARC, DKIM, MTA-STS, BIMI) and SaaS verification tokens.

import { txtValue, stripDot } from '../core/doh.js';
import {
  NS_PROVIDERS, MX_PROVIDERS, SPF_INCLUDES, TXT_VERIFICATIONS, CNAME_HOSTING, classify, classifyAll,
} from './kb/providers.js';

const DKIM_HINTS = {
  google: 'Google Workspace', selector1: 'Microsoft 365', selector2: 'Microsoft 365', k1: 'Mailchimp / Mandrill',
  s1: 'SendGrid', s2: 'SendGrid', smtpapi: 'SendGrid', hs1: 'HubSpot', hs2: 'HubSpot', mandrill: 'Mandrill',
  zendesk1: 'Zendesk', zendesk2: 'Zendesk', pm: 'Postmark', cm: 'Campaign Monitor',
};

async function settle(obj) {
  const keys = Object.keys(obj);
  const vals = await Promise.all(keys.map((k) => obj[k]));
  return Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
}

const values = (res, type) => (res?.answers || []).filter((a) => a.type === type).map((a) => a.data);

function parseCAA(data) {
  const s = String(data);
  if (s.startsWith('\\#')) { // RFC 3597 generic encoding: flags, tag length, tag, value
    const bytes = s.split(/\s+/).slice(2).join('').match(/../g)?.map((x) => parseInt(x, 16)) || [];
    const len = bytes[1];
    const tag = String.fromCharCode(...bytes.slice(2, 2 + len));
    const value = String.fromCharCode(...bytes.slice(2 + len));
    return { flags: bytes[0], tag, value };
  }
  const m = s.match(/^(\d+)\s+(\S+)\s+"?([^"]*)"?/);
  return m ? { flags: Number(m[1]), tag: m[2], value: m[3] } : { raw: s };
}

function tagMap(record = '') {
  return Object.fromEntries(record.split(';').map((p) => p.trim().split('=')).filter((x) => x[0])
    .map(([k, ...v]) => [k.trim().toLowerCase(), v.join('=').trim()]));
}

async function run(reading, ctx) {
  const { host, domain } = ctx.target;
  if (!host || ctx.util.isIP(host)) ctx.skip('target is an IP address');
  if (!domain.includes('.')) ctx.skip(`"${domain}" is not a public domain`);
  const q = (name, type) => ctx.dns(name, type);
  const selectors = String(ctx.options.dkimSelectors || '').split(/[\s,]+/).filter(Boolean);

  const r = await settle({
    A: q(host, 'A'), AAAA: q(host, 'AAAA'), HTTPS: q(host, 'HTTPS'),
    NS: q(domain, 'NS'), MX: q(domain, 'MX'), TXT: q(domain, 'TXT'), CAA: q(domain, 'CAA'),
    SOA: q(domain, 'SOA'), DS: q(domain, 'DS'), apexA: host !== domain ? q(domain, 'A') : null,
    dmarc: q(`_dmarc.${domain}`, 'TXT'), mtaSts: q(`_mta-sts.${domain}`, 'TXT'),
    tlsRpt: q(`_smtp._tls.${domain}`, 'TXT'), bimi: q(`default._bimi.${domain}`, 'TXT'),
  });
  const dkimRes = await settle(Object.fromEntries(selectors.map((s) => [s, q(`${s}._domainkey.${domain}`, 'TXT')])));

  const errors = Object.entries(r).filter(([, v]) => v?.status === 'ERROR').map(([k, v]) => `${k}: ${v.error}`);
  if (errors.length >= 8) throw new Error(`DNS lookups failing — ${errors[0]}`);

  const ipv4 = values(r.A, 'A');
  const ipv6 = values(r.AAAA, 'AAAA');
  const cnames = values(r.A, 'CNAME').map(stripDot);
  const ns = values(r.NS, 'NS').map(stripDot).sort();
  const mx = values(r.MX, 'MX').map((d) => {
    const [pref, mxHost] = String(d).split(/\s+/);
    return { preference: Number(pref), host: stripDot(mxHost || '') };
  }).sort((a, b) => a.preference - b.preference);
  const txt = values(r.TXT, 'TXT').map(txtValue);
  const spfRecords = txt.filter((v) => /^v=spf1\b/i.test(v));
  const spf = spfRecords[0] || null;
  const spfIncludes = spf ? [...spf.matchAll(/(?:include:|redirect=)(\S+)/gi)].map((m) => m[1]) : [];
  const allTerm = spf ? spf.split(/\s+/).map((t) => t.match(/^([-~?+]?)all$/i)).find(Boolean) : null;
  const spfAll = allTerm ? (allTerm[1] || '+') : null;
  const spfLookups = spf ? (spf.match(/\b(include:|a\b|a:|mx\b|mx:|ptr|exists:|redirect=)/gi) || []).length : 0;
  const verifications = [...new Set(txt.map((v) => classify(TXT_VERIFICATIONS, v)?.label).filter(Boolean))];
  const otherTxt = txt.filter((v) => !/^v=spf1/i.test(v) && !classify(TXT_VERIFICATIONS, v));
  const dmarcRaw = values(r.dmarc, 'TXT').map(txtValue).find((v) => /^v=DMARC1/i.test(v)) || null;
  const dmarc = dmarcRaw ? tagMap(dmarcRaw) : null;
  const dmarcReporters = dmarc?.rua ? [...new Set(dmarc.rua.split(',').map((u) => u.replace(/^mailto:/i, '').split('@')[1]).filter(Boolean))] : [];
  const caa = values(r.CAA, 'CAA').map(parseCAA);
  const soaParts = String(values(r.SOA, 'SOA')[0] || '').split(/\s+/);
  const soa = soaParts.length >= 3 ? { primary: stripDot(soaParts[0]), contact: stripDot(soaParts[1]).replace('.', '@'), serial: soaParts[2] } : null;
  const dnssec = values(r.DS, 'DS').length > 0;
  const dkim = Object.entries(dkimRes)
    .filter(([, v]) => values(v, 'TXT').map(txtValue).some((t) => /v=DKIM1|\bp=/.test(t)))
    .map(([sel]) => ({ selector: sel, hint: DKIM_HINTS[sel] }));
  const httpsRR = values(r.HTTPS, 'HTTPS');

  const dnsHost = classifyAll(NS_PROVIDERS, ns);
  const mailHost = classifyAll(MX_PROVIDERS, mx.map((m) => m.host));
  const senders = classifyAll(SPF_INCLUDES, spfIncludes);
  const webHost = classifyAll(CNAME_HOSTING, cnames);

  // Only judge what we actually saw: a failed lookup is not an absent record.
  const ok = (...keys) => keys.every((k) => r[k]?.status && r[k].status !== 'ERROR');
  const findings = [];
  const add = (severity, category, title, detail) => findings.push({ severity, category, title, detail });
  const mail = 'security';
  if (ok('TXT', 'MX')) {
    if (!spf) add(mx.length ? 'medium' : 'low', mail, 'No SPF record', 'Anyone can send mail claiming to be this domain.');
    if (!mx.length && spfAll !== '-') add('low', mail, 'Domain has no MX but is not locked down (publish "v=spf1 -all" and DMARC p=reject)');
  }
  if (spfRecords.length > 1) add('medium', mail, 'Multiple SPF records (SPF permerror)');
  if (spfAll === '+') add('high', mail, 'SPF allows every server on the internet (+all)');
  if (spfAll === '?') add('low', mail, 'SPF ends in ?all (neutral) — provides no protection');
  if (spfLookups > 10) add('medium', mail, `SPF needs ${spfLookups}+ DNS lookups (limit is 10)`);
  if (ok('dmarc')) {
    if (!dmarc) add('medium', mail, 'No DMARC policy', `Publish a TXT record at _dmarc.${domain}.`);
    else if (/none/i.test(dmarc.p)) add('low', mail, 'DMARC policy is p=none (monitoring only)');
    else if (dmarc.pct && Number(dmarc.pct) < 100) add('info', mail, `DMARC applies to ${dmarc.pct}% of mail`);
  }
  if (ok('CAA') && !caa.length) add('info', 'security', 'No CAA record — any certificate authority may issue for this domain');
  if (ok('DS') && !dnssec) add('info', 'infrastructure', 'Domain is not DNSSEC-signed');
  if (dnsHost.includes('Domain parking service')) add('medium', 'intel', 'Nameservers belong to a domain parking service');

  return {
    data: {
      host, domain, ipv4, ipv6, cnames, ns, mx, txt, spf, spfIncludes, spfAll, verifications, otherTxt,
      dmarc, dmarcRaw, dmarcReporters, caa, soa, dnssec, dkim, httpsRR,
      mtaSts: values(r.mtaSts, 'TXT').map(txtValue)[0] || null,
      tlsRpt: values(r.tlsRpt, 'TXT').map(txtValue)[0] || null,
      bimi: values(r.bimi, 'TXT').map(txtValue)[0] || null,
      providers: { dns: dnsHost, mail: mailHost, senders, web: webHost },
      errors,
    },
    findings,
    summary: [
      { label: 'Addresses', value: `${ipv4.length} IPv4 · ${ipv6.length ? `${ipv6.length} IPv6` : 'no IPv6'}` },
      { label: 'Web host (CNAME)', value: webHost.join(', ') || cnames.at(-1) },
      { label: 'DNS provider', value: dnsHost.join(', ') || ns[0] },
      { label: 'Mail', value: mx.length ? mailHost.join(', ') || mx[0].host : 'no MX' },
      { label: 'Sends mail via', value: [...new Set([...senders, ...dkim.map((d) => d.hint).filter(Boolean)])].join(', ') },
      { label: 'DMARC', value: dmarc ? `p=${dmarc.p}${dmarcReporters.length ? ` · reports to ${dmarcReporters.join(', ')}` : ''}` : ok('dmarc') ? 'none' : 'lookup failed' },
      { label: 'Verified SaaS', value: verifications.join(', ') },
      { label: 'DNSSEC · CAA', value: `${dnssec ? 'signed' : 'unsigned'} · ${caa.length ? caa.filter((c) => c.tag === 'issue').map((c) => c.value).join(', ') || 'set' : 'none'}` },
    ],
  };
}

function render(r, h) {
  const d = r.data;
  return h.html`
    ${h.kv([
      ['Host', d.host], ['Registrable domain', d.domain],
      ['CNAME chain', d.cnames.join(' → ')], ['IPv4', d.ipv4.join(', ')], ['IPv6', d.ipv6.join(', ')],
      ['HTTPS record', d.httpsRR.join(' | ')], ['Nameservers', d.ns.join(', ')],
      ['SOA', d.soa ? `${d.soa.primary} · ${d.soa.contact} · serial ${d.soa.serial}` : ''],
      ['DNSSEC', d.dnssec ? 'signed (DS present)' : 'unsigned'],
    ])}
    ${h.sub('Mail', h.kv([
      ['MX', d.mx.map((m) => `${m.preference} ${m.host}`).join(', ') || 'none'],
      ['SPF', d.spf], ['DMARC', d.dmarcRaw],
      ['DKIM selectors found', d.dkim.map((x) => x.selector + (x.hint ? ` (${x.hint})` : '')).join(', ')],
      ['MTA-STS', d.mtaSts], ['TLS-RPT', d.tlsRpt], ['BIMI', d.bimi],
    ]))}
    ${d.verifications.length ? h.sub('Verified SaaS (TXT tokens)', h.tags(d.verifications)) : ''}
    ${d.caa.length ? h.sub('CAA', h.table(d.caa, ['flags', 'tag', 'value'])) : ''}
    ${d.otherTxt.length ? h.sub('Other TXT records', h.list(d.otherTxt)) : ''}
    ${d.errors.length ? h.sub('Lookup errors', h.list(d.errors)) : ''}
  `;
}

export default {
  id: 'dns',
  group: 'infrastructure',
  name: 'DNS',
  version: '0.1.0',
  phase: 'enrich',
  description: 'Addresses, CNAME chain, nameservers, MX, TXT, CAA, DNSSEC, SPF/DMARC/DKIM/MTA-STS/BIMI, SaaS verification tokens.',
  disclosure: 'Sends the hostname and domain to your DNS-over-HTTPS resolver (Cloudflare or Google).',
  tags: ['intel', 'infrastructure', 'security'],
  options: [
    { key: 'dkimSelectors', label: 'DKIM selectors to probe', type: 'text', default: 'google selector1 selector2 k1 s1 s2 hs1 mandrill zendesk1 pm' },
  ],
  run,
  render,
};
