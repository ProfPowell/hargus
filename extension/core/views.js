// Capture views: the device and resilience variants of a reading's screenshots. Pure helpers shared
// by the capture layer, the resilience plugin and the report.

export const DEVICE_VIEWS = ['desktop', 'tablet', 'mobile'];
export const RESILIENCE_VIEWS = ['nojs', 'nocss', 'noimages'];
/** Text ratio above which the no-CSS view is showing hidden content. */
export const NOCSS_HIDDEN = 1.3;
export const VIEWS = [...DEVICE_VIEWS, ...RESILIENCE_VIEWS];
export const VIEW_LABELS = {
  desktop: 'Desktop', tablet: 'Tablet', mobile: 'Phone', nojs: 'No JavaScript', nocss: 'No CSS', noimages: 'No images',
};

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
