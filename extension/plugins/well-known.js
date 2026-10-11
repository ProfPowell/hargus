// Well-known files on the site itself: robots.txt (incl. AI-crawler policy), security.txt,
// sitemap, ads.txt, llms.txt, humans.txt, mobile app associations, web app manifest, favicon.

const AI_BOTS = ['GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai',
  'CCBot', 'Google-Extended', 'PerplexityBot', 'Perplexity-User', 'Bytespider', 'Applebot-Extended',
  'Meta-ExternalAgent', 'Amazonbot', 'cohere-ai', 'Diffbot', 'DuckAssistBot', 'MistralAI-User'];

async function get(ctx, url, maxBytes = 200_000) {
  try {
    const r = await ctx.fetch(url, { redirect: 'follow', headers: { accept: '*/*' } });
    const type = r.headers.get('content-type') || '';
    const text = r.ok && !/^image\//.test(type) ? (await r.text()).slice(0, maxBytes) : '';
    return { url, finalUrl: r.url, status: r.status, ok: r.ok, type, text, size: Number(r.headers.get('content-length')) || text.length };
  } catch (e) {
    return { url, error: String(e.message || e), ok: false };
  }
}

// Treat HTML answers to text/xml/json requests as "soft 404s".
const isText = (res) => res.ok && !/html/i.test(res.type) && !/^\s*</.test(res.text);
const isXml = (res) => res.ok && (/xml/i.test(res.type) || /^\s*<\?xml|<(urlset|sitemapindex)/i.test(res.text));
const json = (res) => {
  if (!res.ok || /html/i.test(res.type)) return null;
  try { return JSON.parse(res.text); } catch { return null; }
};

export function parseRobots(text) {
  const groups = [];
  let current = null;
  const sitemaps = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
    } else if (key === 'allow' || key === 'disallow') {
      current?.rules.push({ type: key, path: value });
    } else if (key === 'sitemap') sitemaps.push(value);
  }
  const groupFor = (ua) => groups.find((g) => g.agents.includes(ua.toLowerCase())) || groups.find((g) => g.agents.includes('*'));
  const statusFor = (ua) => {
    const g = groupFor(ua);
    if (!g) return 'allowed';
    const blockAll = g.rules.some((r) => r.type === 'disallow' && r.path === '/');
    const allowRoot = g.rules.some((r) => r.type === 'allow' && r.path === '/');
    if (blockAll && !allowRoot) return 'blocked';
    return g.rules.some((r) => r.type === 'disallow' && r.path) ? 'partial' : 'allowed';
  };
  return {
    groups: groups.length,
    rules: groups.reduce((n, g) => n + g.rules.length, 0),
    sitemaps,
    everyone: statusFor('*'),
    aiBots: Object.fromEntries(AI_BOTS.map((b) => [b, { status: statusFor(b), explicit: groups.some((g) => g.agents.includes(b.toLowerCase())) }])),
  };
}

export const CRAWLERS = [['Googlebot', 'googlebot'], ['Bingbot', 'bingbot'], ['GPTBot', 'gptbot'], ['ClaudeBot', 'claudebot'],
  ['Google-Extended', 'google-extended'], ['CCBot', 'ccbot'], ['PerplexityBot', 'perplexitybot'], ['Applebot-Extended', 'applebot-extended']];
const AI_TOKENS = new Set(CRAWLERS.slice(2).map((c) => c[1]));
const KNOWN_DIRECTIVES = new Set(['user-agent', 'allow', 'disallow', 'sitemap', 'crawl-delay', 'host', 'noindex']);

/** Google-compatible robots.txt parse: groups (agents + rules), sitemaps, and directives Google ignores. */
export function parseRobotsFile(text = '') {
  const groups = [];
  let cur = null;
  const unknown = new Set();
  const sitemaps = [];
  let crawlDelay = null;
  let noindex = 0;
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (!KNOWN_DIRECTIVES.has(key)) { unknown.add(m[1]); continue; }
    if (key === 'user-agent') {
      if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase().replace(/\/.*$/, '').trim());
    } else if (key === 'allow' || key === 'disallow') cur?.rules.push({ type: key, path: value });
    else if (key === 'sitemap') sitemaps.push(value);
    else if (key === 'crawl-delay') crawlDelay = value;
    else if (key === 'noindex') noindex++;
  }
  const seen = new Map();
  for (const g of groups) for (const a of new Set(g.agents)) seen.set(a, (seen.get(a) || 0) + 1);
  return { groups, sitemaps, unknown: [...unknown], crawlDelay, noindex, duplicates: [...seen].filter(([, n]) => n > 1).map(([a]) => a) };
}

