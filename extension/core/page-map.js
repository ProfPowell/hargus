// The Page map: WAVE-style markers over the base screenshot. buildMarks() turns the accessibility results
// (axe, HARgus heuristics, contrast, images, structure, the keyboard walk) into one list of marks with
// document-coordinate boxes; placeMarks() fits them to a screenshot as percentages, with the clip, mismatch
// and cap rules. Pure; the a11y-map plugin resolves the boxes in the page and report.js draws the map.

/** Categories in legend order, with WAVE's colours (theme tokens --pm-<id>) and a default glyph. */
export const CATEGORIES = [
  { id: 'error', label: 'Errors', one: 'Error', glyph: '!' },
  { id: 'contrast', label: 'Contrast', one: 'Contrast', glyph: '◐' },
  { id: 'alert', label: 'Alerts', one: 'Alert', glyph: '?' },
  { id: 'feature', label: 'Features', one: 'Feature', glyph: '✓' },
  { id: 'structure', label: 'Structure', one: 'Structure', glyph: '≡' },
  { id: 'aria', label: 'ARIA', one: 'ARIA', glyph: 'A' },
  { id: 'keyboard', label: 'Keyboard order', one: 'Keyboard', glyph: '#' },
];
export const CATEGORY = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

/** Which marks survive the cap, first to last. */
export const PRIORITY = ['error', 'contrast', 'alert', 'aria', 'keyboard', 'feature', 'structure'];
export const MAX_MARKS = 400;
/** Relative difference in document size above which the screenshot may not match the boxes. */
export const MISMATCH = 0.02;
/** At or above this, only keyboard and structure marks are drawn. */
export const MISMATCH_SEVERE = 0.1;
/** Selectors resolved per reading, at most. */
export const MAX_SELECTORS = 2000;

const CONTRAST_RULES = new Set(['color-contrast', 'color-contrast-enhanced']);
const LANDMARK_GLYPH = { banner: 'HDR', navigation: 'NAV', main: 'MAIN', complementary: 'ASIDE', contentinfo: 'FTR', region: 'REG', form: 'FORM', search: 'SRCH' };
const IMAGE_RULE = {
  missing: 'no-name', 'empty-linked': 'linked-empty-alt', 'empty-decorative': 'alt-decorative', suspicious: 'suspicious-alt',
  redundant: 'redundant-alt', long: 'long-alt', filename: 'filename-alt', repeated: 'repeated-alt', ok: 'alt-ok',
};
const IMAGE_LABEL = {
  missing: 'Image with no alt text', 'empty-linked': 'Linked image with empty alt', 'empty-decorative': 'Decorative image (empty alt)',
  suspicious: 'Suspicious alt text', redundant: 'Alt text repeats nearby text', long: 'Alt text over 100 characters',
  filename: 'Alt text looks like a file name', repeated: 'Same alt text on different images', ok: 'Image with alt text',
};

const arr = (v) => (Array.isArray(v) ? v : []);
const usable = (b) => b && [b.x, b.y, b.w, b.h].every((n) => Number.isFinite(Number(n))) && Number(b.w) >= 0 && Number(b.h) >= 0;
const boxKey = (b) => `${b.x},${b.y},${b.w},${b.h}`;
const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
const ok = (r) => r?.status === 'ok';

/**
 * Every selector the a11y-map collector should resolve to a box: axe targets (violations and needs-review),
 * the evidence of HARgus heuristic findings (a11y-basics, a11y-structure), failing contrast samples,
 * headings and landmarks. Shadow-piercing (">>>") targets cannot be resolved with querySelector and are left out.
 */
export function markSelectors(results = {}) {
  const out = new Set();
  const add = (s) => { if (typeof s === 'string' && s && !s.includes('>>>') && out.size < MAX_SELECTORS) out.add(s); };
  const axe = results.axe;
  if (ok(axe)) for (const v of [...arr(axe.data?.violations), ...arr(axe.data?.incomplete)]) arr(v.targets).forEach(add);
  for (const id of ['a11y-basics', 'a11y-structure']) {
    if (ok(results[id])) for (const f of arr(results[id].findings)) lines(f.evidence).forEach(add);
  }
  if (ok(results.contrast)) for (const p of arr(results.contrast.data?.pairs)) if (p.pass === false) arr(p.samples).forEach(add);
  const st = results['a11y-structure'];
  if (ok(st)) {
    arr(st.data?.headings).forEach((x) => add(x.selector));
    arr(st.data?.landmarkList).forEach((x) => add(x.sel));
  }
  return [...out];
}

/**
 * One list of marks: { category, label, ruleId, sel, box, alt?, n?, glyph?, detail?, ref?, source }.
 * `boxes` maps a selector to its document box (from the collector); items without a box are skipped.
 * - axe violations → error (contrast rules → contrast, aria-* → aria); axe needs-review → alert;
 * - HARgus heuristics → error when high severity, aria for aria-* ids, else alert;
 * - failing contrast pairs → contrast; images: ok / decorative → feature (with alt), missing and empty-in-link → error,
 *   other verdicts → alert (with alt); headings and landmarks → structure; keyboard stops → keyboard with n.
 * A heuristic or contrast-plugin mark on a box that axe or the image list already marked in the same category is not
 * repeated (an image's verdict replaces, say, a11y-structure's "unhelpful alt" on the same image).
 */
