// Where HARgus's own accessibility checks cover the same problem as an axe-core rule, they yield to
// axe when axe ran successfully. `ours` is "pluginId:findingKey" (the finding's `id`).
// 'keep' rows are partial overlaps: the HARgus finding says something axe's rule does not.

export const OVERLAP = [
  // a11y-basics
  { ours: 'a11y-basics:html-lang', axe: 'html-has-lang', mode: 'suppress' },
  { ours: 'a11y-basics:document-title', axe: 'document-title', mode: 'suppress' },
  { ours: 'a11y-basics:image-alt', axe: 'image-alt', mode: 'suppress' },
  { ours: 'a11y-basics:input-label', axe: 'label', mode: 'suppress' },
  { ours: 'a11y-basics:button-name', axe: 'button-name', mode: 'suppress' },
  { ours: 'a11y-basics:link-name', axe: 'link-name', mode: 'suppress' },
  { ours: 'a11y-basics:frame-title', axe: 'frame-title', mode: 'suppress' },
  { ours: 'a11y-basics:meta-viewport', axe: 'meta-viewport', mode: 'suppress' },
  { ours: 'a11y-basics:duplicate-id', axe: 'duplicate-id-aria', mode: 'keep' }, // axe covers only ids that ARIA or labels reference
  { ours: 'a11y-basics:tabindex', axe: 'tabindex', mode: 'suppress' },
  { ours: 'a11y-basics:focusable-hidden', axe: 'aria-hidden-focus', mode: 'suppress' },
  { ours: 'a11y-basics:autoplay-audio', axe: 'no-autoplay-audio', mode: 'keep' }, // axe usually leaves this "needs review"
  // a11y-structure
  { ours: 'a11y-structure:headings-empty', axe: 'empty-heading', mode: 'suppress' },
  { ours: 'a11y-structure:headings-skipped', axe: 'heading-order', mode: 'keep' }, // axe checks order per heading; ours counts skips
  { ours: 'a11y-structure:no-main', axe: 'landmark-one-main', mode: 'suppress' },
  { ours: 'a11y-structure:multiple-main', axe: 'landmark-no-duplicate-main', mode: 'suppress' },
  { ours: 'a11y-structure:nav-indistinct', axe: 'landmark-unique', mode: 'suppress' },
  { ours: 'a11y-structure:aside-indistinct', axe: 'landmark-unique', mode: 'suppress' },
  { ours: 'a11y-structure:banner-multiple', axe: 'landmark-no-duplicate-banner', mode: 'suppress' },
  { ours: 'a11y-structure:contentinfo-multiple', axe: 'landmark-no-duplicate-contentinfo', mode: 'suppress' },
  { ours: 'a11y-structure:label-in-name', axe: 'label-content-name-mismatch', mode: 'suppress' },
  { ours: 'a11y-structure:label-refs', axe: 'aria-valid-attr-value', mode: 'keep' }, // axe also validates values; ours is only missing ids
  { ours: 'a11y-structure:aria-refs', axe: 'aria-valid-attr-value', mode: 'keep' },
  { ours: 'a11y-structure:bad-alt', axe: 'image-redundant-alt', mode: 'keep' }, // axe only flags alt repeated by adjacent text
  { ours: 'a11y-structure:bad-autocomplete', axe: 'autocomplete-valid', mode: 'suppress' },
  { ours: 'a11y-structure:targets-24', axe: 'target-size', mode: 'keep' }, // spacing exceptions differ
  { ours: 'a11y-structure:focus-jumps', axe: 'focus-order-semantics', mode: 'keep' },
];

/** The axe rule id that makes HARgus's finding redundant, or null. Only when axe ran OK and that rule was evaluated. */
export function suppressedBy(pluginId, findingKey, axeResult) {
  if (axeResult?.status !== 'ok' || !findingKey) return null;
  const row = OVERLAP.find((o) => o.ours === `${pluginId}:${findingKey}`);
  if (!row || row.mode !== 'suppress') return null;
  const d = axeResult.data || {};
  const ran = (d.violations || []).some((v) => v.id === row.axe) || (d.incomplete || []).some((v) => v.id === row.axe) ||
    (d.passedIds || []).includes(row.axe);
  return ran ? row.axe : null;
}
