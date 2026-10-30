// Domain registration: RDAP first (structured JSON, the WHOIS successor), then classic WHOIS for
// registries without RDAP (e.g. .edu, many ccTLDs). Browsers cannot speak WHOIS (TCP port 43), so
// the extension uses an HTTP WHOIS service (who-dat, open source, self-hostable); the Node CLI
// queries port 43 directly.

import { daysBetween } from '../core/har-util.js';

const REDACTED = /redact|privacy|withheld|not disclosed|data protected|gdpr|contact privacy|proxy/i;
const clean = (v) => (v && !REDACTED.test(String(v)) ? String(v).trim() : undefined);
const iso = (v) => {
  if (!v) return undefined;
  const s = String(v).trim().replace(/\s*\(.*\)$/, '');
  const m = s.match(/^(\d{1,2})[-./ ]([A-Za-z]{3})[-./ ](\d{4})$/); // 01-Oct-1986
  const d = m ? new Date(`${m[2]} ${m[1]} ${m[3]} UTC`) : new Date(s.replace(/^(\d{4})\.(\d{2})\.(\d{2})/, '$1-$2-$3'));
  return isNaN(d) ? undefined : d.toISOString();
};

/* ------------------------------------------------------------------ RDAP */

function findRole(obj, role) {
  for (const e of obj?.entities || []) {
    if ((e.roles || []).includes(role)) return e;
    const nested = findRole(e, role);
    if (nested) return nested;
  }
  return null;
}

function vcard(entity) {
  const props = entity?.vcardArray?.[1] || [];
  const get = (name) => props.find((p) => p[0] === name)?.[3];
  const adr = props.find((p) => p[0] === 'adr');
  const address = adr ? (adr[1]?.label || [].concat(adr[3]).flat().filter(Boolean).join(', ')) : undefined;
  const org = get('org');
  const tel = get('tel');
  return {
    name: clean(get('fn')),
    org: clean(Array.isArray(org) ? org.join(' ') : org),
    email: clean(get('email')),
    tel: clean(typeof tel === 'string' ? tel.replace(/^tel:/, '') : undefined),
    address: clean(address),
    country: adr?.[1]?.cc,
  };
}

const eventDate = (obj, action) => obj?.events?.find((e) => e.eventAction === action)?.eventDate;

