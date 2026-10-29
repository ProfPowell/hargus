// The Overview's reading of a reading: the verdict sentence, how complete the capture was, and plain reasons.
import { AREAS, VERDICT, capText } from './score.js';
import { viewLabel, shotsByView } from './views.js';

const lower = (a) => a.label.toLowerCase();

/**
 * One sentence: cap text, then strongest areas, then where the high-severity issues sit. An area the cap text
 * already calls failing is not graded again (only its high-issue count is added), and an area named as the weak
 * one is never also named as the best.
 */
export function verdictSentence(scores) {
  const measured = AREAS.map((a) => scores.areas[a.id]).filter((a) => a && a.score != null);
  if (!measured.length) return 'No areas measured yet — enable plugins and re-run analysis.';
  const parts = [];
  const lead = capText(scores).trim();
  if (lead) parts.push(lead);
  const o = scores.overall || {};
  const inLead = new Set([...(o.capped?.areas || []), ...(o.failingCritical || [])]);
  const byScore = [...measured].sort((x, y) => y.score - x.score);
  const weak = byScore[byScore.length - 1];
  const weakNamed = weak.status === 'serious' || weak.status === 'critical' || inLead.has(weak.id);
  const strong = byScore.filter((a) => a.score >= 90 && !(weakNamed && a === weak)).slice(0, 2);
  if (strong.length) parts.push(`Strong on ${strong.map(lower).join(' and ')}.`);
  else if (!(byScore[0] === weak && weakNamed)) parts.push(`Best area: ${lower(byScore[0])} (${byScore[0].score}).`);
  if (weakNamed) {
    const total = measured.reduce((n, a) => n + (a.counts?.high || 0), 0);
    const here = weak.counts?.high || 0;
    if (inLead.has(weak.id)) {
      // The lead already says it is failing: only where the high-severity issues sit.
      const where = lower(weak);
      if (here === 1 && total === 1) parts.push(`The only high-severity issue is in ${where}.`);
      else if (here && here === total) parts.push(`All ${here} high-severity issues are in ${where}.`);
      else if (here) parts.push(`${here} of ${total} high-severity issues are in ${where}.`);
    } else {
      const tail = here === 1 && total === 1 ? ': the only high-severity issue is there.'
        : here && here === total ? `: all ${here} high-severity issues are there.`
        : here ? `: ${here} of ${total} high-severity issues are there.` : '.';
      parts.push(`${weak.label} is ${VERDICT[weak.status]}${tail}`);
    }
  } else if (measured.length >= 2) {
    parts.push(`No area below ${weak.score}.`);
  }
  return parts.join(' ');
}

const REASONS = [
  [/translat/i, /time(d)? ?out|in time/i, "the on-device translator didn't load in time"],
  [/time(d)? ?out|out of time/i, null, 'it took too long'],
  [/not supported|unsupported|unavailable/i, null, "this browser can't produce it"],
  [/permissions?-policy/i, null, "the site blocks the on-device translator"],
  [/css plugin not ok/i, null, "the CSS check didn't finish, so no breakpoints were found"],
  [/default font sizes/i, null, "the browser's default text size couldn't be read"],
  [/detached|closed|navigat/i, null, 'the page changed while it was being captured'],
  [/views could not be merged|analysis failed/i, null, "the views couldn't be saved with the reading"],
];

/** A raw capture reason as a short plain sentence fragment. First matching rule wins. */
export function plainReason(raw) {
  const s = String(raw ?? '');
  for (const [a, b, text] of REASONS) if (a.test(s) && (!b || b.test(s))) return text;
  return "it couldn't be captured";
}

/**
 * Skip records that are not failures: "disabled" (the view is switched off in settings) and "not needed"
 * (the Long text fallback standing down because a translated view ran).
 */
export const notASkip = (reason) => reason === 'disabled' || reason === 'not needed';

/**
 * Skip records for views that do not apply to this reading, as a plain why; null for a real failure.
 * "not in reload mode": No images and No JavaScript need a reload. "page is already in <language>": the
 * translated view would be the page itself. "no px breakpoints": the CSS has no width breakpoints to test.
 */
export function notApplicableWhy(reason, mode) {
  const s = String(reason ?? '');
  if (s === 'not in reload mode') return `not available in ${mode && mode !== 'reload' ? mode : 'snapshot'} mode`;
  const lang = s.match(/^page is already in (.+)$/);
  if (lang) return `the page is already in ${lang[1]}`;
  if (s === 'no px breakpoints') return 'the page has no width breakpoints';
  return null;
}

/**
 * How complete a reading is: { state: complete|partial|failed, views, skipped, notApplicable, failedChecks,
 * skippedChecks, warnings }. Only failures (skipped views, checks in error) make a reading partial; views that do
 * not apply and checks that skipped themselves are listed but do not.
 */
export function readingStatus(reading) {
  const h = reading?.log?._harplus || {};
  const capture = h.capture || {};
  const results = Object.values(h.plugins || {});
  const label = (view) => (view === 'all' ? 'All views' : viewLabel(view));
  const records = (capture.viewsSkipped || []).filter((s) => !notASkip(s?.reason));
  const skipped = [];
  const notApplicable = [];
  for (const { view, reason } of records) {
    const na = notApplicableWhy(reason, capture.mode);
    (na ? notApplicable : skipped).push({ view, label: label(view), why: na || plainReason(reason) });
  }
  const failedChecks = Object.entries(h.plugins || {}).filter(([, r]) => r?.status === 'error').map(([id, r]) => r.name || id);
  const skippedChecks = Object.entries(h.plugins || {}).filter(([, r]) => r?.status === 'skipped')
    .map(([id, r]) => ({ name: r.name || id, why: String(r.error || r.reason || '').trim() }));
  const state = !results.some((r) => r?.status === 'ok') ? 'failed'
    : skipped.length || failedChecks.length ? 'partial' : 'complete';
  // Captured views: those measured (capture.views, keyed by id) plus those with only screenshots (vision views).
  const v = capture.views;
  const views = Array.isArray(v) ? v.length
    : new Set([...Object.keys(v && typeof v === 'object' ? v : {}), ...Object.keys(shotsByView(reading))]).size;
  return { state, views, skipped, notApplicable, failedChecks, skippedChecks, warnings: capture.warnings || [] };
}
