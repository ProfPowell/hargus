// Mozilla HTTP Observatory grade (developer.mozilla.org/observatory). Mozilla's scanner fetches the
// site itself and grades its HTTP security headers and practices; results are cached by Mozilla
// for a minute per host. Off by default because it triggers an external scan of the site.

import { HttpError } from '../core/plugin-host.js';

const GRADE_SEVERITY = (grade) => (/^[DF]/.test(grade) ? 'high' : /^C/.test(grade) ? 'medium' : /^B/.test(grade) ? 'low' : null);

async function run(reading, ctx) {
  const host = ctx.target.host;
  if (!host || ctx.util.isIP(host) || !host.includes('.')) ctx.skip('Observatory needs a public hostname');
  const base = String(ctx.options.endpoint || 'https://observatory-api.mdn.mozilla.net').replace(/\/$/, '');
  const url = `${base}/api/v2/scan?host=${encodeURIComponent(host)}`;
  const r = await ctx.fetch(url, { method: 'POST', headers: { accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    if (j.error) throw new Error(`Observatory: ${j.message || j.error}`);
    throw new HttpError(r.status, url);
  }
  const severity = GRADE_SEVERITY(j.grade || '');
  return {
    data: j,
    findings: severity ? [{ severity, category: 'security', title: `Mozilla Observatory grade ${j.grade} (${j.score}/100)`, detail: `${j.tests_failed} of ${j.tests_quantity} tests failed`, ref: j.details_url }] : [],
    summary: [
      { label: 'Grade', headline: true, value: `${j.grade} (${j.score})` },
      { label: 'Tests', value: `${j.tests_passed} passed · ${j.tests_failed} failed` },
      { label: 'Scanned', value: String(j.scanned_at || '').replace('T', ' ').slice(0, 16) },
    ],
  };
}

/** Answer first (grade and failed tests), then the scan's details. The score ring is the glance's. */
function render(r, h) {
  const d = r.data || {};
  return h.html`${h.stats([
    h.stat({ label: 'Grade', value: d.grade ?? '—', note: d.score != null ? `${d.score} / 100` : '' }),
    h.stat({ label: 'Tests failed', value: d.tests_failed ?? '—', note: d.tests_quantity != null ? `of ${d.tests_quantity}` : '' }),
  ])}
    ${h.kv([['HTTP status', d.status_code], ['Algorithm', d.algorithm_version], ['Scanned', String(d.scanned_at || '').replace('T', ' ').slice(0, 16)], ['Details', h.link(d.details_url, 'Full report on MDN')]])}`;
}

function glance(r, h) {
  const d = r.data || {};
  if (d.score == null) return '';
  const status = d.score >= 85 ? 'good' : d.score >= 70 ? 'warning' : d.score >= 50 ? 'serious' : 'critical';
  return h.html`<section class="card"><h4>Mozilla Observatory</h4><div class="ring-row"><figure class="ring-fig">${h.ring({ value: d.score, size: 64, status, label: 'Mozilla Observatory' })}<figcaption>Grade ${d.grade}</figcaption></figure>
    <p class="note">${d.tests_passed} tests passed · ${d.tests_failed} failed</p></div></section>`;
}

export default {
  id: 'observatory',
  group: 'security',
  name: 'Mozilla Observatory',
  version: '0.1.0',
  phase: 'enrich',
  defaultEnabled: false,
  description: 'Security-header grade from Mozilla\'s HTTP Observatory.',
  disclosure: 'Sends the hostname to observatory-api.mdn.mozilla.net, which then scans the site.',
  tags: ['security'],
  options: [{ key: 'endpoint', label: 'Observatory API', type: 'text', default: 'https://observatory-api.mdn.mozilla.net' }],
  timeoutMs: 60_000,
  run,
  render,
  glance,
};
