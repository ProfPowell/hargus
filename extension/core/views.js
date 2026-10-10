// Capture views: the device and resilience variants of a reading's screenshots. Pure helpers shared
// by the capture layer, the resilience plugin and the report.

export const DEVICE_VIEWS = ['desktop', 'tablet', 'mobile'];
export const RESILIENCE_VIEWS = ['nojs', 'nocss', 'noimages'];
export const INTERNATIONAL_VIEWS = ['rtl', 'pseudo'];
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
  rtl: 'Right-to-left', pseudo: 'Long text',
  protanopia: 'Protanopia', deuteranopia: 'Deuteranopia', tritanopia: 'Tritanopia', achromatopsia: 'Achromatopsia',
  blurred: 'Blurred vision', lowcontrast: 'Reduced contrast',
  dark: 'Dark mode', forced: 'Forced colours', morecontrast: 'More contrast', print: 'Print',
  spacing: 'Text spacing', reflow: '320 px reflow', text200: '200% text',
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

/** A screenshot's view; readings from before views were added have none and belong to the base view. */
export const shotView = (shot, base) => (VIEWS.includes(shot?.view) ? shot.view : base);

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
