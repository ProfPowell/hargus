// Pixel statistics for view self-checks. Pure: callers decode the screenshot to RGBA first.

export const THUMB = { w: 64, h: 40 };

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Mean saturation, RMS neighbour luminance difference (edge), p95−p5 luminance (spread), and a small RGB thumbnail. */
export function imageStats(rgba, width, height) {
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40000))); // sample ~40k pixels
  let satSum = 0, n = 0, edgeSum = 0, en = 0;
  const lums = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      satSum += mx ? (mx - mn) / mx : 0; n++;
      const l = lum(r, g, b); lums.push(l);
      if (x + step < width) { const j = i + step * 4; const d = l - lum(rgba[j], rgba[j + 1], rgba[j + 2]); edgeSum += d * d; en++; }
    }
  }
  lums.sort((a, b) => a - b);
  const q = (p) => lums[Math.min(lums.length - 1, Math.floor(p * lums.length))] ?? 0;
  const { w: tw, h: th } = THUMB;
  const thumb = new Uint8Array(tw * th * 3);
  for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
    const x = Math.min(width - 1, Math.floor(((tx + 0.5) * width) / tw)), y = Math.min(height - 1, Math.floor(((ty + 0.5) * height) / th));
    const i = (y * width + x) * 4, o = (ty * tw + tx) * 3;
    thumb[o] = rgba[i]; thumb[o + 1] = rgba[i + 1]; thumb[o + 2] = rgba[i + 2];
  }
  return { sat: n ? satSum / n : 0, edge: en ? Math.sqrt(edgeSum / en) : 0, spread: q(0.95) - q(0.05), thumb, tw, th };
}

const changedShare = (a, b) => {
  if (!a?.thumb || !b?.thumb || a.thumb.length !== b.thumb.length) return 0;
  let changed = 0;
  for (let p = 0; p < a.thumb.length; p += 3) {
    if (Math.max(Math.abs(a.thumb[p] - b.thumb[p]), Math.abs(a.thumb[p + 1] - b.thumb[p + 1]), Math.abs(a.thumb[p + 2] - b.thumb[p + 2])) > 8) changed++;
  }
  return changed / (a.thumb.length / 3);
};
const pct = (x) => `${Math.round(x * 100)}%`;

// Chrome's vision-deficiency simulation matrices (Machado et al. 2009, severity 1).
const CVD = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};
const toLin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const toSrgb = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The share of the reference thumbnail this deficiency's filter clearly moves: by more than 16/255, well above the
 * 8/255 the check counts, so a shift that compression noise can hide is not demanded. Chrome filters in linear RGB.
 */
export function expectedShift(view, ref) {
  const m = CVD[view];
  if (!m || !ref?.thumb) return 0;
  const t = ref.thumb;
  let n = 0;
  for (let p = 0; p < t.length; p += 3) {
    const l = [toLin(t[p]), toLin(t[p + 1]), toLin(t[p + 2])];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(toSrgb(clamp(m[i * 3] * l[0] + m[i * 3 + 1] * l[1] + m[i * 3 + 2] * l[2], 0, 1)) - t[p + i]) > 16) { n++; break; }
    }
  }
  return n / (t.length / 3);
}

/** Did a vision view's shot really show its filter, relative to a reference shot of the same frozen page? */
export function visionCheck(view, stats, ref) {
  if (!stats || !ref) return { ok: true, detail: 'not measured' };
  const colour = ['achromatopsia', 'protanopia', 'deuteranopia', 'tritanopia'].includes(view);
  if (colour && ref.sat < 0.02) return { ok: true, detail: 'page has no colour to change' };
  if (view === 'achromatopsia') return stats.sat <= 0.03 ? { ok: true, detail: `saturation ${stats.sat.toFixed(3)}` } : { ok: false, detail: `still in colour (saturation ${stats.sat.toFixed(3)})` };
  if (colour) {
    const share = changedShare(stats, ref);
    // Judge the shift against what this deficiency would do to this page: deuteranopia hardly moves a blue-and-white page.
    const expected = expectedShift(view, ref);
    if (expected < 0.01 && share < 0.02) return { ok: true, detail: `${view} barely changes this page (${pct(expected)} of pixels expected to shift)` };
    return share >= Math.min(0.02, expected / 2) ?{ ok: true, detail: `${pct(share)} of pixels shifted` } : { ok: false, detail: `colours unchanged (${pct(share)} of pixels shifted)` };
  }
  if (view === 'blurred') return stats.edge <= 0.75 * ref.edge ? { ok: true, detail: `edges ${pct(stats.edge / (ref.edge || 1))} of normal` } : { ok: false, detail: `not blurred (edges ${pct(stats.edge / (ref.edge || 1))} of normal)` };
  if (view === 'lowcontrast') return stats.spread <= 0.8 * ref.spread ? { ok: true, detail: `contrast ${pct(stats.spread / (ref.spread || 1))} of normal` } : { ok: false, detail: `contrast unchanged (${pct(stats.spread / (ref.spread || 1))} of normal)` };
  return { ok: true, detail: 'not measured' };
}