export function buildMarks({ violations, incomplete, heuristics, contrast, images, headings, landmarks, keyboard, boxes } = {}) {
  const at = boxes instanceof Map ? boxes : new Map(arr(boxes));
  const marks = [];
  const seen = new Set();
  const claimed = new Set();
  const push = (m, { claim = false, unlessClaimed = false } = {}) => {
    if (!usable(m.box)) return;
    const k = `${m.category}|${boxKey(m.box)}`;
    if (unlessClaimed && claimed.has(k)) return;
    const full = `${k}|${m.ruleId}`;
    if (seen.has(full)) return;
    seen.add(full);
    if (claim) claimed.add(k);
    marks.push(m);
  };
  const axeMarks = (list, review) => {
    for (const v of arr(list)) {
      if (!v?.id) continue;
      const category = review ? 'alert' : CONTRAST_RULES.has(v.id) ? 'contrast' : v.id.startsWith('aria-') ? 'aria' : 'error';
      const why = new Map(arr(v.samples).map((s) => [s.target, s.summary]));
      for (const sel of arr(v.targets)) {
        push({ category, label: `${review ? 'Needs review: ' : ''}${v.help || v.id}`, ruleId: v.id, source: review ? 'axe-review' : 'axe', sel, box: at.get(sel),
          ...(why.get(sel) ? { detail: why.get(sel) } : {}), ...(v.helpUrl ? { ref: v.helpUrl } : {}) }, { claim: true });
      }
    }
  };
  axeMarks(violations, false);
  axeMarks(incomplete, true);
  for (const i of arr(images)) {
    const v = i.verdict;
    if (!v) continue;
    const category = v === 'ok' || v === 'empty-decorative' ? 'feature' : v === 'missing' || v === 'empty-linked' ? 'error' : 'alert';
    const alt = i.alt == null ? null : String(i.alt);
    if (category === 'error') {
      // axe may already mark this image as an error; then that mark just learns the image's alt state.
      const twin = marks.find((m) => m.category === 'error' && usable(i.box) && boxKey(m.box) === boxKey(i.box));
      if (twin) { twin.alt = alt; continue; }
    }
    push({ category, label: IMAGE_LABEL[v] || v, ruleId: IMAGE_RULE[v] || v, source: 'a11y-map', sel: i.sel, box: i.box, alt, image: true, ...(i.name ? { name: String(i.name) } : {}), ...(i.note ? { detail: i.note } : {}) }, { claim: true });
  }
  for (const f of arr(heuristics)) {
    const category = String(f.id || '').startsWith('aria') ? 'aria' : f.severity === 'high' ? 'error' : 'alert';
    for (const sel of arr(f.sels)) push({ category, label: f.title || f.id, ruleId: f.id, source: f.source || 'hargus', sel, box: at.get(sel), ...(f.detail ? { detail: f.detail } : {}) }, { unlessClaimed: true });
  }
  for (const p of arr(contrast)) {
    if (p.pass !== false) continue;
    const ratio = Number(p.ratio);
    const label = `Text contrast ${Number.isFinite(ratio) ? (Math.floor(ratio * 10) / 10).toFixed(1) : '?'}:1 (${p.fg} on ${p.bg})`;
    for (const sel of arr(p.samples)) push({ category: 'contrast', label, ruleId: 'contrast', source: 'contrast', sel, box: at.get(sel), detail: `Needs ${p.large ? '3' : '4.5'}:1${p.large ? ' (large text)' : ''}.` }, { unlessClaimed: true });
  }
  for (const x of arr(headings)) {
    const level = Number(x.level) || 2;
    push({ category: 'structure', label: `Heading ${level}${x.text ? `: “${String(x.text).slice(0, 80)}”` : ' (empty)'}`, ruleId: 'heading', source: 'a11y-structure', sel: x.selector, box: at.get(x.selector), glyph: `H${level}` });
  }
  for (const l of arr(landmarks)) {
    push({ category: 'structure', label: `Landmark: ${l.role}${l.label ? ` “${String(l.label).slice(0, 80)}”` : ''}`, ruleId: 'landmark', source: 'a11y-structure', sel: l.sel, box: at.get(l.sel), glyph: LANDMARK_GLYPH[l.role] || 'L' });
  }
  arr(keyboard?.stops).forEach((s, i) => {
    if (!s || s.none) return;
    const n = i + 1;
    push({ category: 'keyboard', label: `Tab stop ${n}: ${s.role || s.tag || 'element'}${s.name ? ` “${String(s.name).slice(0, 80)}”` : ' (no name)'}`, ruleId: 'kb-stop', source: 'keyboard', sel: s.sel, box: s.box, n, glyph: String(n) });
  });
  return marks;
}

const r3 = (n) => Math.round(n * 1000) / 1000;
const rank = (c) => { const i = PRIORITY.indexOf(c); return i < 0 ? PRIORITY.length : i; };

