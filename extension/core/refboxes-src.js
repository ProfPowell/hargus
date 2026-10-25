// Reference boxes: document-coordinate boxes of rendered elements (headings first, then landmarks, then images).
// At shot time `refBoxes()` keeps up to 8 spread down the page; when the Images/Page-map collector runs,
// `refBoxes(true)` returns every candidate (up to 2000) so each shot box can be looked for by position. When the document
// only grew in between (lazy content) and every shot box is still found, the markers line up with the shot; when some
// are not, the markers above the first missing one still do.
// Page code is serialised, so it cannot import this: the shot code evaluates REFBOXES_SRC and a11y-map's collector
// declares `pageDeps: { refBoxes: REFBOXES_SRC }`. REFBOXES_SRC carries spreadIndices compiled in.

/** k indices spread evenly over 0…n−1, first and last included; all of them when n ≤ k. */
export function spreadIndices(n, k = 8) {
  if (n <= k) return Array.from({ length: n }, (_, i) => i);
  return Array.from({ length: k }, (_, i) => Math.round((i * (n - 1)) / (k - 1)));
}

/** Every candidate at collect time, at most this many. */
export const REFBOXES_ALL_MAX = 2000;

function boxes(all, cap) {
  const LANDMARKS = 'main, nav, header, footer, aside, [role=main], [role=navigation], [role=banner], [role=contentinfo], [role=complementary], [role=search]';
  const seen = new Set();
  const out = [];
  const take = (sel) => {
    for (const el of document.querySelectorAll(sel)) {
      if (all && out.length >= cap) return;
      if (seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push([Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)]);
    }
  };
  take('h1, h2, h3, h4, h5, h6');
  if (all || out.length < 8) take(LANDMARKS);
  if (all || out.length < 8) take('img');
  out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return all ? out : spreadIndices(out.length).map((i) => out[i]);
}

export const REFBOXES_SRC = `function refBoxes(all) { const spreadIndices = ${spreadIndices}; return (${boxes})(!!all, ${REFBOXES_ALL_MAX}); }`;
