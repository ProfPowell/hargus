// Contrast: every visible text element's colour against its real (composited) background.
// WCAG 2 AA is scored; APCA-W3 Lc is advisory. collect() runs in the page (self-contained).

import { parseRgb, wcagRatio, apcaLc } from '../core/color.js';

const HEX = /^#[0-9a-f]{6}$/i;

function collect() {
  const t0 = performance.now();
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => {
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = 'rgba(0, 0, 0, 0)';
    g.fillStyle = c;
    g.fillRect(0, 0, 1, 1);
    const [r, gg, b, a] = g.getImageData(0, 0, 1, 1).data;
    return { r, g: gg, b, a: a / 255 };
  };
  const over = (t, b) => ({ r: t.r * t.a + b.r * (1 - t.a), g: t.g * t.a + b.g * (1 - t.a), b: t.b * t.a + b.b * (1 - t.a), a: 1 });
  const hex = (c) => `#${[c.r, c.g, c.b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
  const path = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      let p = n.localName;
      if (n.id) { parts.unshift(`${p}#${n.id}`); break; }
      if (n.classList.length) p += `.${[...n.classList].slice(0, 2).join('.')}`;
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  const background = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = rgba(cs.backgroundColor);
      if (c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  };
  const overMedia = (el) => {
    const r = el.getBoundingClientRect();
    const positioned = (x) => /absolute|fixed/.test(getComputedStyle(x).position);
    for (let p = el.parentElement, d = 0; p && d < 3; p = p.parentElement, d++) {
      for (const m of p.querySelectorAll(':scope > img, :scope > video, :scope > canvas, :scope > svg, :scope > picture')) {
        if (m === el || el.contains(m) || m.contains(el)) continue;
        if (!positioned(m) && !positioned(el)) continue;
        const q = m.getBoundingClientRect();
        if (q.left < r.right && q.right > r.left && q.top < r.bottom && q.bottom > r.top) return true;
      }
    }
    return false;
  };
  const elements = [];
  let truncated = false;
  const root = document.body || document.documentElement;
  for (const el of root.querySelectorAll('*')) {
    if (elements.length >= 4000 || performance.now() - t0 > 2000) { truncated = true; break; }
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
    if (![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) continue;
    if (!el.getClientRects().length) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== 'visible') continue;
    if (el.closest('[aria-hidden="true"], [hidden]')) continue;
    if (el.matches(':disabled, [aria-disabled="true"]') || el.closest('label')?.control?.disabled) continue;
    const fg = rgba(cs.color);
    let op = 1;
    for (let n = el; n; n = n.parentElement) {
      const o = parseFloat(getComputedStyle(n).opacity);
      op *= Number.isFinite(o) ? o : 1;
    }
    const alpha = fg.a * op;
    if (alpha <= 0) continue;
    const size = parseFloat(cs.fontSize) || 16;
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const bg = background(el);
    if (!bg || overMedia(el)) { elements.push({ unknown: true, large, selector: path(el) }); continue; }
    elements.push({ fg: hex(over({ ...fg, a: alpha }, bg)), bg: hex(bg), large, selector: path(el) });
  }
  return { elements, truncated };
}