/**
 * Fit marks to a screenshot. `shot` is the clip box (cssWidth × cssHeight) plus, for a full-page shot, the document
 * size it recorded (docWidth × docHeight); `docAtCollect` is the document size when the boxes were taken.
 * - beyond: marks whose box lies outside the clip box (a box straddling the edge is clamped to it);
 * - mismatch: the document sizes differ by more than 2% in either direction. Under 10% every mark is kept (the map
 *   says so); at 10% or more only keyboard and structure marks are kept and the rest counted in `withheld`;
 * - dropped: over `max`, marks are kept by PRIORITY and the rest counted.
 * Placed marks carry left/top/width/height in percent of the clip box and a `slot` (0, 1, …) among marks on the same box.
 */
export function placeMarks(marks, shot = {}, docAtCollect = {}, max = MAX_MARKS) {
  const W = Number(shot.cssWidth);
  const H = Number(shot.cssHeight);
  const out = { placed: [], beyond: 0, dropped: 0, withheld: 0, mismatch: false };
  if (!(W > 0 && H > 0)) return out;
  const rel = (a, b) => (Number(a) > 0 && Number(b) > 0 ? Math.abs(Number(a) - Number(b)) / Number(b) : 0);
  const diff = Math.max(rel(docAtCollect?.h, shot.docHeight), rel(docAtCollect?.w, shot.docWidth));
  out.mismatch = diff > MISMATCH;
  const severe = diff >= MISMATCH_SEVERE;
  const inside = [];
  for (const m of arr(marks)) {
    if (!m || !usable(m.box)) continue;
    const [x, y, w, h] = [m.box.x, m.box.y, m.box.w, m.box.h].map(Number);
    if (x >= W || y >= H || x + w < 0 || y + h < 0 || (w > 0 && x + w <= 0) || (h > 0 && y + h <= 0)) { out.beyond++; continue; }
    if (severe && m.category !== 'keyboard' && m.category !== 'structure') { out.withheld++; continue; }
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(W, x + w);
    const y1 = Math.min(H, y + h);
    inside.push({ ...m, left: r3((x0 / W) * 100), top: r3((y0 / H) * 100), width: r3((Math.max(0, x1 - x0) / W) * 100), height: r3((Math.max(0, y1 - y0) / H) * 100) });
  }
  const limit = Math.max(0, Number.isFinite(Number(max)) ? Number(max) : MAX_MARKS);
  const order = inside.map((m, i) => [m, i]).sort((a, b) => rank(a[0].category) - rank(b[0].category) || a[1] - b[1]);
  const kept = order.slice(0, limit).map(([m]) => m);
  out.dropped = inside.length - kept.length;
  // Reading order for the list: by category, then down the page; keyboard stops by their number.
  kept.sort((a, b) => rank(a.category) - rank(b.category) || (a.category === 'keyboard' ? (a.n || 0) - (b.n || 0) : a.top - b.top || a.left - b.left));
  const slots = new Map();
  for (const m of kept) {
    if (m.category === 'keyboard') { m.slot = 0; continue; } // drawn at the centre, not the corner
    const k = boxKey(m.box);
    m.slot = slots.get(k) || 0;
    slots.set(k, m.slot + 1);
  }
  // How many corner icons share each box, so an alt label beside them can clear them all.
  for (const m of kept) m.stack = m.category === 'keyboard' ? 1 : slots.get(boxKey(m.box)) || 1;
  out.placed = kept;
  return out;
}

/** Centres of the placed keyboard marks in stop order, in percent: the points of the path between stops. */
export function keyboardPath(placed) {
  return arr(placed).filter((m) => m.category === 'keyboard').sort((a, b) => (a.n || 0) - (b.n || 0))
    .map((m) => [r3(m.left + m.width / 2), r3(m.top + m.height / 2)]);
}

/** Up to 60 characters, with an ellipsis when cut. */
export const clip60 = (s) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > 60 ? `${t.slice(0, 59)}…` : t; };

/** The text drawn on an image: its alt in quotes, alt="" for decorative, or "no alt". Null when the mark is not an image. */
export function altLabel(m) {
  if (!m?.image && m?.alt === undefined) return null;
  if (m.alt == null) return m.name ? `name “${clip60(m.name)}”` : 'no alt';
  if (m.alt === '') return 'alt=""';
  return `“${clip60(m.alt)}”`;
}

/**
 * The details shown for a selected marker: category, rule, what was found, the fix and a WCAG reference.
 * `referenceFor(mark)` is the seam for the fix-it reference text ({ fix, wcag, url }); without it, fix and wcag are empty.
 */
export function markDetails(m, { referenceFor } = {}) {
  let ref = null;
  try { ref = typeof referenceFor === 'function' ? referenceFor(m) : null; } catch { ref = null; }
  return {
    category: CATEGORY[m.category]?.one || m.category,
    rule: m.label || m.ruleId || '',
    ruleId: m.ruleId || '',
    sel: m.sel || '',
    alt: altLabel(m),
    found: m.detail || '',
    fix: ref?.fix || '',
    wcag: ref?.wcag || '',
    url: ref?.url || m.ref || '',
  };
}
