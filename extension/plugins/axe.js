// Full accessibility audit with axe-core (bundled in plugins/vendor/, MPL-2.0), injected into the page.
// Shows how a plugin can bring its own engine via `inject`. Besides violations it keeps "needs review"
// (incomplete) results: things axe could not decide, which a person has to look at.

import { PAGE_LEVEL, populationFor, withExtent } from '../core/extent.js';

async function collect(opts) {
  if (typeof axe === 'undefined') throw new Error('axe-core did not load');
  const values = String(opts.tags || '').split(/[\s,]+/).filter(Boolean);
  const r = await axe.run(document, {
    resultTypes: ['violations', 'incomplete', 'inapplicable'],
    ...(values.length ? { runOnly: { type: 'tag', values } } : {}),
  });
  // A target inside an iframe or a shadow root is a list of selectors, outermost first (nested in an array for
  // shadow DOM); joined with " >>> " it reads as a path and is never mistaken for one page selector.
  const target = (n) => {
    const t = [].concat(n.target);
    return (t.length > 1 || t.some(Array.isArray) ? t.flat(Infinity).join(' >>> ') : String(t[0] ?? '')).slice(0, 300);
  };
  const shape = (v, keep, maxTargets) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    helpUrl: v.helpUrl,
    tags: v.tags.filter((t) => /^wcag|best-practice/.test(t)),
    nodes: v.nodes.length,
    samples: v.nodes.slice(0, keep).map((n) => ({
      target: target(n),
      html: n.html.slice(0, 200),
      summary: (n.failureSummary || '').slice(0, 300),
    })),
    // Every node target (capped), for marking elements on the page; evidence still shows `samples`.
    targets: v.nodes.slice(0, maxTargets).map(target),
  });
  return {
    engine: r.testEngine?.version,
    passes: r.passes.length,
    passedIds: r.passes.map((p) => p.id),
    // Rules that ran but found nothing to evaluate: they still count as covered for the overlap rows.
    ranIds: (r.inapplicable || []).map((p) => p.id),
    violations: r.violations.map((v) => shape(v, 5, 50)),
    incomplete: r.incomplete.map((v) => shape(v, 5, 50)),
    // What each violation is counted against (core/extent.js); the same selectors as a11y-basics' stats.
    population: {
      links: document.querySelectorAll('a[href]').length,
      images: document.querySelectorAll('img').length,
      fields: document.querySelectorAll('input, select, textarea').length,
      buttons: document.querySelectorAll('button, [role="button"], input[type="button" i], input[type="submit" i], input[type="reset" i], input[type="image" i]').length,
      focusables: document.querySelectorAll('a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [contenteditable=""], [contenteditable="true"], [tabindex]:not([tabindex="-1"])').length,
    },
  };
}

const SEVERITY = { critical: 'high', serious: 'high', moderate: 'medium', minor: 'low' };

// A rule tagged only best-practice is advice, not a WCAG failure: it counts as low whatever its impact.
const bestPracticeOnly = (tags = []) => tags.includes('best-practice') && !tags.some((t) => /^wcag/.test(t));

function run(reading, ctx) {
  const c = ctx.collected;
  const pop = { ...c.population, text: ctx.results?.contrast?.data?.totals?.checked };
  const findings = c.violations.map((v) => withExtent({
    id: v.id,
    severity: bestPracticeOnly(v.tags) ? 'low' : SEVERITY[v.impact] || 'low',
    category: 'accessibility',
    title: `${v.help} (${v.nodes})`,
    detail: v.tags.join(', '),
    ref: v.helpUrl,
    tags: v.tags,
    evidence: v.samples.map((s) => s.target).join('\n'),
  }, PAGE_LEVEL.has(v.id) ? null : v.nodes, populationFor(v.id, pop)));
  for (const v of c.incomplete || []) {
    findings.push({
      id: `review:${v.id}`,
      severity: 'info',
      category: 'accessibility',
      title: `Needs review: ${v.help} (${v.nodes})`,
      detail: v.samples[0]?.summary || undefined,
      ref: v.helpUrl,
      tags: v.tags,
      evidence: v.samples.map((s) => s.target).join('\n'),
    });
  }
  const nodes = c.violations.reduce((n, v) => n + v.nodes, 0);
  return {
    data: c,
    findings,
    summary: [
      { label: 'Violations', headline: true, value: `${c.violations.length} rules · ${nodes} elements` },
      { label: 'Passed rules', value: c.passes },
      { label: 'Needs review', value: (c.incomplete || []).length },
      { label: 'Engine', value: c.engine ? `axe-core ${c.engine}` : '' },
    ],
  };
}

function render(r, h) {
  const rows = r.data.violations.map((v) => ({
    impact: v.impact, rule: h.link(v.helpUrl, v.id), elements: v.nodes, help: v.help,
    samples: h.list(v.samples.map((s) => h.html`<code>${s.target}</code>`)),
  }));
  const review = [].concat(Array.isArray(r.data.incomplete) ? r.data.incomplete : []).map((v) => ({
    rule: h.link(v.helpUrl, v.id), elements: v.nodes, help: v.help,
    why: v.samples[0]?.summary || '',
    samples: h.list(v.samples.map((s) => h.html`<code>${s.target}</code> <code>${s.html}</code>`)),
  }));
  return h.html`${rows.length ? h.table(rows, ['impact', 'rule', 'elements', 'help', 'samples']) : h.html`<p>No violations.</p>`}
    ${review.length ? h.sub('Needs review', h.table(review, ['rule', 'elements', 'help', 'why', 'samples'])) : ''}`;
}

function glance(r, h) {
  const v = r.data?.violations || [];
  const rows = [...v].sort((a, b) => b.nodes - a.nodes).slice(0, 8).map((x) => ({ label: x.help, value: x.nodes }));
  return h.html`<section class="card"><h4>axe-core · elements per violated rule</h4>${rows.length ? h.hbars({ rows, label: 'axe-core violations' }) : h.html`<p class="muted">No violations.</p>`}
    <p class="note">${r.data?.passes ?? 0} rules passed · ${Array.isArray(r.data?.incomplete) ? r.data.incomplete.length : (r.data?.incomplete ?? 0)} need review</p></section>`;
}

export default {
  id: 'axe',
  group: 'quality',
  area: 'accessibility',
  name: 'axe-core audit',
  version: '0.2.0',
  phase: 'page',
  world: 'isolated',
  // The contrast plugin's checked-text count is the population for axe's contrast rules.
  after: ['contrast'],
  defaultEnabled: true,
  description: 'Full WCAG audit with Deque axe-core, including results that need a human review.',
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
