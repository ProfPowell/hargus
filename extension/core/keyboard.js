// The keyboard walk: capture presses Tab from the top of the page (CDP key events) and records every
// focus stop in hp.capture.keyboard. walkEnd() decides when the walk stops; analyzeKeyboard() turns the
// recorded stops into findings. Pure.

export const KB_LIMITS = { stops: 250, ms: 60_000 };

/** Why the walk ended, in words for the report. */
export const ENDED_LABELS = {
  cycle: 'Focus came back to the first stop (a full cycle).',
  trap: 'Keyboard focus gets trapped: the same few elements repeat.',
  'left-page': 'Focus left the page.',
  cap: `Stopped after ${KB_LIMITS.stops} stops.`,
  time: `Stopped after ${KB_LIMITS.ms / 1000} s.`,
  navigated: 'The page navigated during the walk; the walk stopped there.',
};

const key = (s) => (s?.none ? '(none)' : s?.uid ?? s?.sel);
const real = (s) => s && !s.none;

/**
 * Given the stops so far and the new one, whether the walk ends here:
 * the first stop again (a cycle), the same 1–3 elements three times running (a trap), or focus off the page twice.
 * The ending stop is not recorded. A cross-origin frame stays the focused element while Tab moves inside it, so it never traps.
 */
export function walkEnd(prev, next) {
  const first = prev.find(real);
  if (next?.none) {
    // Twice in a row after reaching the page; or never reaching it in five presses.
    if (prev.at(-1)?.none && prev.some(real)) return { ended: 'left-page' };
    return prev.length >= 4 && !prev.some(real) ? { ended: 'left-page' } : null;
  }
  if (first && key(first) === key(next)) return { ended: 'cycle' };
  if (next?.frame) return null;
  const all = [...prev, next];
  for (let n = 1; n <= 3; n++) {
    if (all.length < n * 3) break;
    const tail = all.slice(-n * 3);
    const unit = tail.slice(0, n);
    if (unit.some((s) => !real(s)) || new Set(unit.map(key)).size !== n) continue;
    if (tail.every((s, i) => key(s) === key(unit[i % n]))) return { ended: 'trap', trapped: unit.map((s) => s.sel) };
  }
  return null;
}

