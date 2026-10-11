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

/** Did a vision view's shot really show its filter, relative to a reference shot of the same frozen page? */
export function visionCheck(view, stats, ref) {
  if (!stats || !ref) return { ok: true, detail: 'not measured' };
  const colour = ['achromatopsia', 'protanopia', 'deuteranopia', 'tritanopia'].includes(view);
  if (colour && ref.sat < 0.02) return { ok: true, detail: 'page has no colour to change' };
  if (view === 'achromatopsia') return stats.sat <= 0.03 ? { ok: true, detail: `saturation ${stats.sat.toFixed(3)}` } : { ok: false, detail: `still in colour (saturation ${stats.sat.toFixed(3)})` };
  if (colour) {
    const share = changedShare(stats, ref);
    return share >= 0.02 ? { ok: true, detail: `${pct(share)} of pixels shifted` } : { ok: false, detail: `colours unchanged (${pct(share)} of pixels shifted)` };
  }
  if (view === 'blurred') return stats.edge <= 0.6 * ref.edge ? { ok: true, detail: `edges ${pct(stats.edge / (ref.edge || 1))} of normal` } : { ok: false, detail: `not blurred (edges ${pct(stats.edge / (ref.edge || 1))} of normal)` };
  if (view === 'lowcontrast') return stats.spread <= 0.8 * ref.spread ? { ok: true, detail: `contrast ${pct(stats.spread / (ref.spread || 1))} of normal` } : { ok: false, detail: `contrast unchanged (${pct(stats.spread / (ref.spread || 1))} of normal)` };
  return { ok: true, detail: 'not measured' };
}
