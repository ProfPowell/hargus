// Colour maths for contrast checks: parsing, compositing, WCAG 2 contrast ratio and APCA-W3 Lc.
// Pure (no DOM): shared by the contrast plugin and its tests.

export function parseRgb(str) {
  const s = String(str || '').trim();
  const hex = s.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
  if (!m) return null;
  const a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
}

/** Source-over: top (with alpha) over an opaque bottom. */
export function composite(top, bottom) {
  const a = top.a ?? 1;
  const mix = (t, b) => Math.round(t * a + b * (1 - a));
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

export const toHex = ({ r, g, b }) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

/** WCAG 2.x relative luminance. */
export function relLum({ r, g, b }) {
  const f = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function wcagRatio(a, b) {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** APCA-W3 0.0.98G-4g lightness contrast, signed (positive: dark text on light background), ×100. */
export function apcaLc(text, bg) {
  const y = ({ r, g, b }) => {
    let Y = 0.2126729 * (r / 255) ** 2.4 + 0.7151522 * (g / 255) ** 2.4 + 0.0721750 * (b / 255) ** 2.4;
    if (Y < 0.022) Y += (0.022 - Y) ** 1.414;
    return Y;
  };
  const yt = y(text);
  const yb = y(bg);
  if (Math.abs(yb - yt) < 0.0005) return 0;
  let lc;
  if (yb > yt) {
    const s = (yb ** 0.56 - yt ** 0.57) * 1.14;
    lc = s < 0.1 ? 0 : s - 0.027;
  } else {
    const s = (yb ** 0.65 - yt ** 0.62) * 1.14;
    lc = s > -0.1 ? 0 : s + 0.027;
  }
  return lc * 100;
}
