// Capture views: the device and resilience variants of a reading's screenshots. Pure helpers shared
// by the capture layer, the resilience plugin and the report.

export const DEVICE_VIEWS = ['desktop', 'tablet', 'mobile'];
export const RESILIENCE_VIEWS = ['nojs', 'nocss', 'noimages'];
export const INTERNATIONAL_VIEWS = ['rtl', 'translated-de', 'translated-ar', 'translated-ja', 'pseudo'];
/** Text ratio above which the no-CSS view is showing hidden content. */
export const NOCSS_HIDDEN = 1.3;
export const VISION_VIEWS = ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia', 'blurred', 'lowcontrast'];
export const DISPLAY_VIEWS = ['dark', 'forced', 'morecontrast', 'print'];
export const WCAG_VIEWS = ['spacing', 'reflow', 'text200'];
export const A11Y_VIEWS = [...VISION_VIEWS, ...DISPLAY_VIEWS, ...WCAG_VIEWS];
export const LAYOUT_VIEWS = [...DEVICE_VIEWS, ...RESILIENCE_VIEWS, ...INTERNATIONAL_VIEWS];
export const VIEWS = [...LAYOUT_VIEWS, ...A11Y_VIEWS];
export const VIEW_LABELS = {
  desktop: 'Desktop', tablet: 'Tablet', mobile: 'Phone', nojs: 'No JavaScript', nocss: 'No CSS', noimages: 'No images',
  rtl: 'Right-to-left', 'translated-de': 'German', 'translated-ar': 'Arabic', 'translated-ja': 'Japanese', pseudo: 'Long text',
  protanopia: 'Protanopia', deuteranopia: 'Deuteranopia', tritanopia: 'Tritanopia', achromatopsia: 'Achromatopsia',
  blurred: 'Blurred vision', lowcontrast: 'Reduced contrast',
  dark: 'Dark mode', forced: 'Forced colours', morecontrast: 'More contrast', print: 'Print',
  spacing: 'Text spacing', reflow: '320 px reflow', text200: '200% text', breakpoints: 'Breakpoints',
};
/** Emulation.setEmulatedVisionDeficiency types per vision view. */
export const VISION_DEFICIENCY = {
  protanopia: 'protanopia', deuteranopia: 'deuteranopia', tritanopia: 'tritanopia',
  achromatopsia: 'achromatopsia', blurred: 'blurredVision', lowcontrast: 'reducedContrast',
};
/** Emulation.setEmulatedMedia parameters per display view. */
export const MEDIA_EMULATION = {
  dark: { features: [{ name: 'prefers-color-scheme', value: 'dark' }] },
  forced: { features: [{ name: 'forced-colors', value: 'active' }] },
  morecontrast: { features: [{ name: 'prefers-contrast', value: 'more' }] },
  print: { media: 'print' },
};
/** WCAG 1.4.12 text-spacing overrides. */
export const SPACING_CSS = '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }\np { margin-bottom: 2em !important; }';

/** The view the main capture used: its device, or desktop. */
export function baseView(reading) {
  const d = reading.log._harplus?.capture?.device;
  return DEVICE_VIEWS.includes(d) ? d : 'desktop';
}

/** Breakpoint-edge views are named bp<b>-below (b−1 px) and bp<b>-at (b px). */
export const BREAKPOINT_VIEW = /^bp(\d+)-(below|at)$/;
export const isBreakpointView = (id) => BREAKPOINT_VIEW.test(String(id ?? ''));

/** A screenshot's view; readings from before views were added have none and belong to the base view. */
export const shotView = (shot, base) => (VIEWS.includes(shot?.view) || isBreakpointView(shot?.view) ? shot.view : base);

/** { [view]: { viewport: { shot, index }, fullpage: { shot, index } } } — index points into screenshots. */
export function shotsByView(reading) {
  const base = baseView(reading);
  const out = {};
  (reading.log._harplus?.screenshots || []).forEach((shot, index) => {
    if (shot.kind !== 'viewport' && shot.kind !== 'fullpage') return;
    const slot = (out[shotView(shot, base)] ||= {});
    if (!slot[shot.kind]) slot[shot.kind] = { shot, index };
  });
  return out;
}

/** n as a share of base; a base of 0 means there was nothing to lose, so 1. */
export const ratio = (n, base) => (base > 0 ? (n || 0) / base : 1);

/** Ratios of every measured view against the base view's measurement, or null without a base. */
export function compareViews(views, base) {
  const b = views?.[base];
  if (!b) return null;
  const out = {};
  for (const [id, m] of Object.entries(views)) {
    out[id] = { ...m, textRatio: ratio(m.text, b.text), linkRatio: ratio(m.links, b.links) };
  }
  return { base, views: out };
}

export const ratingFor = (r) => (r >= 0.8 ? 'good' : r >= 0.2 ? 'needs-improvement' : 'poor');

