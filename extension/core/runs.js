// Run-to-run spread: the median and range of a timing across 3 or 5 loads, and whether it varies enough to say so.
// Pure: no imports. Used by capture (to fold the runs) and the vitals plugin.

/** A range wider than this share of the median counts as varying. */
export const VARIES_PCT = 0.25;
/** ...unless it is also at least this many ms (applied to the timings that use a floor). */
export const VARIES_FLOOR_MS = 100;
/** The timings kept from each run, in display order. */
export const RUN_METRICS = ['lcp', 'fcp', 'ttfb', 'cls', 'blockingTime', 'domContentLoaded', 'load'];

const finite = (values) => (values || []).filter((v) => typeof v === 'number' && Number.isFinite(v));

/** Median of the finite values (mean of the middle two when even); null when none are left. */
export function median(values) {
  const v = finite(values).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** One run's timings, flattened from a vitals collect() result. Missing ones are null. */
export function sampleOf(collected) {
  const c = collected || {};
  const n = c.navigation;
  return {
    lcp: c.lcp?.time ?? null,
    fcp: c.fcp ?? null,
    ttfb: n?.ttfb ?? null,
    cls: c.cls ?? null,
    blockingTime: c.blockingTime ?? null,
    domContentLoaded: n?.domContentLoaded ?? null,
    load: n?.load ?? null,
  };
}

/** Median, range and "varies" for one timing across runs; null with fewer than 2 finite values. */
export function spread(values, { bands, pctRule = true, floor = 0 } = {}) {
  const v = finite(values);
  if (v.length < 2) return null;
  const min = Math.min(...v);
  const max = Math.max(...v);
  const med = median(v);
  const out = { median: med, min, max, n: v.length, varies: false };
  if (bands) {
    const [good, poor] = bands;
    out.bands = { good: 0, 'needs improvement': 0, poor: 0 };
    for (const x of v) out.bands[x <= good ? 'good' : x <= poor ? 'needs improvement' : 'poor']++;
    out.varies = Object.values(out.bands).filter(Boolean).length > 1;
  }
  const range = max - min;
  if (pctRule && range > VARIES_PCT * med && range >= floor) out.varies = true;
  return out;
}

/** The spread of every timing across the runs' samples. limits: { metric: [good, poor] } for the banded ones. */
export function spreadAll(samples, limits = {}) {
  const col = (m) => (samples || []).map((s) => s?.[m]);
  return {
    lcp: spread(col('lcp'), { bands: limits.lcp }),
    fcp: spread(col('fcp'), { bands: limits.fcp }),
    ttfb: spread(col('ttfb'), { bands: limits.ttfb, floor: VARIES_FLOOR_MS }),
    cls: spread(col('cls'), { bands: limits.cls, pctRule: false }),
    blockingTime: spread(col('blockingTime'), { bands: limits.blockingTime, pctRule: false }),
    domContentLoaded: spread(col('domContentLoaded'), { floor: VARIES_FLOOR_MS }),
    load: spread(col('load'), { floor: VARIES_FLOOR_MS }),
  };
}
