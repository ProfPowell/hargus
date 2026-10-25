// Focus-style probe helpers shared by capture (which forces :focus-visible via CDP) and the
// a11y-structure plugin (which turns the result into findings). Pure.

export const FOCUS_KINDS = ['inline-link', 'nav-link', 'button', 'text-input', 'select', 'checkbox', 'summary', 'custom'];
export const KIND_LABELS = {
  'inline-link': 'Inline links', 'nav-link': 'Navigation links', button: 'Buttons', 'text-input': 'Text fields',
  select: 'Select menus', checkbox: 'Checkboxes and radios', summary: 'Disclosure summaries', custom: 'Custom controls',
};

/** Which visible style properties changed between the unfocused and forced-focus computed styles. */
export function focusChanges(before, after) {
  if (!before || !after) return [];
  const out = [];
  const outlineOn = after.outlineStyle !== 'none' && parseFloat(after.outlineWidth) > 0;
  if (outlineOn && (before.outlineStyle !== after.outlineStyle || before.outlineWidth !== after.outlineWidth || before.outlineColor !== after.outlineColor)) out.push('outline');
  if (before.boxShadow !== after.boxShadow) out.push('box-shadow');
  if (before.borderColor !== after.borderColor || before.borderWidth !== after.borderWidth) out.push('border');
  if (before.backgroundColor !== after.backgroundColor) out.push('background');
  if (before.textDecorationLine !== after.textDecorationLine) out.push('underline');
  if (before.color !== after.color) out.push('color');
  return out;
}

/**
 * The first near element (wrapper, ancestor or child, or the element's own ::before/::after: rel 'self') whose style
 * changed on focus: { rel, changes, pseudo? }, else null.
 */
export function nearFocusChange(near) {
  for (const n of near || []) {
    const changes = focusChanges(n?.before, n?.after);
    if (changes.length) return { rel: n.rel, changes, ...(n.pseudo ? { pseudo: n.pseudo } : {}) };
  }
  return null;
}
