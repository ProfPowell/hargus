// History and popularity: Internet Archive Wayback Machine captures (first/last seen, how often the
// page changes) and the Tranco top-sites rank (a research-grade popularity list).

async function wayback(ctx, url) {
  const cdx = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&fl=timestamp,statuscode,digest&collapse=timestamp:8`;
  const rows = await ctx.fetchJSON(cdx);
  if (!Array.isArray(rows) || rows.length < 2) return { captures: 0 };
  const data = rows.slice(1);
  const ts = (t) => `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  let changes = 0;
  for (let i = 1; i < data.length; i++) if (data[i][2] !== data[i - 1][2]) changes++;
  const years = {};
  for (const [t] of data) years[t.slice(0, 4)] = (years[t.slice(0, 4)] || 0) + 1;
  return {
    captures: data.length,
    first: ts(data[0][0]),
    last: ts(data.at(-1)[0]),
    changes,
    years,
    firstUrl: `https://web.archive.org/web/${data[0][0]}/${url}`,
    calendar: `https://web.archive.org/web/*/${url}`,
  };
}

// Tranco ranks registrable domains and allows about one query per second, so ask once.
async function tranco(ctx, name) {
  let j;
  try {
    j = await ctx.fetchJSON(`https://tranco-list.eu/api/ranks/domain/${encodeURIComponent(name)}`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
  const ranks = (j.ranks || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!ranks.length) return null;
  const best = Math.min(...ranks.map((x) => x.rank));
  return { domain: name, rank: ranks[0].rank, date: ranks[0].date, best, history: ranks.slice(0, 30) };
}

async function run(reading, ctx) {
  const { host, domain } = ctx.target;
  if (!host || ctx.util.isIP(host) || !host.includes('.')) ctx.skip('needs a public hostname');
  const [wb, rank] = await Promise.allSettled([
    wayback(ctx, host),
    ctx.options.tranco ? tranco(ctx, domain || host) : Promise.resolve(null),
  ]);
  if (wb.status === 'rejected' && rank.status === 'rejected') throw wb.reason;
  const w = wb.status === 'fulfilled' ? wb.value : { error: String(wb.reason?.message || wb.reason) };
  const t = rank.status === 'fulfilled' ? rank.value : { error: String(rank.reason?.message || rank.reason) };
  const ageYears = w.first ? (Date.now() - Date.parse(w.first)) / (365 * 86_400_000) : null;
  const findings = [];
  if (w.first && ageYears < 1) findings.push({ severity: 'info', category: 'intel', title: `First archived ${w.first} — a new site` });
  if (w.captures === 0) findings.push({ severity: 'info', category: 'intel', title: 'Never archived by the Wayback Machine' });
  return {
    data: { wayback: w, tranco: t },
    findings,
    summary: [
      { label: 'Archived since', headline: true, value: w.first ? `${w.first} (${ageYears.toFixed(1)} years)` : w.error ? `error: ${w.error}` : 'never' },
      { label: 'Captures', value: w.captures ? `${w.captures} days · ${w.changes} content changes · last ${w.last}` : '' },
      { label: 'Tranco rank', value: t?.rank ? `#${t.rank.toLocaleString()} (${t.domain}, best #${t.best.toLocaleString()})` : t?.error ? `error: ${t.error}` : ctx.options.tranco ? 'not in the top 1M' : '' },
    ],
  };
}

/** Answer first (first capture, days captured, content changes, Tranco rank), then the links and dates; captures per year closed. */
function render(r, h) {
  const w = r.data?.wayback || {};
  const t = r.data?.tranco;
  const years = Object.entries(w.years || {}).map(([year, captures]) => ({ year, captures }));
  return h.html`${h.stats([
    h.stat({ label: 'First capture', value: w.first ? (w.firstUrl ? h.link(w.firstUrl, w.first) : w.first) : w.error ? 'error' : 'never', note: w.error || '' }),
    h.stat({ label: 'Days captured', value: w.captures ?? 0 }),
    h.stat({ label: 'Content changes', value: w.changes ?? 0 }),
    t?.rank ? h.stat({ label: 'Tranco rank', value: `#${t.rank.toLocaleString()}`, note: `best #${t.best.toLocaleString()}` }) : '',
  ])}
    ${h.sub('Wayback Machine', h.kv([
    ['Last capture', w.last],
    ['All captures', w.calendar ? h.link(w.calendar, 'calendar view') : ''],
  ]))}
    ${h.more('Captures per year', h.table(years, [{ key: 'year', label: 'Year' }, { key: 'captures', label: 'Days captured' }], { fold: false }), String(years.length))}
    ${t?.rank ? h.sub('Tranco', h.kv([['Ranked on', t.date], ['Domain', t.domain], ['List', h.link('https://tranco-list.eu/query', 'tranco-list.eu')]])) : ''}
  `;
}

export default {
  id: 'history',
  group: 'infrastructure',
  name: 'History & popularity',
  version: '0.1.1',
  phase: 'enrich',
  description: 'Wayback Machine first/last capture and change frequency; Tranco top-sites rank.',
  disclosure: 'Sends the hostname to web.archive.org and the domain to tranco-list.eu.',
  tags: ['intel'],
  options: [{ key: 'tranco', label: 'Look up the Tranco rank', type: 'checkbox', default: true }],
  timeoutMs: 45_000,
  run,
  render,
};