export function analyzeContrast(c) {
  const els = c?.elements || [];
  const unknown = els.filter((e) => e.unknown).length;
  const map = new Map();
  for (const e of els) {
    if (e.unknown || !HEX.test(e.fg) || !HEX.test(e.bg)) continue;
    const fg = e.fg.toLowerCase();
    const bg = e.bg.toLowerCase();
    const k = `${fg}|${bg}|${e.large ? 1 : 0}`;
    let p = map.get(k);
    if (!p) {
      const f = parseRgb(fg);
      const b = parseRgb(bg);
      p = { fg, bg, large: !!e.large, ratio: wcagRatio(f, b), lc: apcaLc(f, b), count: 0, samples: [] };
      map.set(k, p);
    }
    p.count++;
    if (p.samples.length < 3) p.samples.push(e.selector);
  }
  const pairs = [...map.values()].map((p) => ({ ...p, pass: p.ratio >= (p.large ? 3 : 4.5), apcaPass: Math.abs(p.lc) >= (p.large ? 60 : 75) }));
  const failing = pairs.filter((p) => !p.pass).sort((a, b) => a.ratio - b.ratio);
  const apcaOnly = pairs.filter((p) => p.pass && !p.apcaPass).sort((a, b) => Math.abs(a.lc) - Math.abs(b.lc));
  const checked = pairs.reduce((n, p) => n + p.count, 0);
  const failingEls = failing.reduce((n, p) => n + p.count, 0);
  const findings = failing.slice(0, 10).map((p) => ({
    severity: 'medium', category: 'accessibility',
    title: `Text contrast ${(Math.floor(p.ratio * 10) / 10).toFixed(1)}:1 (${p.fg} on ${p.bg}) — ${p.count} elements`, // floor: a fail never reads 4.5
    detail: `Needs ${p.large ? '3' : '4.5'}:1${p.large ? ' (large text)' : ''}. APCA Lc ${Math.round(p.lc)}.`,
    evidence: p.samples.join('\n'),
  }));
  if (failing.length > 10) findings.push({ severity: 'medium', category: 'accessibility', title: `…and ${failing.length - 10} more failing colour pairs` });
  if (unknown) findings.push({ severity: 'info', category: 'accessibility', title: `${unknown} text elements over images could not be checked` });
  if (apcaOnly.length) findings.push({ severity: 'info', category: 'accessibility', title: `${apcaOnly.length} colour pairs below APCA thresholds (advisory)` });
  const share = checked ? failingEls / checked : 0;
  return {
    data: { pairs: [...failing, ...apcaOnly].slice(0, 20), totals: { checked, failing: failingEls, unknown, truncated: !!c?.truncated } },
    findings,
    summary: [{ label: 'Contrast', value: `${failingEls} of ${checked} text elements fail (AA)`, rating: failingEls === 0 ? 'good' : share < 0.1 ? 'needs-improvement' : 'poor', headline: true }],
  };
}

function run(reading, ctx) {
  if (!ctx.collected) ctx.skip('no page data');
  return analyzeContrast(ctx.collected);
}

const swatch = (h, p) => (HEX.test(p.fg) && HEX.test(p.bg)
  ? h.html`<span class="contrast-swatch" style="color:${p.fg};background:${p.bg}">Aa</span>` : '');

function glance(r, h) {
  const t = r.data.totals;
  const rows = r.data.pairs.slice(0, 8);
  return h.html`<section class="card"><h4>Text contrast · ${t.failing} of ${t.checked} fail</h4>
    ${rows.length ? h.html`<ul class="contrast-pairs">${rows.map((p) => h.html`<li>${swatch(h, p)}<span>${p.ratio.toFixed(2)}:1 · Lc ${Math.round(p.lc)}</span><span class="muted">${p.count} ×</span>${h.icon(p.pass ? 'ok' : 'fail', { size: 14, title: p.pass ? 'passes AA' : 'fails AA' })}</li>`)}</ul>`
      : h.html`<p class="muted">Every checked text element passes AA.</p>`}
    ${t.unknown ? h.html`<p class="note">${t.unknown} over images not checked${t.truncated ? ' · page partly checked (time limit)' : ''}</p>` : ''}</section>`;
}

function render(r, h) {
  return h.table(r.data.pairs.map((p) => ({
    swatch: swatch(h, p), fg: p.fg, bg: p.bg, ratio: `${p.ratio.toFixed(2)}:1`, lc: String(Math.round(p.lc)),
    size: p.large ? 'large' : 'normal', count: String(p.count), samples: h.list(p.samples.map((s) => h.html`<code>${s}</code>`)),
  })), [{ key: 'swatch', label: 'Swatch' }, { key: 'fg', label: 'Text' }, { key: 'bg', label: 'Background' }, { key: 'ratio', label: 'WCAG' },
    { key: 'lc', label: 'APCA Lc' }, { key: 'size', label: 'Size' }, { key: 'count', label: 'Elements' }, { key: 'samples', label: 'Samples' }]);
}

export default {
  id: 'contrast',
  name: 'Contrast',
  version: '0.1.0',
  phase: 'page',
  group: 'quality',
  area: 'accessibility',
  description: 'WCAG 2 contrast for every visible text element against its real background, with APCA as advice.',
  tags: ['accessibility'],
  timeoutMs: 15_000,
  collect,
  run,
  glance,
  render,
};
