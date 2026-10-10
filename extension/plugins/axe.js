// Full accessibility audit with axe-core, injected into the page.
// axe-core is not bundled: run scripts/vendor-axe.sh once to download it into plugins/vendor/,
// then enable this plugin. Shows how a plugin can bring its own engine via `inject`.

async function collect(opts) {
  if (typeof axe === 'undefined') throw new Error('axe-core did not load');
  const values = String(opts.tags || '').split(/[\s,]+/).filter(Boolean);
  const r = await axe.run(document, {
    resultTypes: ['violations'],
    ...(values.length ? { runOnly: { type: 'tag', values } } : {}),
  });
  return {
    engine: r.testEngine?.version,
    passes: r.passes.length,
    incomplete: r.incomplete.length,
    violations: r.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      helpUrl: v.helpUrl,
      tags: v.tags.filter((t) => /^wcag|best-practice/.test(t)),
      nodes: v.nodes.length,
      samples: v.nodes.slice(0, 5).map((n) => ({
        target: [].concat(n.target).join(' '),
        html: n.html.slice(0, 200),
        summary: (n.failureSummary || '').slice(0, 300),
      })),
    })),
  };
}

const SEVERITY = { critical: 'high', serious: 'high', moderate: 'medium', minor: 'low' };

function run(reading, ctx) {
  const c = ctx.collected;
  const findings = c.violations.map((v) => ({
    id: v.id,
    severity: SEVERITY[v.impact] || 'low',
    category: 'accessibility',
    title: `${v.help} (${v.nodes})`,
    detail: v.tags.join(', '),
    ref: v.helpUrl,
    evidence: v.samples.map((s) => s.target).join('\n'),
  }));
  const nodes = c.violations.reduce((n, v) => n + v.nodes, 0);
  return {
    data: c,
    findings,
    summary: [
      { label: 'Violations', headline: true, value: `${c.violations.length} rules · ${nodes} elements` },
      { label: 'Passed rules', value: c.passes },
      { label: 'Needs review', value: c.incomplete },
      { label: 'Engine', value: c.engine ? `axe-core ${c.engine}` : '' },
    ],
  };
}

function render(r, h) {
  const rows = r.data.violations.map((v) => ({
    impact: v.impact, rule: h.link(v.helpUrl, v.id), elements: v.nodes, help: v.help,
    samples: h.list(v.samples.map((s) => h.html`<code>${s.target}</code>`)),
  }));
  return rows.length ? h.table(rows, ['impact', 'rule', 'elements', 'help', 'samples']) : h.html`<p>No violations.</p>`;
}

function glance(r, h) {
  const v = r.data?.violations || [];
  const rows = [...v].sort((a, b) => b.nodes - a.nodes).slice(0, 8).map((x) => ({ label: x.help, value: x.nodes }));
  return h.html`<section class="card"><h4>axe-core · elements per violated rule</h4>${rows.length ? h.hbars({ rows, label: 'axe-core violations' }) : h.html`<p class="muted">No violations.</p>`}
    <p class="note">${r.data?.passes ?? 0} rules passed · ${r.data?.incomplete ?? 0} need review</p></section>`;
}

export default {
  id: 'axe',
  group: 'quality',
  area: 'accessibility',
  name: 'axe-core audit',
  version: '0.1.0',
  phase: 'page',
  world: 'isolated',
  defaultEnabled: false,
  description: 'Full WCAG audit with Deque axe-core. Requires scripts/vendor-axe.sh first.',
  tags: ['accessibility'],
  inject: [new URL('./vendor/axe.min.js', import.meta.url).href],
  options: [
    { key: 'tags', label: 'Rule tags', type: 'text', default: 'wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa,best-practice' },
  ],
  timeoutMs: 60_000,
  collect,
  run,
  render,
  glance,
};