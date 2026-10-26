// How much of the page a finding affects: the population a rule is counted against, and the fields
// ({ count, of, unit }) that core/score.js reads for Accessibility's extent. Pure: no DOM, no chrome.*.

/** Rules about the page as a whole: one failure is the whole page, so they carry no count. */
export const PAGE_LEVEL = new Set([
  'kb-no-skip-link', 'kb-skip-target', 'kb-trap', 'kb-banner-trap', 'kb-banner-modal', 'kb-banner-unreachable', 'kb-confined', 'kb-stopped',
  'no-main', 'multiple-main', 'banner-multiple', 'contentinfo-multiple', 'nav-indistinct', 'aside-indistinct', 'no-current', 'reset-button', 'focus-none',
  'reflow-scroll', 'spacing-scroll', 'text200-ignored', 'text200-scroll', 'morecontrast-none', 'dark-none', 'views-unverified',
  'landmark-one-main', 'page-has-heading-one', 'landmark-no-duplicate-banner', 'landmark-no-duplicate-contentinfo', 'landmark-no-duplicate-main',
  'landmark-unique', 'bypass', 'document-title', 'html-has-lang', 'html-lang-valid', 'meta-viewport', 'meta-viewport-large', 'meta-refresh',
  'skip-link', 'region',
]);

/** Element rules with no population to count against (the candidates are guesses, not a set of like elements). */
const NO_POPULATION = new Set(['possible-heading', 'possible-list', 'layout-table', 'forced-icons']);

const FOCUSABLE = ['focusables', 'focusable elements'];
// First match wins: [test, population key, unit].
const RULES = [
  [(id) => /(^|-)link(s|-|$)|multi-text|broken-anchor/.test(id), 'links', 'links'],
  [(id) => /alt|image|img|svg|object-alt|no-name/.test(id) && !id.startsWith('kb-'), 'images', 'images'],
  [(id) => /contrast|small-text|tiny-text|justified|underline/.test(id), 'text', 'text elements'],
  [(id) => /heading/.test(id), 'headings', 'headings'],
  [(id) => /label|autocomplete|select-name|form|field/.test(id) && !/^label-(in-name|content)/.test(id), 'fields', 'form fields'],
  [(id) => /button/.test(id), 'buttons', 'buttons'],
];

const posInt = (x) => Number.isInteger(x) && x > 0;

/**
 * The population rule `id` is counted against: { of, unit }, `of` null when the page gave no count for it;
 * null for page-level rules and rules with no population.
 * pop = { links, images, fields, buttons, focusables, text, headings } (numbers or undefined).
 */
export function populationFor(id, pop) {
  if (PAGE_LEVEL.has(id) || NO_POPULATION.has(id)) return null;
  const p = pop || {};
  const [key, unit] = (RULES.find(([match]) => match(String(id))) || [null, ...FOCUSABLE]).slice(1);
  if (posInt(p[key])) return { of: p[key], unit };
  // Links, buttons and fields are focusable, so focusables is a fair stand-in; text, images and headings are not.
  if (['links', 'buttons', 'fields'].includes(key) && posInt(p.focusables)) return { of: p.focusables, unit: FOCUSABLE[1] };
  return { of: null, unit };
}

/** The finding with `count` (and `of`/`unit` from populationFor) added; unchanged unless count is a positive integer. */
export function withExtent(finding, count, popResult) {
  if (!posInt(count)) return finding;
  return {
    ...finding,
    count,
    ...(posInt(popResult?.of) ? { of: popResult.of } : {}),
    ...(popResult?.unit ? { unit: popResult.unit } : {}),
  };
}
