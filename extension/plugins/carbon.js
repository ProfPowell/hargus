// Carbon: estimated CO₂ per page view with the Sustainable Web Design Model v4, from the bytes each
// host served in this reading, with a Green Web Foundation check for green hosting. First visit with an
// empty cache (readings bypass the cache) and the global average grid — the conservative figure.

export const SWDM = { dc: { op: 0.055, emb: 0.012 }, net: { op: 0.059, emb: 0.013 }, dev: { op: 0.080, emb: 0.081 } }; // kWh/GB
export const GRID = 494; // gCO2e/kWh, global average (Ember 2022)
export const RATINGS = [['A+', 0.040], ['A', 0.079], ['B', 0.145], ['C', 0.209], ['D', 0.278], ['E', 0.359]];
export const ENDPOINT = 'https://api.thegreenwebfoundation.org/api/v3/greencheck/';
const MAX_HOSTS = 25;
const PARALLEL = 4;

export const rate = (grams) => (RATINGS.find(([, max]) => grams <= max) || ['F'])[0];
const ratingOf = (r) => (['A+', 'A', 'B'].includes(r) ? 'good' : ['C', 'D'].includes(r) ? 'needs-improvement' : 'poor');

/** hosts: [{ host, bytes, green }] → grams per view, rating, per-segment and per-host grams. */
export function estimate(hosts) {
  const segments = { dataCentre: 0, network: 0, device: 0 };
  const out = hosts.map((x) => {
    const gb = (x.bytes || 0) / 1e9;
    const dc = gb * ((x.green === true ? 0 : SWDM.dc.op) + SWDM.dc.emb) * GRID;
    const net = gb * (SWDM.net.op + SWDM.net.emb) * GRID;
    const dev = gb * (SWDM.dev.op + SWDM.dev.emb) * GRID;
    segments.dataCentre += dc;
    segments.network += net;
    segments.device += dev;
    return { ...x, grams: dc + net + dev };
  });
  const grams = segments.dataCentre + segments.network + segments.device;
  return { grams, rating: rate(grams), segments, hosts: out };
}

async function run(reading, ctx) {
  const { hostOf, transferSize, isIP } = ctx.util;
  const bytes = new Map();
  for (const e of reading.log.entries) {
    const host = hostOf(e.request.url);
    if (host) bytes.set(host, (bytes.get(host) || 0) + transferSize(e));
  }
  if (!bytes.size) ctx.skip('no requests in this reading');
  const hosts = [...bytes].map(([host, b]) => ({ host, bytes: b, green: null, hostedBy: null })).sort((a, b) => b.bytes - a.bytes);
  if (ctx.options.greenCheck !== false) {
    const base = ctx.options.endpoint || ENDPOINT;
    const queue = hosts.slice(0, MAX_HOSTS).filter((x) => !isIP(x.host));
    const worker = async () => {
      for (let x = queue.shift(); x; x = queue.shift()) {
        try {
          const j = await ctx.fetchJSON(base + encodeURIComponent(x.host));
          x.green = j?.green === true;
          x.hostedBy = j?.hosted_by || null;
        } catch {
          x.green = null;
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  }
  const est = estimate(hosts);
  const g = est.grams;
  const findings = [];
  const severity = { C: 'low', D: 'medium', E: 'medium', F: 'high' }[est.rating];
  if (severity) {
    findings.push({ severity, category: 'sustainability', title: `Carbon rating ${est.rating} (${g.toFixed(2)} g CO₂ per visit)`, detail: 'Sustainable Web Design Model v4 — first visit with an empty cache, global average grid.' });
  }
  const main = est.hosts.find((x) => x.host === ctx.target.host);
  if (main?.green === false) {
    findings.push({ severity: 'low', category: 'sustainability', title: "Main site isn't on green hosting", detail: `${main.host} is not listed by the Green Web Foundation.` });
  }
  const checked = est.hosts.filter((x) => x.green !== null);
  return {
    data: { model: 'SWDM v4', gridIntensity: GRID, grams: g, rating: est.rating, segments: est.segments, hosts: est.hosts, assumptions: 'first visit, no cache, global grid average' },
    findings,
    summary: [
      { label: 'CO₂ per visit', value: `${g.toFixed(2)} g · rating ${est.rating}`, rating: ratingOf(est.rating), headline: true },
      { label: 'Green hosting', value: `${checked.filter((x) => x.green).length} of ${checked.length} hosts`, headline: true },
    ],
  };
}

function glance(r, h) {
  const d = r.data;
  const s = d.segments;
  const year = (d.grams * 10000 * 12) / 1000;
  return h.html`<div class="tiles">
    ${h.stat({ label: 'CO₂ per visit', value: `${d.grams.toFixed(2)} g`, rating: ratingOf(d.rating), note: `rating ${d.rating} · first visit · global grid average` })}
    ${h.stat({ label: '10,000 visits a month', value: `≈ ${year.toFixed(1)} kg`, note: 'CO₂ per year' })}
  </div>
  <div class="glance-grid">
    <section class="card"><h4>Where the emissions come from</h4>${h.donut({ label: 'Emissions by segment', center: { value: d.grams.toFixed(2), unit: 'g' }, segments: [
      { label: 'Data centres', value: s.dataCentre, display: `${s.dataCentre.toFixed(3)} g` },
      { label: 'Networks', value: s.network, display: `${s.network.toFixed(3)} g` },
      { label: 'Devices', value: s.device, display: `${s.device.toFixed(3)} g` },
    ] })}</section>
    <section class="card"><h4>Green hosting</h4>${h.checklist(d.hosts.slice(0, 8).map((x) => ({
      label: `${x.host} · ${h.bytes(x.bytes)}`, ok: x.green, note: x.green === null ? 'unknown' : x.hostedBy || '',
    })))}</section>
  </div>`;
}

function render(r, h) {
  return h.html`<p class="note">${r.data.model} · ${r.data.gridIntensity} g/kWh · ${r.data.assumptions}</p>${h.table(r.data.hosts.map((x) => ({
    host: x.host, bytes: h.bytes(x.bytes), grams: x.grams.toFixed(4), green: x.green === null ? 'unknown' : x.green ? 'yes' : 'no', hostedBy: x.hostedBy || '',
  })), [{ key: 'host', label: 'Host' }, { key: 'bytes', label: 'Bytes' }, { key: 'grams', label: 'g CO₂' }, { key: 'green', label: 'Green' }, { key: 'hostedBy', label: 'Hosted by' }])}`;
}

export default {
  id: 'carbon',
  name: 'Carbon',
  version: '0.1.0',
  phase: 'enrich',
  area: 'sustainability',
  group: 'other',
  description: 'Estimated CO₂ per page view (Sustainable Web Design Model v4) with a green-hosting check per host.',
  disclosure: 'Sends each hostname to api.thegreenwebfoundation.org to check for green hosting.',
  tags: ['sustainability'],
  options: [
    { key: 'greenCheck', label: 'Check green hosting', type: 'checkbox', default: true },
    { key: 'endpoint', label: 'Green check endpoint', type: 'text', default: ENDPOINT },
  ],
  run,
  render,
  glance,
};
