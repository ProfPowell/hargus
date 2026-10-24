// Translated views: pure decisions. Chrome's on-device Translator runs in the page (capture layer);
// this module only names the views, classifies failures and decides when the long-text fallback is needed.
import { primary } from './language.js';

export const TRANSLATED_VIEWS = [
  { id: 'translated-de', lang: 'de', label: 'German' },
  { id: 'translated-ar', lang: 'ar', label: 'Arabic' },
  { id: 'translated-ja', lang: 'ja', label: 'Japanese' },
];

/** Turn a thrown message into a reader-facing reason; scope 'all' means every translated view will fail the same way. */
export function classifyError(message) {
  const m = String(message ?? '');
  if (/Permission Policy/i.test(m) || (/NotAllowedError/.test(m) && /Permission/i.test(m))) {
    return { reason: "blocked by the site's Permissions-Policy", scope: 'all' };
  }
  if (/Translator is not defined|no Translator|unavailable/i.test(m)) {
    return { reason: 'translation unavailable in this browser', scope: 'all' };
  }
  if (/create timed out/i.test(m)) return { reason: 'the translation model did not load in time', scope: 'all' };
  return { reason: `translation failed: ${m.slice(0, 80)}`, scope: 'one' };
}

/** True when the view's language is the page's own (primary subtags, canonicalised). */
export function sameAsPage(viewLang, htmlLang) {
  const a = primary(viewLang);
  return !!a && a === primary(htmlLang);
}

/** The long-text view stands in when any translated view failed (skips never count), unless pseudo is off. */
export function needsFallback(translation, want) {
  if (want?.pseudo === false) return false;
  return Object.values(translation || {}).some((t) => t?.status === 'failed');
}

/** One shared time budget for the three translated views, so they cannot run away with the reading. */
export const TRANSLATED_BUDGET_MS = 5 * 60 * 1000;
/** The most any one translated view may take. */
export const TRANSLATED_VIEW_MS = 180_000;
/** Time a view keeps back, after translating, to settle, check, shoot and look for leftovers. */
export const TRANSLATED_RESERVE_MS = 20_000;
/** Below this much shared time left, a translated view is not started. */
export const TRANSLATED_MIN_MS = 30_000;

/**
 * Time limits for the next translated view from what is left of the shared budget, or null when too little is left.
 * runMs: the view's run; totalMs: everything translatePage may take (create included); timeoutMs: create();
 * budgetMs: translating once the model is ready.
 */
export function viewBudget(sharedLeftMs, perViewMs = TRANSLATED_VIEW_MS) {
  if (!(sharedLeftMs >= TRANSLATED_MIN_MS)) return null;
  const runMs = Math.min(perViewMs, sharedLeftMs);
  const totalMs = Math.max(0, runMs - TRANSLATED_RESERVE_MS);
  return { runMs, timeoutMs: Math.min(60_000, totalMs), budgetMs: Math.min(100_000, totalMs), totalMs };
}
