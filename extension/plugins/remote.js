// Remote plugins: any HTTP endpoint can act as a plugin — no rebuild, any language.
// Configure in Options → Remote plugins. Contract (see docs/PLUGINS.md):
//   POST <url>  { harplus, plugin, target, capturedAt, readout, reading? }
//   200 →       { data?, summary?: [{label, value}], findings?: [{severity, category, title, detail?}] }

import { HARPLUS_VERSION, stripForSharing } from '../core/harplus.js';
import { hostOf } from '../core/har-util.js';

const slug = (s = '') => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'remote';

export function remotePlugin(cfg) {
  const id = `remote:${cfg.id || slug(cfg.name || cfg.url)}`;
  const what = { summary: 'the target URL and readout', 'reading-lite': 'the reading without bodies or screenshots', reading: 'the reading including response bodies' }[cfg.send || 'summary'];
  return {
    id,
    name: cfg.name || hostOf(cfg.url),
    version: 'remote',
    phase: 'enrich',
    needs: ['views'],
    group: cfg.group || 'other',
    remote: true,
    defaultEnabled: cfg.enabled !== false,
    description: `Remote plugin at ${cfg.url}`,
    disclosure: `Sends ${what} to ${hostOf(cfg.url)}.`,
    tags: ['remote'],
    timeoutMs: (Number(cfg.timeoutSec) || 120) * 1000,
    async run(reading, ctx) {
      const hp = reading.log._harplus;
      const body = {
        harplus: HARPLUS_VERSION,
        plugin: id,
        target: ctx.target,
        capturedAt: hp.capturedAt,
        readout: Object.values(hp.plugins || {}).filter((r) => r.summary?.length)
          .map((r) => ({ id: r.id, name: r.name, summary: r.summary })),
      };
      if (cfg.send === 'reading' || cfg.send === 'reading-lite') {
        body.reading = stripForSharing(reading, { screenshots: 'none', bodies: cfg.send === 'reading' });
      }
      const headers = { 'content-type': 'application/json', accept: 'application/json' };
      if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
      const out = await ctx.fetchJSON(cfg.url, { method: 'POST', headers, body: JSON.stringify(body) });
      return { data: out.data ?? null, summary: out.summary, findings: out.findings };
    },
  };
}
