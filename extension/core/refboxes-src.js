// Reference boxes: the document-coordinate boxes of up to 8 rendered elements spread down the page (headings first,
// then landmarks, then images), taken when the base screenshot is shot and again when the Images/Page-map collector
// runs. When the document only grew in between (lazy content below the fold) and these boxes did not move, the
// markers still line up with the shot; when some moved, the markers above the first moved one still do.
// Page code is serialised, so it cannot import this: the shot code evaluates REFBOXES_SRC and a11y-map's collector
// declares `pageDeps: { refBoxes: REFBOXES_SRC }`. REFBOXES_SRC carries spreadIndices compiled in.

/** k indices spread evenly over 0…n−1, first and last included; all of them when n ≤ k. */
export function spreadIndices(n, k = 8) {
  if (n <= k) return Array.from({ length: n }, (_, i) => i);
  return Array.from({ length: k }, (_, i) => Math.round((i * (n - 1)) / (k - 1)));
}

function boxes() {
  const LANDMARKS = 'main, nav, header, footer, aside, [role=main], [role=navigation], [role=banner], [role=contentinfo], [role=complementary], [role=search]';
  const seen = new Set();
  const out = [];
  const take = (sel) => {
    for (const el of document.querySelectorAll(sel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push([Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)]);
    }
  };
  take('h1, h2, h3, h4, h5, h6');
  if (out.length < 8) take(LANDMARKS);
  if (out.length < 8) take('img');
  out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return spreadIndices(out.length).map((i) => out[i]);
}

export const REFBOXES_SRC = `function refBoxes() { const spreadIndices = ${spreadIndices}; return (${boxes})(); }`;
