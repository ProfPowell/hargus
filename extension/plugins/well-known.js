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
  const [robotsR, secR, secAltR, sitemapR, adsR, llmsR, humansR, aasaR, assetR, faviconR, manifestR] = await Promise.all([
    get(ctx, at('/robots.txt')), get(ctx, at('/.well-known/security.txt')), get(ctx, at('/security.txt')),
    get(ctx, at('/sitemap.xml'), 500_000), get(ctx, at('/ads.txt')), get(ctx, at('/llms.txt')),
    get(ctx, at('/humans.txt')), get(ctx, at('/.well-known/apple-app-site-association')),
    get(ctx, at('/.well-known/assetlinks.json')), get(ctx, at('/favicon.ico')),
    manifestUrl ? get(ctx, manifestUrl) : Promise.resolve(null),
  ]);
  if ([robotsR, secR, sitemapR, faviconR].every((r) => r.error)) throw new Error(`site unreachable — ${robotsR.error}`);

  const robots = isText(robotsR) ? parseRobots(robotsR.text) : null;
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
  else if (robots.everyone === 'blocked') add('medium', 'seo', 'robots.txt blocks all crawlers (Disallow: /)');
  if (!security) add('low', 'security', 'No security.txt (RFC 9116) — no published vulnerability contact');
  else if (security.expires && new Date(security.expires) < new Date()) add('low', 'security', 'security.txt has expired', security.expires);
  if (!sitemap) add('low', 'seo', 'No XML sitemap found');
  const blockedAi = robots ? Object.entries(robots.aiBots).filter(([, v]) => v.status === 'blocked' && v.explicit).map(([k]) => k) : [];
  if (blockedAi.length) add('info', 'intel', `robots.txt blocks ${blockedAi.length} AI crawlers`, blockedAi.join(', '));
  if (llms) add('info', 'intel', 'Publishes llms.txt for AI agents');
  if (iosApps.length || androidApps.length) add('info', 'intel', 'Associated mobile apps', [...iosApps, ...androidApps].join(', '));
  if (ads?.systems.length) add('info', 'intel', `Sells ads programmatically through ${ads.systems.length} ad systems (ads.txt)`);

  const yes = (v, extra = '') => (v ? `yes${extra}` : 'no');
  return {
    data: { origin, robots, security, sitemap, ads, llms, humans, iosApps, androidApps, favicon, manifest },
    findings,
    summary: [
      { label: 'robots.txt', value: robots ? `${robots.rules} rules · ${robots.sitemaps.length} sitemaps · crawlers ${robots.everyone}` : 'missing' },
      { label: 'AI crawlers', value: robots ? (blockedAi.length ? `blocks ${blockedAi.slice(0, 6).join(', ')}${blockedAi.length > 6 ? '…' : ''}` : 'not specifically blocked') : '' },
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
    ${ai.length ? h.sub('AI crawler policy', h.table(ai, ['bot', 'status', 'rule'])) : ''}
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