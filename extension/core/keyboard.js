// The keyboard walk: capture presses Tab from the top of the page (CDP key events) and records every
// focus stop in hp.capture.keyboard. walkEnd() decides when the walk stops; analyzeKeyboard() turns the
// recorded stops into findings. Pure.

// stops: a backstop (time is the real bound); framePresses: Tab presses one frame may hold focus for before the
// walk counts it as confinement; confineShare: a walk that cycles or traps with fewer unique stops than this share
// of the page's focusable elements, all in one container, is confined to it.
export const KB_LIMITS = { stops: 2000, ms: 60_000, framePresses: 50, confineShare: 0.25 };

/**
 * Consent tools. `sels`: the tool's containers (and consent iframes), used to find a banner visible at load and to
 * name the container focus is confined to (the outermost match). `[class*=termly]` and `.klaro` are broad, so they
 * only ever name containers. `parts`: the tool's own overlay or backdrop elements, the only extra elements hidden with
 * the container when it is set aside (and only beside the container or its ancestors).
 */
export const CMP_TOOLS = [
  { tool: 'OneTrust', sels: ['#onetrust-consent-sdk', '#onetrust-banner-sdk', '#onetrust-pc-sdk'], parts: ['.onetrust-pc-dark-filter'] },
  { tool: 'Cookiebot', sels: ['#CybotCookiebotDialog'], parts: ['#CybotCookiebotDialogBodyUnderlay'] },
  { tool: 'TrustArc', sels: ['#truste-consent-track', '.truste_box_overlay', '.truste_overlay', 'iframe[src*="consent.trustarc"]', 'iframe[src*="trustarc"]', 'iframe[id^="pop-frame"]'], parts: ['.truste_overlay'] },
  { tool: 'Usercentrics', sels: ['#usercentrics-root', '#usercentrics-cmp-ui'], parts: [] },
  { tool: 'Didomi', sels: ['#didomi-host'], parts: ['.didomi-popup-backdrop'] },
  { tool: 'Osano', sels: ['.osano-cm-window', '.osano-cm-dialog'], parts: [] },
  { tool: 'Quantcast', sels: ['.qc-cmp2-container', '#qc-cmp2-container'], parts: [] },
  { tool: 'CookieYes', sels: ['.cky-consent-container', '.cky-modal'], parts: ['.cky-overlay'] },
  { tool: 'Iubenda', sels: ['#iubenda-cs-banner'], parts: [] },
  { tool: 'Termly', sels: ['#termly-code-snippet-support', '[class*="termly"]'], parts: [] },
  { tool: 'Klaro', sels: ['.klaro'], parts: [] },
  { tool: 'Complianz', sels: ['#cmplz-cookiebanner-container', '.cmplz-cookiebanner'], parts: [] },
  { tool: 'Sourcepoint', sels: ['[id^="sp_message_container"]', 'iframe[id^="sp_message_iframe"]'], parts: ['.sp_veil'] },
];

/** "2,000": counts in words for the report. */
const num = (n) => Number(n).toLocaleString('en-US');

/** Why the walk ended, in words for the report. */
export const ENDED_LABELS = {
  cycle: 'Focus came back to the first stop (a full cycle).',
  trap: 'Keyboard focus gets trapped: the same few elements repeat.',
  'left-page': 'Focus left the page.',
  cap: `Stopped after ${num(KB_LIMITS.stops)} stops; the rest of the page was not walked.`,
  time: `Stopped after ${KB_LIMITS.ms / 1000} s; the rest of the page was not walked.`,
  frame: `Focus stayed inside a frame for more than ${KB_LIMITS.framePresses} presses and the walk could not move past it; it stopped there.`,
  navigated: 'The page navigated during the walk; the walk stopped there.',
  error: 'The walk stopped on an error:',
};

const key = (s) => (s?.none ? '(none)' : s?.uid ?? s?.sel);
const real = (s) => s && !s.none;