/** A walk that ran to a natural end (or the stop cap) and reached at least one element. */
export function walkComplete(k) {
  return !!k && Array.isArray(k.stops) && ['cycle', 'trap', 'left-page', 'cap'].includes(k.ended) && k.stops.some(real);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const EVIDENCE = 10;
const evidence = (sels) => sels.slice(0, EVIDENCE).join('\n') + (sels.length > EVIDENCE ? `\n… and ${sels.length - EVIDENCE} more` : '');

/** Unique real stops by element (a trap repeats them). */
function uniqueStops(stops) {
  const seen = new Set();
  return stops.filter((s) => real(s) && !seen.has(key(s)) && seen.add(key(s)));
}

const goodTarget = (t) => !!t && t.exists && t.visible && (t.focusable || t.landmark || t.heading);

/**
 * Findings from a recorded walk. focusables: [{ selector, tabindex }] with a positive tabindex from the DOM;
 * clickables: [{ selector, text }] that look clickable but are not focusable.
 */
export function analyzeKeyboard(k, { focusables = [], clickables = [] } = {}) {
  const findings = [];
  if (!k || !Array.isArray(k.stops)) return { findings, summary: null };
  const add = (id, severity, title, ev, detail) => findings.push({ id, severity, title, ...(ev ? { evidence: ev } : {}), ...(detail ? { detail } : {}) });
  const stops = k.stops;
  const uniq = uniqueStops(stops);
  const sels = (xs) => xs.map((s) => s.sel);

  if (k.ended === 'trap') add('kb-trap', 'high', 'Keyboard focus gets trapped', evidence(k.trapped || []),
    'Pressing Tab keeps returning to the same elements, so keyboard users cannot reach the rest of the page (WCAG 2.1.2).');

  const firstReal = stops.findIndex(real);
  let lastReal = -1;
  stops.forEach((s, i) => { if (real(s)) lastReal = i; });
  const lost = firstReal < 0 ? 0 : stops.filter((s, i) => s.none && i > firstReal && i < lastReal).length;
  if (lost) add('kb-focus-lost', 'medium', `Focus is lost ${plural(lost, 'time', 'times')} while tabbing`, undefined,
    'Tab moved focus to nothing (the page body) between two elements; keyboard users lose their place.');

  const hidden = uniq.filter((s) => !s.visible || !s.onScreen);
  if (hidden.length) add('kb-hidden', 'medium', `${plural(hidden.length, 'keyboard stop is', 'keyboard stops are')} hidden or off-screen`, evidence(sels(hidden)),
    'Focus lands on something sighted keyboard users cannot see (WCAG 2.4.7, 2.4.11).');

  const noName = uniq.filter((s) => !String(s.name || '').trim());
  if (noName.length) add('kb-no-name', 'high', `${plural(noName.length, 'keyboard stop has', 'keyboard stops have')} no accessible name`, evidence(sels(noName)),
    'Screen readers announce only the role, so users cannot tell what the control does (WCAG 4.1.2).');

  const blind = uniq.filter((s) => s.changed === false);
  if (blind.length) add('kb-no-focus-style', 'medium', `${plural(blind.length, 'keyboard stop shows', 'keyboard stops show')} no visible focus change`, evidence(sels(blind)),
    'Neither outline, box shadow, border, background, underline nor colour changes when the element takes focus (WCAG 2.4.7).');

  const positive = new Map();
  for (const s of uniq) if (Number(s.tabindex) > 0) positive.set(s.sel, s.tabindex);
  for (const f of focusables) if (Number(f.tabindex) > 0 && !positive.has(f.selector)) positive.set(f.selector, f.tabindex);
  if (positive.size) add('kb-positive-tabindex', 'low', `${plural(positive.size, 'element uses', 'elements use')} a positive tabindex`, evidence([...positive.keys()]),
    'A positive tabindex pulls the element ahead of the page order, so Tab no longer follows the reading order (WCAG 2.4.3).');

  // A jump only counts on a full walk; an aborted walk leaves the DOM-inferred finding in place instead.
  if (walkComplete(k)) {
    const jumps = [];
    let prev = null;
    for (const s of stops) {
      if (!real(s) || !s.box || s.fixed) continue;
      if (prev && s.box.y < prev.box.y - 200 && s.box.x < prev.box.x + prev.box.w && s.box.x + s.box.w > prev.box.x) jumps.push(s);
      prev = s;
    }
    if (jumps.length) add('kb-jumps', 'low', `Tab order jumps back up the page ${plural(jumps.length, 'time', 'times')}`, evidence(sels(jumps)),
      'Focus moves more than 200 px back up the page within the same column (WCAG 2.4.3).');
  }

  const first = stops.find(real);
  if (first) {
    if (!first.skip) add('kb-no-skip-link', 'low', 'No skip link as the first stop', undefined,
      'The first Tab stop is not a same-page link, so keyboard users tab through the header on every page (WCAG 2.4.1).');
    else if (!goodTarget(first.skip)) {
      const t = first.skip;
      const why = !t.exists ? 'does not exist' : !t.visible ? 'is hidden' : 'is not focusable, a landmark or a heading';
      add('kb-skip-target', 'medium', "The skip link's target is missing or hidden", first.sel, `The first stop links to ${t.href}, whose target ${why}.`);
    }
  }

  const stopSels = new Set(sels(uniq));
  const unreachable = clickables.filter((c) => c?.selector && !stopSels.has(c.selector));
  if (unreachable.length) add('kb-clickable', 'medium', `${plural(unreachable.length, 'clickable element', 'clickable elements')} can't be reached by keyboard`,
    evidence(unreachable.map((c) => c.selector)), 'These respond to clicks (onclick, a button or link role) but are not focusable (WCAG 2.1.1).');

  const ended = k.ended === 'trap' ? 'trap' : k.ended;
  return {
    findings,
    summary: { label: 'Keyboard', value: `${uniq.length} stops${ended && ended !== 'cycle' ? ` · ${ended}` : ''}`, rating: findings.some((f) => f.severity === 'high') ? 'poor' : findings.length ? 'needs-improvement' : 'good' },
  };
}