async function fromRdap(ctx, domain) {
  const base = String(ctx.options.endpoint || 'https://rdap.org').replace(/\/$/, '');
  const accept = { headers: { accept: 'application/rdap+json, application/json' } };
  let registry;
  try {
    registry = await ctx.fetchJSON(`${base}/domain/${domain}`, accept);
  } catch (e) {
    if (e.status === 404 || e.status === 501) return null; // registry has no RDAP service
    throw e;
  }
  let registrar = null;
  const related = (registry.links || []).find((l) => l.rel === 'related' && /\/domain\//i.test(l.href || ''));
  if (ctx.options.followRegistrar && related?.href) {
    try { registrar = await ctx.fetchJSON(related.href, accept); } catch { /* best-effort */ }
  }
  const registrarEntity = findRole(registry, 'registrar') || findRole(registrar, 'registrar');
  const reg = vcard(registrarEntity);
  const registrantEntity = findRole(registrar, 'registrant') || findRole(registry, 'registrant');
  return {
    source: 'RDAP',
    handle: registry.handle,
    created: eventDate(registry, 'registration') || eventDate(registrar, 'registration'),
    updated: eventDate(registry, 'last changed') || eventDate(registrar, 'last changed'),
    expires: eventDate(registry, 'expiration') || eventDate(registrar, 'expiration') || eventDate(registrar, 'registrar expiration'),
    status: [...new Set([...(registry.status || []), ...(registrar?.status || [])])],
    nameservers: (registry.nameservers || []).map((n) => String(n.ldhName || '').toLowerCase()).filter(Boolean),
    dnssec: registry.secureDNS?.delegationSigned ?? null,
    registrar: {
      name: reg.name || reg.org || registrarEntity?.handle,
      ianaId: registrarEntity?.publicIds?.find((p) => /iana/i.test(p.type))?.identifier,
    },
    abuse: vcard(findRole(registrarEntity, 'abuse') || findRole(registrar, 'abuse')),
    registrant: registrantEntity ? vcard(registrantEntity) : null,
    sources: [`${base}/domain/${domain}`, registrar ? related.href : null].filter(Boolean),
  };
}

/* ------------------------------------------- HTTP WHOIS service (who-dat) */

async function fromService(ctx, domain) {
  const base = String(ctx.options.whoisService || '').replace(/\/$/, '');
  if (!base) return null;
  const url = `${base}/v1/whois/${encodeURIComponent(domain)}`;
  const r = await ctx.fetch(url, { headers: { accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`WHOIS service: ${j.error?.message || `HTTP ${r.status}`}`);
  const c = j.contacts?.registrant || {};
  const a = c.address || {};
  return {
    source: `${j.meta?.source === 'rdap' ? 'RDAP' : 'WHOIS'} via ${new URL(base).host}${j.meta?.server ? ` (${j.meta.server})` : ''}`,
    handle: j.id || undefined,
    registered: j.isRegistered,
    created: j.dates?.created || undefined,
    updated: j.dates?.updated || undefined,
    expires: j.dates?.expires || undefined,
    status: j.status || [],
    nameservers: (j.nameservers || []).map((n) => String(n.name || '').toLowerCase()).filter(Boolean),
    dnssec: j.dnssec ? !!j.dnssec.signed : null,
    registrar: { name: j.registrar?.name || undefined, ianaId: j.registrar?.ianaId || undefined, url: j.registrar?.url || undefined },
    abuse: { email: j.registrar?.abuseEmail || undefined, tel: j.registrar?.abusePhone || undefined },
    registrant: c.redacted ? null : {
      name: clean(c.name), org: clean(c.organization), email: clean(c.email), tel: clean(c.phone),
      address: clean([a.street, a.city, a.state, a.postalCode].filter(Boolean).join(', ')), country: a.country || undefined,
    },
    sources: [url],
  };
}

/* ------------------------------------------- raw WHOIS text (port 43, CLI) */

/** Best-effort parser for the many WHOIS text dialects (key: value lines and indented blocks). */
export function parseWhoisText(text) {
  const fields = [];
  let block = null;      // the field indented lines attach to
  for (const raw of String(text).split(/\r?\n/)) {
    if (/^\s*(%|#|>>>|NOTICE|TERMS)/i.test(raw)) continue;
    if (!raw.trim()) { if (block?.values.length) block = null; continue; }
    const indented = /^\s/.test(raw);
    const kv = raw.match(/^\s*([A-Za-z][\w ./()'-]{1,60}?)\s*:\s*(.*)$/);
    // "Registrant:" opens a header block; indented lines below it are its values.
    if (indented && block && block.header) { block.values.push(raw.trim()); continue; }
    if (kv && !/^https?$/i.test(kv[1])) {
      block = { key: kv[1].trim(), values: kv[2].trim() ? [kv[2].trim()] : [], header: !kv[2].trim() };
      fields.push(block);
    } else if (indented && block) {
      block.values.push(raw.trim());
    }
  }
  const all = (re) => fields.filter((f) => re.test(f.key)).flatMap((f) => f.values).filter(Boolean);
  const first = (re) => all(re)[0];
  const registrantBlock = fields.find((f) => /^registrant$/i.test(f.key))?.values || [];
  return {
    source: 'WHOIS',
    created: iso(first(/creat|registered on|registration (date|time)|activated/i)),
    updated: iso(first(/updated|last.?modified|changed/i)),
    expires: iso(first(/expir|paid-till|renewal date/i)),
    status: [...new Set(all(/^(domain )?status$/i).map((s) => s.split(/\s+/)[0]))],
    nameservers: [...new Set(all(/name ?servers?|nserver/i).map((s) => s.split(/\s+/)[0].toLowerCase()).filter((s) => s.includes('.')))],
    dnssec: (() => { const d = first(/dnssec/i); return d ? /signed|yes/i.test(d) && !/unsigned/i.test(d) : null; })(),
    registrar: { name: first(/^(sponsoring )?registrar( name)?$/i), ianaId: first(/registrar iana id/i) },
    abuse: { email: first(/abuse.*email/i), tel: first(/abuse.*phone/i) },
    registrant: (() => {
      const org = clean(first(/registrant organi[sz]ation/i) || registrantBlock[0]);
      const name = clean(first(/registrant name/i));
      const country = first(/registrant country/i) || (registrantBlock.length > 1 ? registrantBlock.at(-1) : undefined);
      return org || name ? { org, name, address: clean(registrantBlock.slice(1, -1).join(', ')) || undefined, country } : null;
    })(),
    raw: String(text).slice(0, 6000),
  };
}

async function fromPort43(ctx, domain) {
  if (typeof ctx.whois !== 'function') return null;
  const { text, server } = await ctx.whois(domain);
  return { ...parseWhoisText(text), source: `WHOIS (${server})`, sources: [`whois://${server}/${domain}`] };
}

/* ------------------------------------------------------------------ run */

function age(days) {
  if (days == null || isNaN(days)) return '';
  return days >= 365 ? `${(days / 365).toFixed(1)} years` : `${days} days`;
}

async function run(reading, ctx) {
  const domain = ctx.target.domain;
  if (!domain || ctx.util.isIP(domain) || !domain.includes('.')) ctx.skip('no registrable domain');
  const tld = domain.split('.').pop();
  // RDAP first; any failure (no service for the TLD, rate limit, outage) falls through to WHOIS.
  const tried = [];
  const attempt = (label, fn) => fn().then((d) => { if (!d) tried.push(`${label}: no data`); return d; },
    (e) => { tried.push(`${label}: ${e.message}`); return null; });
  let d = await attempt('RDAP', async () => {
    const r = await fromRdap(ctx, domain);
    if (!r) throw new Error(`no RDAP service for .${tld}`);
    return r;
  });
  if (!d && ctx.whois) d = await attempt('port 43', () => fromPort43(ctx, domain));
  if (!d && ctx.options.whoisService) d = await attempt('WHOIS service', () => fromService(ctx, domain));
  if (!d) throw new Error(`No registration data for ${domain} (${tried.join('; ')}). Set a WHOIS service in Options or use the CLI.`);

  const ageDays = d.created ? daysBetween(d.created) : null;
  const daysLeft = d.expires ? -daysBetween(d.expires) : null;
  const findings = [];
  const add = (severity, category, title, detail) => findings.push({ severity, category, title, detail });
  if (daysLeft != null) {
    if (daysLeft < 0) add('high', 'infrastructure', 'Domain registration has expired', d.expires);
    else if (daysLeft < 30) add('high', 'infrastructure', `Domain expires in ${daysLeft} days`, d.expires);
    else if (daysLeft < 60) add('medium', 'infrastructure', `Domain expires in ${daysLeft} days`, d.expires);
  }
  if (ageDays != null && ageDays < 30) add('high', 'security', `Newly registered domain (${ageDays} days old)`, 'New domains are a common phishing signal.');
  else if (ageDays != null && ageDays < 180) add('low', 'intel', `Young domain (${ageDays} days old)`);
  if (d.status.some((s) => /hold/i.test(s))) add('high', 'infrastructure', 'Domain is on hold (will not resolve)', d.status.join(', '));
  // Restricted registries (.edu, .gov, many ccTLDs) don't use EPP transfer locks — only judge when EPP statuses exist.
  if (d.status.some((s) => /prohibited|^ok$|active/i.test(s)) && !d.status.some((s) => /transfer ?prohibited/i.test(s)) && /RDAP/.test(d.source)) {
    add('low', 'security', 'Domain is not transfer-locked', d.status.join(', '));
  }

  const who = d.registrant && (d.registrant.org || d.registrant.name);
  const country = d.registrant?.country;
  return {
    data: { domain, ...d, ageDays, daysLeft },
    findings,
    summary: [
      { label: 'Registrar', value: d.registrar?.name || (tld === 'edu' ? 'EDUCAUSE (registry)' : '') },
      { label: 'Registered', headline: true, value: d.created ? `${d.created.slice(0, 10)} (${age(ageDays)})` : '' },
      { label: 'Expires', value: d.expires ? `${d.expires.slice(0, 10)} (in ${age(daysLeft)})` : '' },
      { label: 'Registrant', value: who ? `${who}${country ? `, ${country}` : ''}` : country ? `redacted (${country})` : 'redacted' },
      { label: 'Status', value: d.status.join(', ') },
      { label: 'Source', value: d.source },
    ],
  };
}

/**
 * Answer first (domain age, time to expiry, registrar), then the rest of the record. The glance's timeline draws the
 * registration and expiry years; the stats give the exact dates. Raw WHOIS text is a dump, closed.
 */
function render(r, h) {
  const d = r.data || {};
  const status = Array.isArray(d.status) ? d.status : [];
  const day = (x) => (x ? String(x).slice(0, 10) : '');
  const left = d.daysLeft == null || isNaN(d.daysLeft) ? '' : d.daysLeft < 0 ? 'expired' : age(d.daysLeft);
  return h.html`${h.stats([
    d.created ? h.stat({ label: 'Domain age', value: age(d.ageDays) || '—', note: `registered ${day(d.created)}` }) : '',
    d.expires ? h.stat({ label: 'Expires in', value: left || '—', note: day(d.expires) }) : '',
    h.stat({ label: 'Registrar', value: d.registrar?.name || 'unknown', note: d.registrar?.ianaId ? `IANA #${d.registrar.ianaId}` : '' }),
  ])}
    ${h.kv([
    ['Domain', d.domain], ['Source', d.source], ['Updated', d.updated],
    ['Status', h.tags(status)], ['Nameservers', (d.nameservers || []).join(', ')],
    ['DNSSEC delegation', d.dnssec == null ? '' : d.dnssec ? 'signed' : 'unsigned'],
    ['Abuse contact', [d.abuse?.email, d.abuse?.tel].filter(Boolean).join(' · ')],
    ['Sources', h.list((d.sources || []).map((s) => h.link(s)))],
  ])}
    ${d.registrant ? h.sub('Registrant', h.kv(Object.entries(d.registrant))) : h.html`<p class="note">Registrant details are redacted or not published.</p>`}
    ${d.raw ? h.more('Raw WHOIS', h.html`<pre class="json">${d.raw}</pre>`) : ''}
  `;
}

function glance(r, h) {
  const d = r.data || {};
  if (!d.created || !d.expires) return '';
  const year = (x) => String(x).slice(0, 4);
  return h.html`<section class="card"><h4>Domain lifetime</h4>${h.timeline({
    start: d.created, end: d.expires, startLabel: `Registered ${year(d.created)}`, endLabel: `Expires ${year(d.expires)}`, label: 'Domain registration',
  })}</section>`;
}

export default {
  id: 'whois',
  group: 'infrastructure',
  name: 'WHOIS (RDAP)',
  version: '0.2.1',
  phase: 'enrich',
  description: 'Registrar, registration and expiry dates, status, nameservers and registrant — RDAP, falling back to WHOIS.',
  disclosure: 'Sends the registrable domain to rdap.org and the registry/registrar RDAP servers; for TLDs without RDAP, to your WHOIS service (who-dat.as93.net by default).',
  tags: ['intel', 'infrastructure'],
  options: [
    { key: 'endpoint', label: 'RDAP bootstrap service', type: 'text', default: 'https://rdap.org' },
    { key: 'followRegistrar', label: 'Also query the registrar\'s RDAP server', type: 'checkbox', default: true },
    { key: 'whoisService', label: 'WHOIS fallback service (who-dat API; empty = off)', type: 'text', default: 'https://who-dat.as93.net' },
  ],
  timeoutMs: 30_000,
  run,
  render,
  glance,
};