/** The rules that apply to a crawler token: the longest matching agent token (groups merged), else '*', else null. */
export function groupFor(groups = [], token = '') {
  const t = String(token).toLowerCase();
  const pick = groups.some((g) => g.agents.includes(t)) ? t : groups.some((g) => g.agents.includes('*')) ? '*' : null;
  if (pick == null) return null;
  return { agents: [pick], rules: groups.filter((g) => g.agents.includes(pick)).flatMap((g) => g.rules) };
}

/** Normalise percent-encoding so rules and paths compare equal: upper-case escapes, UTF-8 encode non-ASCII, decode unreserved. */
function normPath(s) {
  return String(s).replace(/%[0-9a-f]{2}|[^\x00-\x7f]/gi, (m) => {
    if (m[0] !== '%') { try { return encodeURIComponent(m); } catch { return m; } }
    const c = String.fromCharCode(parseInt(m.slice(1), 16));
    return /[A-Za-z0-9\-._~]/.test(c) ? c : m.toUpperCase();
  });
}

function patternRe(p) {
  const anchored = p.endsWith('$');
  const body = (anchored ? p.slice(0, -1) : p).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** Google's rule: longest matching pattern wins; allow wins ties; empty disallow matches nothing. */
export function robotsAllowed(group, path) {
  if (!group) return { allowed: true, rule: null };
  path = normPath(path);
  let best = null;
  for (const r of group.rules) {
    if (!r.path || !patternRe(normPath(r.path)).test(path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.type === 'allow')) best = r;
  }
  return { allowed: !best || best.type === 'allow', rule: best ? `${best.type === 'allow' ? 'Allow' : 'Disallow'}: ${best.path}` : null };
}

const XR_DIRECTIVE = /^(noindex|nofollow|none|all|noarchive|nocache|nosnippet|max-snippet|max-image-preview|max-video-preview|unavailable_after|noimageindex|notranslate|indexifembedded)$/i;
/** X-Robots-Tag header values → directives for everyone, and per named user agent. */
export function xRobots(values = []) {
  const out = { all: [], byAgent: {} };
  const split = (s) => String(s).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const v of values) {
    const m = String(v).match(/^\s*([a-z][\w-]*)\s*:\s*(.+)$/i);
    if (m && !XR_DIRECTIVE.test(m[1])) (out.byAgent[m[1].toLowerCase()] ||= []).push(...split(m[2]));
    else out.all.push(...split(v));
  }
  return out;
}

function parseSecurityTxt(text) {
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([\w-]+):\s*(.+)$/);
    if (m) (fields[m[1].toLowerCase()] ||= []).push(m[2].trim());
  }
  return {
    contact: fields.contact || [], expires: fields.expires?.[0], policy: fields.policy?.[0],
    encryption: fields.encryption?.[0], hiring: fields.hiring?.[0], languages: fields['preferred-languages']?.[0],
    signed: /BEGIN PGP SIGNED MESSAGE/.test(text),
  };
}

function parseAdsTxt(text) {
  const systems = new Map();
  let direct = 0; let reseller = 0;
  const vars = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const v = line.match(/^(\w+)=(.+)$/);
    if (v) { vars[v[1].toLowerCase()] = v[2].trim(); continue; }
    const [system, , rel] = line.split(',').map((s) => s.trim());
    if (!system) continue;
    systems.set(system.toLowerCase(), (systems.get(system.toLowerCase()) || 0) + 1);
    if (/direct/i.test(rel)) direct++; else if (/reseller/i.test(rel)) reseller++;
  }
  return { systems: [...systems].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })), direct, reseller, vars };
}