/**
 * Given the stops so far and the new one, whether the walk ends here:
 * the first stop again (a cycle), the same 1–3 elements three times running (a trap), or focus off the page twice.
 * Back at the first stop without focus ever leaving the page, after only 1–3 elements, is a trap too (a trap on
 * the first stop, or a modal open on load): `onFirst` marks it, as a very small page can wrap the same way.
 * The ending stop is not recorded. A cross-origin frame stays the focused element while Tab moves inside it, so it never traps.
 */
export function walkEnd(prev, next) {
  const first = prev.find(real);
  if (next?.none) {
    // Twice in a row after reaching the page; or never reaching it in five presses.
    if (prev.at(-1)?.none && prev.some(real)) return { ended: 'left-page' };
    return prev.length >= 4 && !prev.some(real) ? { ended: 'left-page' } : null;
  }
  if (first && key(first) === key(next)) {
    const since = prev.slice(prev.indexOf(first));
    const uniq = [...new Map(since.filter(real).map((s) => [key(s), s.sel])).values()];
    if (!since.some((s) => s.none) && uniq.length <= 3) return { ended: 'trap', trapped: uniq, onFirst: true };
    return { ended: 'cycle' };
  }
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

/**
 * A walk that saw the page: it ran to a natural end (not the stop or time cap, a frame, a navigation or an error),
 * reached at least one element and was not confined to a dialog it could not set aside.
 */
export function walkComplete(k) {
  return !!k && Array.isArray(k.stops) && ['cycle', 'trap', 'left-page'].includes(k.ended) && k.stops.some(real) && !k.confined;
}

/** Unique real stops (by element) of a list of stops. */
export const uniqueCount = (stops) => new Set((stops || []).filter(real).map(key)).size;

/**
 * After the first phase: whether the walk looks confined to one container, so capture.js asks the page what holds
 * focus. It cycled or trapped with unique stops under KB_LIMITS.confineShare of the page's focusable elements.
 * (A frame holding focus is decided on its own, by frameAction.)
 */
export function confinedCandidate(ended, stops, focusableCount) {
  const n = uniqueCount(stops);
  if (!n) return false;
  return (ended === 'cycle' || ended === 'trap') && Number(focusableCount) > 0 && n < KB_LIMITS.confineShare * Number(focusableCount);
}

/**
 * Whether the container kbConfine named is a banner to set aside: a consent tool's, a dialog, or a fixed or sticky
 * box with a high z-index that is about cookies or consent. A fixed widget that traps focus without any of that is a
 * plain trap (kb-trap), not a banner.
 */
export function isBanner(held) {
  if (!held?.kind) return false;
  if (held.kind === 'cmp' || held.kind === 'dialog') return true;
  return held.kind === 'fixed' && !!held.consent && !held.wrapper;
}

/**
 * A frame held focus past KB_LIMITS.framePresses. kbConfine was asked about the frame alone: in the first phase, a
 * frame that is (or sits in) a banner is set aside like one ('banner'); any other frame is walked past ('skip'), and
 * the walk goes on after it.
 */
export function frameAction(held, { phase = 1 } = {}) {
  return phase === 1 && isBanner(held) ? 'banner' : 'skip';
}

/**
 * A container that is not a banner counts as confinement only when the walk trapped in it, or it holds far fewer
 * focusable elements than the page (under KB_LIMITS.confineShare of focusableCount, which leaves out inert subtrees).
 * An app wrapper (#root, #__next, ...) or a container with half the page's focusables or more never does.
 */
export function confinedVerdict(ended, held, focusableCount) {
  if (!held || held.wrapper) return false;
  const total = Number(focusableCount);
  const inside = Number(held.inside);
  if (total > 0 && Number.isFinite(inside) && inside >= total / 2) return false;
  if (ended === 'trap') return true;
  return total > 0 && Number.isFinite(inside) && inside < KB_LIMITS.confineShare * total;
}

/** A cycle may end on presses that left the page (the browser's own UI) before Tab came back: not focus lost. */
export function dropTrailingNone(stops, ended) {
  if (ended !== 'cycle') return stops;
  const out = [...stops];
  while (out.length && out.at(-1)?.none) out.pop();
  return out;
}

/** A trap detected only by returning to the first stop, on a page with no more focusable elements than it reached: just a small page. */
const smallPage = (k, focusableCount) => k.trapOnFirst && Number.isFinite(focusableCount) && focusableCount <= new Set(k.stops.filter(real).map(key)).size;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const EVIDENCE = 10;
const evidence = (sels) => sels.slice(0, EVIDENCE).join('\n') + (sels.length > EVIDENCE ? `\n… and ${sels.length - EVIDENCE} more` : '');

/** Unique real stops by element (a trap repeats them). */
function uniqueStops(stops) {
  const seen = new Set();
  return stops.filter((s) => real(s) && !seen.has(key(s)) && seen.add(key(s)));
}

/**
 * The walk's first stop on the page itself: the first real stop after the leading run of stops inside a consent
 * banner (an inline banner placed before the skip link, say). Undefined when there is none.
 */
export function firstPageStop(stops) {
  return (stops || []).find((s) => real(s) && !s.inConsent);
}

/** The selector of the walk's first page stop (firstPageStop) when it is a skip link (a same-page link), else null. */
export function skipLinkStop(k) {
  const first = firstPageStop(k?.stops);
  return first?.skip && first.sel ? first.sel : null;
}

const goodTarget = (t) => !!t && t.exists && t.visible && (t.focusable || t.landmark || t.heading);

/**
 * Findings from a recorded walk. focusables: [{ selector, tabindex }] with a positive tabindex from the DOM;
 * clickables: [{ selector, text }] that look clickable but are not focusable; focusableCount: focusable elements in
 * the DOM; nameCovered: selectors of unnamed stops axe already reported under its name rules (left out here).
 */
export function analyzeKeyboard(k, { focusables = [], clickables = [], focusableCount, nameCovered = [] } = {}) {
  const findings = [];
  if (!k || !Array.isArray(k.stops)) return { findings, summary: null };
  const add = (id, severity, title, ev, detail) => findings.push({ id, severity, title, ...(ev ? { evidence: ev } : {}), ...(detail ? { detail } : {}) });
  const stops = k.stops;
  const banner = k.banner && typeof k.banner === 'object' ? k.banner : null;
  const bannerStops = Array.isArray(banner?.stops) ? banner.stops : [];
  const uniq = uniqueStops(stops);
  // The per-stop checks (name, focus style) judge the banner's stops too.
  const judged = uniqueStops([...bannerStops, ...stops]);
  const sels = (xs) => xs.map((s) => s.sel);
  const complete = walkComplete(k);

  if (k.ended === 'trap' && !smallPage(k, focusableCount)) add('kb-trap', 'high', 'Keyboard focus gets trapped', evidence(k.trapped || []),
    'Pressing Tab keeps returning to the same elements, so keyboard users cannot reach the rest of the page (WCAG 2.1.2).');

  // A banner or dialog open on load that held focus: judged as one, then the walk carried on behind it.
  if (banner) {
    const what = banner.consent === false ? 'Dialog open on load' : 'Cookie banner';
    const n = uniqueCount(bannerStops.length ? bannerStops : stops);
    const how = banner.setAside ? ' HARgus set it aside (without choosing anything) and walked the page behind it.' : '';
    if (banner.modal) add('kb-banner-modal', 'info', `${what} holds keyboard focus as a modal dialog`, banner.sel,
      `Tab stays inside it (${plural(n, 'stop', 'stops')}), as a modal dialog should until it is closed.${how}`);
    else add('kb-banner-trap', 'medium', `${what} traps keyboard focus but isn't a modal dialog`, banner.sel,
      `Tab stays inside it (${plural(n, 'stop', 'stops')}), yet it is not marked up as a modal (role="dialog" with aria-modal="true", or a <dialog> opened with showModal()), so screen reader users are not told the rest of the page is out of reach.${how}`);
  }
  // A consent banner visible at load that no stop of a full walk landed in.
  const consent = k.consent && typeof k.consent === 'object' ? k.consent : null;
  if (consent && !banner && complete && ![...bannerStops, ...stops].some((s) => real(s) && s.inConsent)) {
    add('kb-banner-unreachable', 'high', "Cookie banner can't be reached by keyboard", consent.sel,
      `A consent banner${consent.tool ? ` (${consent.tool})` : ''} is shown on load, but pressing Tab through the whole page never reaches it, so keyboard users cannot accept or decline.`);
  }
  // A trap is already reported as kb-trap; the walk is still marked partial (walkComplete) but not reported twice.
  if (k.confined && typeof k.confined === 'object' && k.ended !== 'trap') {
    const reached = Number(k.confined.reached) || 0;
    const all = Number(k.confined.total) || 0;
    add('kb-confined', 'info', `Keyboard walk confined to one part of the page from the start; ${num(Math.max(0, all - reached))} of ${num(all)} focusable elements not reached`, k.confined.sel,
      'Tab stayed inside one container from the start and HARgus could not set it aside, so the rest of the page was not walked. Page-wide order findings come from the DOM checks instead.');
  }
  if (['cap', 'time', 'frame'].includes(k.ended)) {
    const at = Number.isFinite(k.reachedY) ? `page y ${num(Math.round(k.reachedY))}${Number.isFinite(k.docH) ? ` of ${num(Math.round(k.docH))}` : ''}` : 'page y unknown';
    add('kb-stopped', 'info', `Keyboard walk stopped at ${num(uniq.length)} ${uniq.length === 1 ? 'stop' : 'stops'} (${at}); the rest wasn't walked`, undefined,
      `${ENDED_LABELS[k.ended]} Page-wide order findings (skip link, jumps) come from the DOM checks instead.`);
  }

  const firstReal = stops.findIndex(real);
  let lastReal = -1;
  stops.forEach((s, i) => { if (real(s)) lastReal = i; });
  const lost = firstReal < 0 ? 0 : stops.filter((s, i) => s.none && !s.left && i > firstReal && i < lastReal).length;
  if (lost) add('kb-focus-lost', 'medium', `Focus is lost ${plural(lost, 'time', 'times')} while tabbing`, undefined,
    'Tab moved focus to nothing (the page body) between two elements; keyboard users lose their place.');

  const hidden = uniq.filter((s) => !s.visible || !s.onScreen);
  if (hidden.length) add('kb-hidden', 'medium', `${plural(hidden.length, 'keyboard stop is', 'keyboard stops are')} hidden or off-screen`, evidence(sels(hidden)),
    'Focus lands on something sighted keyboard users cannot see (WCAG 2.4.7, 2.4.11).');

  const covered = new Set(nameCovered);
  const noName = judged.filter((s) => !String(s.name || '').trim() && !covered.has(s.sel));
  if (noName.length) add('kb-no-name', 'high', `${plural(noName.length, 'keyboard stop has', 'keyboard stops have')} no accessible name`, evidence(sels(noName)),
    'Screen readers announce only the role, so users cannot tell what the control does (WCAG 4.1.2).');

  const blind = judged.filter((s) => s.changed === false && !s.frame);
  if (blind.length) add('kb-no-focus-style', 'medium', `${plural(blind.length, 'keyboard stop shows', 'keyboard stops show')} no visible focus change`, evidence(sels(blind)),
    'Neither outline, box shadow, border, background, underline nor colour changes when the element takes focus (WCAG 2.4.7).');

  const positive = new Map();
  for (const s of uniq) if (Number(s.tabindex) > 0) positive.set(s.sel, s.tabindex);
  for (const f of focusables) if (Number(f.tabindex) > 0 && !positive.has(f.selector)) positive.set(f.selector, f.tabindex);
  if (positive.size) add('kb-positive-tabindex', 'low', `${plural(positive.size, 'element uses', 'elements use')} a positive tabindex`, evidence([...positive.keys()]),
    'A positive tabindex pulls the element ahead of the page order, so Tab no longer follows the reading order (WCAG 2.4.3).');

  // Page-wide order findings need a walk that saw the page; a partial one leaves the DOM-inferred finding in place.
  if (complete) {
    const jumps = [];
    let prev = null;
    for (const s of stops) {
      if (!real(s) || !s.box || s.fixed || !s.visible || !s.onScreen) continue;
      if (prev && s.box.y < prev.box.y - 200 && s.box.x < prev.box.x + prev.box.w && s.box.x + s.box.w > prev.box.x) jumps.push(s);
      prev = s;
    }
    if (jumps.length) add('kb-jumps', 'low', `Tab order jumps back up the page ${plural(jumps.length, 'time', 'times')}`, evidence(sels(jumps)),
      'Focus moves more than 200 px back up the page within the same column (WCAG 2.4.3).');
  }

  // A cookie banner shown in the page phase (not set aside) that stops sat behind while they had focus.
  const obscured = uniq.filter((s) => s.obscured === 'full');
  if (obscured.length) {
    const half = uniq.filter((s) => s.obscured === 'half').length;
    add('kb-obscured', 'medium', `${plural(obscured.length, 'keyboard stop is', 'keyboard stops are')} hidden behind the cookie banner`, evidence(sels(obscured)),
      `The cookie banner${consent?.sel ? ` (${consent.sel})` : ''} stays on screen and covers them while they have focus, so sighted keyboard users cannot see where they are (WCAG 2.4.11).${half ? ` ${plural(half, 'more is', 'more are')} half covered.` : ''}`);
  }

  // The skip link is judged on the first stop after any banner stops at the start (an inline cookie banner).
  const first = firstPageStop(stops);
  if (first) {
    if (!first.skip) {
      if (complete) add('kb-no-skip-link', 'low', 'No skip link as the first stop', undefined,
        'The first Tab stop is not a same-page link, so keyboard users tab through the header on every page (WCAG 2.4.1).');
    } else if (!goodTarget(first.skip)) {
      const t = first.skip;
      const [title, why] = !t.exists ? ["The skip link's target is missing", 'does not exist']
        : !t.visible ? ["The skip link's target is hidden", 'is hidden']
        : ["The skip link's target can't take focus", 'is not focusable, a landmark or a heading'];
      add('kb-skip-target', 'medium', title, first.sel, `The first stop links to ${t.href}, whose target ${why}.`);
    }
  }

  const stopSels = new Set(sels(judged));
  const unreachable = clickables.filter((c) => c?.selector && !stopSels.has(c.selector));
  if (unreachable.length) add('kb-clickable', 'medium', `${plural(unreachable.length, 'clickable element', 'clickable elements')} can't be reached by keyboard`,
    evidence(unreachable.map((c) => c.selector)), 'These respond to clicks (onclick, a button or link role) but are not focusable (WCAG 2.1.1).');

  const ended = k.confined ? 'confined' : k.ended;
  const extra = [ended && ended !== 'cycle' ? ended : '', bannerStops.length ? `banner ${uniqueCount(bannerStops)}` : ''].filter(Boolean);
  const rated = findings.filter((f) => f.severity !== 'info');
  return {
    findings,
    summary: { label: 'Keyboard', value: `${uniq.length} stops${extra.length ? ` · ${extra.join(' · ')}` : ''}`, rating: rated.some((f) => f.severity === 'high') ? 'poor' : rated.length ? 'needs-improvement' : 'good' },
  };
}
