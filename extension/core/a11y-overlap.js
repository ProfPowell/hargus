// Where HARgus's own accessibility checks cover the same problem as an axe-core rule, they yield to
// axe when axe ran successfully. `ours` is "pluginId:findingKey" (the finding's `id`).
// `axe` is a rule id or a list of them (all must have run). 'keep' rows are partial overlaps: the HARgus finding says something axe's rule does not.
// A row with `when: 'reported'` yields only when axe reported the rule (a violation or needs review), not when it merely ran;
// `when: 'violation'` only when axe found it a violation (axe's needs-review gives no count, so a real count of ours stays).
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
  { ours: 'html:fake-buttons', axe: null, mode: 'unique' }, // axe has no default rule for clickable non-buttons; kb-clickable is the walk's version
  { ours: 'a11y-basics:media-embed', axe: null, mode: 'unique' }, // players in iframes are opaque to axe
  { ours: 'a11y-basics:layout-table', axe: null, mode: 'unique' }, // axe has no layout-table rule
  // a11y-map
  // The Images panel verdicts own alt quality; a11y-structure:bad-alt is dropped when a11y-map ran (see a11y-map run()).
  { ours: 'a11y-map:no-name', axe: ['input-image-alt', 'role-img-alt', 'svg-img-alt', 'area-alt', 'object-alt'], mode: 'keep' }, // per kind, below
  { ours: 'a11y-map:linked-empty-alt', axe: 'link-name', mode: 'suppress' }, // an image-only link with empty alt leaves the link unnamed
  { ours: 'a11y-map:redundant-alt', axe: 'image-redundant-alt', mode: 'suppress' },
  { ours: 'a11y-map:suspicious-alt', axe: null, mode: 'unique' },
  { ours: 'a11y-map:filename-alt', axe: null, mode: 'unique' },
  { ours: 'a11y-map:long-alt', axe: null, mode: 'unique' },
  { ours: 'a11y-map:no-name-input-image', axe: 'input-image-alt', mode: 'suppress' },
  { ours: 'a11y-map:no-name-role-img', axe: 'role-img-alt', mode: 'suppress' },
  { ours: 'a11y-map:no-name-svg', axe: 'svg-img-alt', mode: 'suppress' },
  { ours: 'a11y-map:no-name-area', axe: 'area-alt', mode: 'suppress' },
  { ours: 'a11y-map:no-name-object', axe: 'object-alt', mode: 'suppress' },
  // a11y-structure
  { ours: 'a11y-structure:headings-empty', axe: 'empty-heading', mode: 'suppress' },
  { ours: 'a11y-structure:headings-skipped', axe: 'heading-order', mode: 'suppress', when: 'violation' }, // ours yields when axe finds a heading-order violation on this page; otherwise it stays (axe checks order per heading, ours counts skips)
  { ours: 'a11y-structure:no-main', axe: 'landmark-one-main', mode: 'suppress' },
  { ours: 'a11y-structure:multiple-main', axe: 'landmark-no-duplicate-main', mode: 'suppress' },
  { ours: 'a11y-structure:nav-indistinct', axe: 'landmark-unique', mode: 'suppress' },
  { ours: 'a11y-structure:aside-indistinct', axe: 'landmark-unique', mode: 'suppress' },
  { ours: 'a11y-structure:banner-multiple', axe: 'landmark-no-duplicate-banner', mode: 'suppress' },
  { ours: 'a11y-structure:contentinfo-multiple', axe: 'landmark-no-duplicate-contentinfo', mode: 'suppress' },
  { ours: 'a11y-structure:label-in-name', axe: 'label-content-name-mismatch', mode: 'suppress', when: 'violation' }, // ours yields when axe finds a label-content-name-mismatch violation on this page; otherwise it stays
  { ours: 'a11y-structure:label-refs', axe: 'aria-valid-attr-value', mode: 'keep' }, // axe also validates values; ours is only missing ids
  { ours: 'a11y-structure:aria-refs', axe: 'aria-valid-attr-value', mode: 'keep' },
  { ours: 'a11y-structure:bad-alt', axe: 'image-redundant-alt', mode: 'keep' }, // dropped when a11y-map ran; axe only flags alt repeated by adjacent text
  { ours: 'a11y-structure:bad-autocomplete', axe: 'autocomplete-valid', mode: 'suppress' },
  { ours: 'a11y-structure:targets-24', axe: 'target-size', mode: 'suppress', when: 'violation' }, // ours yields when axe finds a target-size violation on this page (axe often leaves it at needs review); otherwise it stays (spacing exceptions differ)
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
  // axe's skip-link rule only looks at links it takes for skip links (off-screen ones), so "nothing to evaluate" there says nothing about the walk's skip link: yield only when axe reported it
  { ours: 'a11y-structure:kb-skip-target', axe: 'skip-link', mode: 'suppress', when: 'reported' },
  { ours: 'a11y-structure:kb-clickable', axe: null, mode: 'unique' },
  // consent banners and partial walks: only a real Tab walk can see these
  { ours: 'a11y-structure:kb-banner-unreachable', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:kb-banner-trap', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:kb-banner-modal', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:kb-obscured', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:kb-confined', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:kb-stopped', axe: null, mode: 'unique' },
  // a11y-structure, WAVE-style checks
  { ours: 'a11y-structure:possible-heading', axe: 'p-as-heading', mode: 'keep' }, // experimental in axe, never runs by default
  { ours: 'a11y-structure:possible-list', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:vague-link', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:tiny-text', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:justified-text', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:underline-nonlink', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:headings-duplicate', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:http-links', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:multi-text', axe: null, mode: 'unique' }, // axe's identical-links-same-purpose is experimental and never runs by default
  { ours: 'a11y-structure:no-current', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:reset-button', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:targets-44', axe: null, mode: 'unique' }, // advisory (2.5.5); axe's target-size is the 24 px rule
  { ours: 'a11y-structure:small-text', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:small-fields', axe: null, mode: 'unique' },
  { ours: 'a11y-structure:no-role', axe: null, mode: 'unique' },
  // contrast plugin: it checks computed colours, including pairs axe cannot decide, so it is kept beside axe's color-contrast (spec: partial overlap)
  { ours: 'contrast:contrast-pair', axe: 'color-contrast', mode: 'keep' },
  { ours: 'contrast:contrast-more', axe: 'color-contrast', mode: 'keep' },
  { ours: 'contrast:contrast-unknown', axe: null, mode: 'unique' },
  { ours: 'contrast:contrast-apca', axe: null, mode: 'unique' },
];

/** Whether axe ran OK and evaluated the rule (found it, passed it, needs review, or had nothing to evaluate). */
export function axeRan(axeResult, id) {
  if (axeResult?.status !== 'ok') return false;
  const d = axeResult.data || {};
  return (d.violations || []).some((v) => v.id === id) || (d.incomplete || []).some((v) => v.id === id) ||
    (d.passedIds || []).includes(id) || (d.ranIds || []).includes(id);
}

/** Whether axe ran OK and reported the rule (a violation or a needs-review result), not merely evaluated it. */
export function axeReported(axeResult, id) {
  if (axeResult?.status !== 'ok') return false;
  const d = axeResult.data || {};
  return (d.violations || []).some((v) => v.id === id) || (d.incomplete || []).some((v) => v.id === id);
}

/** Whether axe ran OK and found the rule a violation (needs review does not count). */
export function axeViolation(axeResult, id) {
  return axeResult?.status === 'ok' && (axeResult.data?.violations || []).some((v) => v.id === id);
}

/** The axe rule id that makes HARgus's finding redundant, or null. Only when axe ran OK and that rule was evaluated. */
export function suppressedBy(pluginId, findingKey, axeResult) {
  if (axeResult?.status !== 'ok' || !findingKey) return null;
  const row = OVERLAP.find((o) => o.ours === `${pluginId}:${findingKey}`);
  if (!row || row.mode !== 'suppress') return null;
  const rules = [].concat(row.axe);
  const test = row.when === 'violation' ? axeViolation : row.when === 'reported' ? axeReported : axeRan;
  return rules.every((id) => test(axeResult, id)) ? rules.join(', ') : null;
}