async function run(reading, ctx) {
  const origin = ctx.target.origin;
  if (!/^https?:/.test(origin || '')) ctx.skip('target has no http(s) origin');
  const at = (p) => `${origin}${p}`;
  const manifestUrl = ctx.results.meta?.data?.manifest;
  const [robotsR, secR, secAltR, sitemapR, adsR, llmsR, humansR, aasaR, assetR, faviconR, manifestR, aiR] = await Promise.all([
    get(ctx, at('/robots.txt')), get(ctx, at('/.well-known/security.txt')), get(ctx, at('/security.txt')),
    get(ctx, at('/sitemap.xml'), 500_000), get(ctx, at('/ads.txt')), get(ctx, at('/llms.txt')),
    get(ctx, at('/humans.txt')), get(ctx, at('/.well-known/apple-app-site-association')),
    get(ctx, at('/.well-known/assetlinks.json')), get(ctx, at('/favicon.ico')),
    manifestUrl ? get(ctx, manifestUrl) : Promise.resolve(null),
    get(ctx, at('/ai.txt')),
  ]);
  if ([robotsR, secR, sitemapR, faviconR].every((r) => r.error)) throw new Error(`site unreachable — ${robotsR.error}`);

  const robots = isText(robotsR) ? parseRobots(robotsR.text) : null;
  const aiTxt = isText(aiR) ? { bytes: aiR.text.length } : null;
  const file = isText(robotsR) ? parseRobotsFile(robotsR.text) : null;
  let path = '/';
  try { const u = new URL(ctx.target.finalUrl || ctx.target.url || origin); path = u.pathname + u.search; } catch { /* keep / */ }
  const doc = ctx.util?.mainEntry?.(reading);
  const headerVals = (doc?.response?.headers || []).filter((x) => /^x-robots-tag$/i.test(x.name)).map((x) => x.value);
  const xr = xRobots(headerVals);
  const metaD = ctx.results?.meta?.data || {};
  const noindexIn = (list = []) => list.some((d) => d === 'noindex' || d === 'none');
  const metaNoindex = (v) => noindexIn(String(v || '').toLowerCase().split(/[\s,]+/));
  const indexing = CRAWLERS.map(([name, token]) => {
    const v = file ? robotsAllowed(groupFor(file.groups, token), path) : { allowed: true, rule: null };
    let indexSource = null;
    if (metaNoindex(metaD.robots)) indexSource = 'meta robots';
    else if (token === 'googlebot' && metaNoindex(metaD.googlebot)) indexSource = 'meta googlebot';
    else if (noindexIn(xr.all) || noindexIn(xr.byAgent[token])) indexSource = 'X-Robots-Tag';
    return { name, token, crawl: v.allowed, rule: v.rule, index: !indexSource, indexSource };
  });
  // The generic (*) verdict for this page decides the site-wide finding, whatever named crawlers are allowed.
  const generic = file ? robotsAllowed(groupFor(file.groups, '*'), path) : { allowed: true, rule: null };
  const secSrc = isText(secR) ? secR : isText(secAltR) ? secAltR : null;
  const security = secSrc ? { ...parseSecurityTxt(secSrc.text), url: secSrc.finalUrl } : null;

  let sitemapRes = isXml(sitemapR) ? sitemapR : null;
  if (!sitemapRes && robots?.sitemaps[0] && !/\.gz$/i.test(robots.sitemaps[0])) {
    const alt = await get(ctx, robots.sitemaps[0], 500_000);
    if (isXml(alt)) sitemapRes = alt;
  }
  const sitemap = sitemapRes ? {
    url: sitemapRes.finalUrl,
    urls: (sitemapRes.text.match(/<url>/gi) || []).length,
    sitemaps: (sitemapRes.text.match(/<sitemap>/gi) || []).length,
    truncated: sitemapRes.text.length >= 500_000,
  } : null;

  const ads = isText(adsR) ? parseAdsTxt(adsR.text) : null;
  const llms = isText(llmsR) ? {
    bytes: llmsR.text.length,
    title: (llmsR.text.match(/^#\s+(.+)$/m) || [])[1],
    links: (llmsR.text.match(/\]\(https?:[^)]+\)/g) || []).length,
  } : null;
  const humans = isText(humansR) ? humansR.text.slice(0, 600) : null;
  const aasa = json(aasaR);
  const iosApps = aasa ? [...new Set([
    ...(aasa.applinks?.details || []).flatMap((d) => [].concat(d.appIDs || d.appID || [])),
    ...(aasa.webcredentials?.apps || []),
  ])] : [];
  const assetlinks = json(assetR);
  const androidApps = Array.isArray(assetlinks) ? [...new Set(assetlinks.map((x) => x.target?.package_name).filter(Boolean))] : [];
  const favicon = faviconR.ok && /image|icon|octet/i.test(faviconR.type) ? { type: faviconR.type, url: faviconR.finalUrl } : null;
  const mj = manifestR && json(manifestR);
  const manifest = mj ? {
    url: manifestUrl, name: mj.name, shortName: mj.short_name, display: mj.display, startUrl: mj.start_url,
    themeColor: mj.theme_color, icons: (mj.icons || []).length, id: mj.id,
  } : null;

  const findings = [];
  const add = (severity, category, title, detail) => findings.push({ severity, category, title, detail });
  if (!robots) add('low', 'seo', 'No robots.txt');
  else if (robots.everyone === 'blocked') {
    // A more specific Allow (e.g. Allow: /$ for the homepage) can still let crawlers reach this page.
    if (generic.allowed) add('low', 'seo', 'robots.txt blocks crawlers from most of the site (Disallow: /), but allows this page', generic.rule);
    else add('medium', 'seo', 'robots.txt blocks all crawlers (Disallow: /)');
  }
  if (!security) add('low', 'security', 'No security.txt (RFC 9116) — no published vulnerability contact');
  else if (security.expires && new Date(security.expires) < new Date()) add('low', 'security', 'security.txt has expired', security.expires);
  if (!sitemap) add('low', 'seo', 'No XML sitemap found');
  // Only a page blocked for every crawler (*) folds the per-crawler Disallow: / rows into the site-wide finding.
  const siteBlocked = robots?.everyone === 'blocked' && !generic.allowed;
  for (const r of indexing.filter((x) => (x.token === 'googlebot' || x.token === 'bingbot') && !x.crawl && !(siteBlocked && x.rule === 'Disallow: /'))) add('medium', 'seo', `This page is blocked for ${r.name} by robots.txt`, r.rule);
  const metaSaysNoindex = metaNoindex(metaD.robots) || metaNoindex(metaD.googlebot);
  if (!metaSaysNoindex && (noindexIn(xr.all) || noindexIn(xr.byAgent.googlebot))) add('medium', 'seo', 'X-Robots-Tag header asks search engines not to index this page');
  if (file?.noindex) add('low', 'seo', 'robots.txt uses noindex, which search engines ignore');
  if (file?.crawlDelay != null) add('info', 'seo', 'robots.txt sets crawl-delay (Google ignores it)');
  if (file?.unknown.length) add('info', 'seo', `robots.txt has ${file.unknown.length} unrecognised directives`, file.unknown.join(', '));
  if (file?.duplicates.length) add('info', 'seo', `robots.txt lists ${file.duplicates.join(', ')} in more than one group`);
  const aiBlocked = indexing.filter((r) => AI_TOKENS.has(r.token) && !r.crawl);
  const aiRow = robots || file ? `${aiBlocked.length} of ${AI_TOKENS.size} blocked from this page` : '';
  if (aiBlocked.length) add('info', 'intel', `robots.txt blocks ${aiBlocked.length} AI crawlers from this page`, aiBlocked.map((r) => r.name).join(', '));
  if (aiTxt) add('info', 'intel', 'Publishes ai.txt');
  if (llms) add('info', 'intel', 'Publishes llms.txt for AI agents');
  if (iosApps.length || androidApps.length) add('info', 'intel', 'Associated mobile apps', [...iosApps, ...androidApps].join(', '));
  if (ads?.systems.length) add('info', 'intel', `Sells ads programmatically through ${ads.systems.length} ad systems (ads.txt)`);

  const yes = (v, extra = '') => (v ? `yes${extra}` : 'no');
  return {
    data: { origin, robots, security, sitemap, ads, llms, humans, iosApps, androidApps, favicon, manifest, indexing, aiTxt },
    findings,
    summary: [
      { label: 'robots.txt', value: robots ? `${robots.rules} rules · ${robots.sitemaps.length} sitemaps · crawlers ${robots.everyone}` : 'missing' },
      { label: 'AI crawlers', value: aiRow },
      { label: 'security.txt', value: security ? `${security.contact[0] || 'present'}${security.expires ? ` · expires ${security.expires.slice(0, 10)}` : ''}` : 'missing' },
      { label: 'Sitemap', value: sitemap ? `${sitemap.urls || sitemap.sitemaps} ${sitemap.urls ? 'URLs' : 'child sitemaps'}` : 'missing' },
      { label: 'llms.txt', value: yes(llms, llms?.title ? ` — ${llms.title}` : '') },
      { label: 'ads.txt', value: ads ? `${ads.systems.length} ad systems (${ads.direct} direct, ${ads.reseller} reseller)` : 'none' },
      { label: 'Mobile apps', value: iosApps.length || androidApps.length ? `${iosApps.length} iOS · ${androidApps.length} Android` : '' },
      { label: 'Web app manifest', value: manifest ? `${manifest.name || manifest.shortName || 'unnamed'} · ${manifest.display || 'browser'}` : '' },
    ],
  };
}

