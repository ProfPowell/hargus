// Where HARgus's own accessibility checks cover the same problem as an axe-core rule, they yield to
// axe when axe ran successfully. `ours` is "pluginId:findingKey" (the finding's `id`).
// `axe` is a rule id or a list of them (all must have run). 'keep' rows are partial overlaps: the HARgus finding says something axe's rule does not.
// 'unique' rows (axe: null) record that no axe rule covers the finding.

export const OVERLAP = [
  // a11y-basics
  { ours: 'a11y-basics:html-lang', axe: 'html-has-lang', mode: 'suppress' },
  { ours: 'a11y-basics:document-title', axe: 'document-title', mode: 'suppress' },
  { ours: 'a11y-basics:image-alt', axe: 'image-alt', mode: 'suppress' },
  { ours: 'a11y-basics:input-label', axe: 'label', mode: 'suppress' },
  { ours: 'a11y-basics:button-name', axe: ['button-name', 'aria-command-name', 'input-button-name'], mode: 'suppress' }, // button-name alone covers only <button>
  { ours: 'a11y-basics:link-name', axe: 'link-name', mode: 'suppress' },
  { ours: 'a11y-basics:frame-title', axe: 'frame-title', mode: 'suppress' },
  { ours: 'a11y-basics:meta-viewport', axe: 'meta-viewport', mode: 'suppress' },
  { ours: 'a11y-basics:duplicate-id', axe: 'duplicate-id-aria', mode: 'keep' }, // axe covers only ids that ARIA or labels reference
  { ours: 'a11y-basics:tabindex', axe: 'tabindex', mode: 'suppress' },
  { ours: 'a11y-basics:focusable-hidden', axe: 'aria-hidden-focus', mode: 'suppress' },
  { ours: 'a11y-basics:autoplay-audio', axe: 'no-autoplay-audio', mode: 'keep' }, // axe usually leaves this "needs review"
  // a11y-basics, WAVE-style checks: only the ones axe has a default-on rule for yield to it
  { ours: 'a11y-basics:label-empty', axe: 'label', mode: 'suppress' }, // an empty label leaves the field unnamed, which axe's label rule reports
  { ours: 'a11y-basics:video-captions', axe: 'video-caption', mode: 'suppress' },
  { ours: 'a11y-basics:fieldset-legend', axe: null, mode: 'unique' },
  { ours: 'a11y-basics:label-orphaned', axe: null, mode: 'unique' },
  { ours: 'a11y-basics:label-multiple', axe: null, mode: 'unique' },
  { ours: 'a11y-basics:link-broken-anchor', axe: 'skip-link', mode: 'keep' }, // axe checks skip links only
  { ours: 'a11y-basics:link-redundant', axe: null, mode: 'unique' }, // axe's identical-links-same-purpose is about different links, not adjacent duplicates
  { ours: 'a11y-basics:title-redundant', axe: null, mode: 'unique' },
  { ours: 'a11y-basics:media-embed', axe: null, mode: 'unique' }, // players in iframes are opaque to axe
  { ours: 'a11y-basics:layout-table', axe: null, mode: 'unique' }, // axe has no layout-table rule
  // a11y-map
  { ours: 'a11y-map:no-name-input-image', axe: 'input-image-alt', mode: 'suppress' },
  { ours: 'a11y-map:no-name-role-img', axe: 'role-img-alt', mode: 'suppress' },
  { ours: 'a11y-map:no-name-svg', axe: 'svg-img-alt', mode: 'suppress' },
  { ours: 'a11y-map:no-name-area', axe: 'area-alt', mode: 'suppress' },
  { ours: 'a11y-map:no-name-object', axe: 'object-alt', mode: 'suppress' },
  // a11y-structure
  { ours: 'a11y-structure:headings-empty', axe: 'empty-heading', mode: 'suppress' },
  { ours: 'a11y-structure:headings-skipped', axe: 'heading-order', mode: 'keep' }, // axe checks order per heading; ours counts skips
  { ours: 'a11y-structure:no-main', axe: 'landmark-one-main', mode: 'suppress' },
  { ours: 'a11y-structure:multiple-main', axe: 'landmark-no-duplicate-main', mode: 'suppress' },
  { ours: 'a11y-structure:nav-indistinct', axe: 'landmark-unique', mode: 'suppress' },
  { ours: 'a11y-structure:aside-indistinct', axe: 'landmark-unique', mode: 'suppress' },
  { ours: 'a11y-structure:banner-multiple', axe: 'landmark-no-duplicate-banner', mode: 'suppress' },
  { ours: 'a11y-structure:contentinfo-multiple', axe: 'landmark-no-duplicate-contentinfo', mode: 'suppress' },
  { ours: 'a11y-structure:label-in-name', axe: 'label-content-name-mismatch', mode: 'keep' }, // experimental in axe, never runs by default
  { ours: 'a11y-structure:label-refs', axe: 'aria-valid-attr-value', mode: 'keep' }, // axe also validates values; ours is only missing ids
  { ours: 'a11y-structure:aria-refs', axe: 'aria-valid-attr-value', mode: 'keep' },
  { ours: 'a11y-structure:bad-alt', axe: 'image-redundant-alt', mode: 'keep' }, // axe only flags alt repeated by adjacent text
  { ours: 'a11y-structure:bad-autocomplete', axe: 'autocomplete-valid', mode: 'suppress' },
  { ours: 'a11y-structure:targets-24', axe: 'target-size', mode: 'keep' }, // spacing exceptions differ
  { ours: 'a11y-structure:focus-jumps', axe: 'focus-order-semantics', mode: 'keep' },
  // a11y-structure, from the keyboard walk (the Keyboard order table still flags each stop)
  { ours: 'a11y-structure:kb-trap', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:kb-focus-lost', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:kb-hidden', axe: null, mode: 'unique' },
  // Partial: axe's name rules cover some kinds; stops axe already reported are dropped per element (a11y-structure collectArgs).
  { ours: 'a11y-structure:kb-no-name', axe: ['button-name', 'link-name', 'input-button-name', 'aria-command-name'], mode: 'keep' },
  { ours: 'a11y-structure:kb-no-focus-style', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:kb-positive-tabindex', axe: 'tabindex', mode: 'suppress' },
  { ours: 'a11y-structure:kb-jumps', axe: 'focus-order-semantics', mode: 'keep' }, // the real Tab order, not roles
  { ours: 'a11y-structure:kb-no-skip-link', axe: 'bypass', mode: 'keep' }, // axe's bypass also passes on landmarks or headings
  { ours: 'a11y-structure:kb-skip-target', axe: 'skip-link', mode: 'suppress' },
  { ours: 'a11y-structure:kb-clickable', axe: null, mode: 'unique' },
  // a11y-structure, WAVE-style checks
  { ours: 'a11y-structure:possible-heading', axe: 'p-as-heading', mode: 'keep' }, // experimental in axe, never runs by default
  { ours: 'a11y-structure:possible-list', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:vague-link', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:tiny-text', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:justified-text', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:underline-nonlink', axe: null, mode: 'unique' },
];

/** The axe rule id that makes HARgus's finding redundant, or null. Only when axe ran OK and that rule was evaluated. */
export function suppressedBy(pluginId, findingKey, axeResult) {
  if (axeResult?.status !== 'ok' || !findingKey) return null;
  const row = OVERLAP.find((o) => o.ours === `${pluginId}:${findingKey}`);
  if (!row || row.mode !== 'suppress') return null;
  const d = axeResult.data || {};
  const ran = (id) => (d.violations || []).some((v) => v.id === id) || (d.incomplete || []).some((v) => v.id === id) ||
    (d.passedIds || []).includes(id);
  const rules = [].concat(row.axe);
  return rules.every(ran) ? rules.join(', ') : null;
}
