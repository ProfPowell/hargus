// Map a Lighthouse result (LHR) to the HAR-PLUS plugin result shape. Shared by the PageSpeed
// Insights plugin and examples/remote-lighthouse.

const CATEGORY = { performance: 'performance', accessibility: 'accessibility', 'best-practices': 'quality', seo: 'seo' };
const SCORED = new Set(['binary', 'numeric', 'metricSavings']);

export function toPluginResult(lhr) {
  const cats = Object.entries(lhr.categories || {}).map(([id, c]) => ({ id, ...c }));
  const metric = (id) => lhr.audits?.[id]?.displayValue;
  const summary = cats.map((c) => ({ label: c.title, value: c.score == null ? '—' : String(Math.round(c.score * 100)) }));
  const vitals = [metric('largest-contentful-paint'), metric('total-blocking-time'), metric('cumulative-layout-shift')].filter(Boolean);
  if (vitals.length) summary.push({ label: 'LCP · TBT · CLS', value: vitals.join(' · ') });

  const seen = new Set();
  const findings = [];
  for (const c of cats) {
    for (const ref of c.auditRefs || []) {
      const a = lhr.audits?.[ref.id];
      if (!a || seen.has(a.id) || a.score == null || a.score >= 0.9 || !SCORED.has(a.scoreDisplayMode)) continue;
      seen.add(a.id);
      findings.push({
        id: a.id,
        severity: a.score < 0.5 ? 'medium' : 'low',
        category: CATEGORY[c.id] || 'quality',
        title: a.title,
        detail: a.displayValue || undefined,
      });
    }
  }
  findings.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'medium' ? -1 : 1));
  return {
    summary,
    findings: findings.slice(0, 40),
    data: {
      url: lhr.finalDisplayedUrl || lhr.finalUrl,
      lighthouseVersion: lhr.lighthouseVersion,
      fetchTime: lhr.fetchTime,
      formFactor: lhr.configSettings?.formFactor,
      scores: Object.fromEntries(cats.map((c) => [c.id, c.score])),
    },
  };
}