function render(r, h) {
  const d = r.data;
  const ai = d.robots ? Object.entries(d.robots.aiBots).map(([bot, v]) => ({ bot, status: v.status, rule: v.explicit ? 'named' : 'via *' })) : [];
  return h.html`
    ${h.kv([
      ['robots.txt', d.robots ? `${d.robots.groups} groups · ${d.robots.rules} rules · everyone: ${d.robots.everyone}` : 'missing'],
      ['Sitemaps (robots)', d.robots?.sitemaps.join(' ')],
      ['Sitemap', d.sitemap ? h.html`${h.link(d.sitemap.url)} — ${d.sitemap.urls} URLs, ${d.sitemap.sitemaps} child sitemaps` : 'missing'],
      ['security.txt', d.security ? h.html`${h.link(d.security.url)} ${d.security.signed ? '(signed)' : ''}` : 'missing'],
      ['Security contact', d.security?.contact.join(', ')], ['Security policy', d.security?.policy],
      ['llms.txt', d.llms ? `${d.llms.title || 'untitled'} · ${d.llms.links} links · ${h.bytes(d.llms.bytes)}` : 'missing'],
      ['Favicon', d.favicon ? d.favicon.type : 'missing'],
      ['Manifest', d.manifest ? `${d.manifest.name || ''} · display ${d.manifest.display || '—'} · ${d.manifest.icons} icons` : ''],
      ['iOS apps', d.iosApps.join(', ')], ['Android apps', d.androidApps.join(', ')],
    ])}
    ${d.indexing?.length ? h.sub('Indexing (this page)', h.table(d.indexing.map((r) => ({
      crawler: r.name, crawl: r.crawl ? 'allowed' : `blocked (${r.rule})`, index: r.index ? 'allowed' : `noindex (${r.indexSource})`,
    })), [{ key: 'crawler', label: 'Crawler' }, { key: 'crawl', label: 'Crawl' }, { key: 'index', label: 'Index' }])) : ''}
    ${ai.length ? h.sub('AI crawler policy (site-wide)', h.table(ai, ['bot', 'status', 'rule'])) : ''}
    ${d.ads?.systems.length ? h.sub('ads.txt systems', h.table(d.ads.systems.slice(0, 30), ['name', 'count'])) : ''}
    ${d.humans ? h.sub('humans.txt', h.html`<pre>${d.humans}</pre>`) : ''}
  `;
}

function glance(r, h) {
  const d = r.data || {};
  return h.html`<section class="card"><h4>Well-known files</h4>${h.checklist([
    { label: 'robots.txt', ok: !!d.robots },
    { label: 'Sitemap', ok: !!d.sitemap },
    { label: 'security.txt', ok: !!d.security },
  ])}</section>`;
}

export default {
  id: 'well-known',
  group: 'infrastructure',
  name: 'Well-known files',
  version: '0.1.0',
  phase: 'enrich',
  after: ['meta'],
  description: 'robots.txt and AI-crawler policy, security.txt, sitemap, ads.txt, llms.txt, app associations, manifest.',
  disclosure: 'Makes about a dozen requests to the site itself (no third parties), without your cookies.',
  tags: ['seo', 'intel', 'security'],
  run,
  render,
  glance,
};
