// The Overview's reading of a reading: the verdict sentence, how complete the capture was, and plain reasons.
import { AREAS, VERDICT, capText } from './score.js';
import { viewLabel } from './views.js';

const lower = (a) => a.label.toLowerCase();

/** One sentence: cap text, then strongest areas, then where the high-severity issues sit. */
export function verdictSentence(scores) {
  const measured = AREAS.map((a) => scores.areas[a.id]).filter((a) => a && a.score != null);
  if (!measured.length) return 'No areas measured yet — enable plugins and re-run analysis.';
  const parts = [];
  const lead = capText(scores).trim();
  if (lead) parts.push(lead);
  const byScore = [...measured].sort((x, y) => y.score - x.score);
  const strong = byScore.filter((a) => a.score >= 90).slice(0, 2);
  parts.push(strong.length
    ? `Strong on ${strong.map(lower).join(' and ')}.`
    : `Best area: ${lower(byScore[0])} (${byScore[0].score}).`);
  const weak = byScore[byScore.length - 1];
  if (weak.status === 'serious' || weak.status === 'critical') {
    const total = measured.reduce((n, a) => n + (a.counts?.high || 0), 0);
    const here = weak.counts?.high || 0;
    const tail = here === 1 && total === 1 ? ': the only high-severity issue is there.'
      : here && here === total ? `: all ${here} high-severity issues are there.`
      : here ? `: ${here} of ${total} high-severity issues are there.` : '.';
    parts.push(`${weak.label} is ${VERDICT[weak.status]}${tail}`);
  } else if (measured.length >= 2) {
    parts.push(`No area below ${weak.score}.`);
  }
  return parts.join(' ');
}

const REASONS = [
  [/translator/i, /time(d)? ?out/i, "the on-device translator didn't load in time"],
  [/time(d)? ?out/i, null, 'it took too long'],
  [/not supported|unsupported/i, null, "this browser can't produce it"],
  [/detached|closed|navigat/i, null, 'the page changed while it was being captured'],
  [/views could not be merged|analysis failed/i, null, "the views couldn't be saved with the reading"],
];

/** A raw capture reason as a short plain sentence fragment. First matching rule wins. */
export function plainReason(raw) {
  const s = String(raw ?? '');
  for (const [a, b, text] of REASONS) if (a.test(s) && (!b || b.test(s))) return text;
  return "it couldn't be captured";
}

/** How complete a reading is: { state: complete|partial|failed, views, skipped, failedChecks, warnings }. */
export function readingStatus(reading) {
  const h = reading?.log?._harplus || {};
  const capture = h.capture || {};
  const results = Object.values(h.plugins || {});
  // "not needed" is the Long text fallback standing down because a translated view ran: not a skip.
  const skipped = (capture.viewsSkipped || []).filter((s) => s?.reason !== 'not needed')
    .map(({ view, reason }) => ({ view, label: view === 'all' ? 'All views' : viewLabel(view), why: plainReason(reason) }));
  const failedChecks = Object.entries(h.plugins || {}).filter(([, r]) => r?.status === 'error').map(([id, r]) => r.name || id);
  const state = !results.some((r) => r?.status === 'ok') ? 'failed'
    : skipped.length || failedChecks.length ? 'partial' : 'complete';
  // The recorder saves views keyed by id; an array is accepted too.
  const v = capture.views;
  const views = Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0;
  return { state, views, skipped, failedChecks, warnings: capture.warnings || [] };
}
