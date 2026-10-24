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