/* Accessibility views: thresholds and comparisons shared by the a11y-views plugin and the report's chips. */
/** Extra clipped text boxes (beyond the base view) that count as a problem. */
export const A11Y_CLIP_EXTRA = 3;
/** Horizontal overflow smaller than this (px) is scrollbar or sub-pixel noise, not a finding. */
export const A11Y_MIN_OVERFLOW = 8;
/** Background luminance above which a page looks light. */
export const A11Y_LIGHT_BG = 0.5;
/** forced-color-adjust: none roots that count as a problem. */
export const A11Y_FORCED_OPT_OUTS = 20;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const known = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
/** Text boxes clipped in a view beyond the base; 0 when either walk was truncated (the counts are not comparable). */
export const extraClipped = (m, base) => (m?.truncated || base?.truncated ? 0 : num(m?.clipped) - num(base?.clipped));
/** Horizontal overflow at 320 px beyond the base's own; 0 when html or body clips overflow-x (nothing scrolls). */
export const reflowScroll = (m, base) => (m?.rootClipX ? 0 : Math.max(0, num(m?.overflowX) - num(base?.overflowX)));
/** 'already dark' (the base looks dark), 'no change' (still light in dark mode), 'changes', or null if unmeasured. */
export function darkState(m, base) {
  if (!known(m?.bg) || !known(base?.bg)) return null;
  if (num(base.bg) < A11Y_LIGHT_BG) return 'already dark';
  return num(m.bg) > A11Y_LIGHT_BG ? 'no change' : 'changes';
}

export function viewLabel(id) {
  const m = String(id ?? '').match(BREAKPOINT_VIEW);
  if (m) { const b = Number(m[1]); return `${m[2] === 'below' ? b - 1 : b} px`; }
  return VIEW_LABELS[id] || String(id);
}

/** [[mediaQuery, ruleCount], …] → up to 2 breakpoints (first px width of the new layout), busiest first. */
export function pickBreakpoints(media = []) {
  const totals = new Map();
  const px = (n, unit) => n * (/^r?em$/i.test(unit) ? 16 : 1);
  for (const [q, count] of media || []) {
    const n = Number(count) || 1;
    const add = (v) => { if (v >= 320 && v <= 1920) totals.set(v, (totals.get(v) || 0) + n); };
    for (const m of String(q).matchAll(/(min|max)-width\s*:\s*([\d.]+)(px|em|rem)/gi)) {
      const v = px(parseFloat(m[2]), m[3]);
      add(m[1].toLowerCase() === 'min' ? Math.ceil(v) : Math.floor(v) + 1);
    }
    for (const m of String(q).matchAll(/width\s*(>=|<=|>|<)\s*([\d.]+)(px|em|rem)/gi)) {
      const v = px(parseFloat(m[2]), m[3]);
      add(m[1] === '>=' || m[1] === '<' ? Math.ceil(v) : Math.floor(v) + 1);
    }
  }
  return [...totals].sort((a, b) => b[1] - a[1] || b[0] - a[0]).slice(0, 2).map(([v]) => v);
}

/**
 * A breakpoint-edge view's sideways overflow; 0 when html or body clips overflow-x (nothing can scroll sideways)
 * or the page was measured as not really scrolling (scrollsX false: a stale scrollWidth). scrollsX is undefined on older readings.
 */
export const edgeOverflow = (v) => (v?.rootClipX || v?.scrollsX === false ? 0 : num(v?.overflowX));
/** Text boxes clipped in an edge view beyond both the other edge view and the base; 0 when any walk was truncated. */
export const edgeClipExtra = (v, other, baseM) => (!v || v.truncated || other?.truncated || baseM?.truncated
  ? 0 : num(v.clipped) - Math.max(num(other?.clipped), num(baseM?.clipped)));
/** Extra clipped text boxes at which an edge view raises a finding. */
export const EDGE_CLIP_MIN = 3;
/** The id of the other view at the same breakpoint (bp900-below ↔ bp900-at). */
export const edgePartner = (id) => String(id).replace(/-(below|at)$/, (_, s) => (s === 'below' ? '-at' : '-below'));

/** Overflow or clipping that appears only on one side of a breakpoint. */
export function breakpointFindings(views = {}, breakpoints = [], baseM = {}) {
  const out = [];
  for (const b of breakpoints || []) {
    const below = views[`bp${b}-below`];
    const at = views[`bp${b}-at`];
    for (const [v, other, w, where] of [[below, at, b - 1, 'below'], [at, below, b, 'at']]) {
      if (!v) continue;
      // Edge-only overflow needs both edge views: with one failed or skipped there is nothing to compare.
      if (other && edgeOverflow(v) > 0 && edgeOverflow(other) === 0 && edgeOverflow(baseM) === 0) {
        const culprits = (v.overflowers || []).map((o) => `${o.selector} (${Math.round(o.width)} px)`).join(', ');
        // Each culprit's selector finds the element that is wider than the viewport: a place, with its width.
        const places = (v.overflowers || []).filter((o) => typeof o?.selector === 'string' && o.selector.trim()).slice(0, 200)
          .map((o) => ({ selector: o.selector, ...(Number.isFinite(Number(o.width)) ? { note: `${Math.round(o.width)} px` } : {}) }));
        out.push({ severity: 'medium', category: 'quality', title: `Layout breaks at ${w} px (just ${where} the ${b} px breakpoint)`, ...(culprits ? { detail: `Wider than the viewport: ${culprits}` } : {}), ...(places.length ? { places } : {}) });
      }
      if (edgeClipExtra(v, other, baseM) >= EDGE_CLIP_MIN) {
        out.push({ severity: 'low', category: 'quality', title: `Text clips at ${w} px near the ${b} px breakpoint` });
      }
    }
  }
  return out;
}

/** Views whose self-check failed: their measurements may not reflect the setting. */
export const failedChecks = (reading) => Object.entries(reading.log._harplus?.capture?.viewChecks || {}).filter(([, c]) => c?.ok === false);
