// Reference boxes: the document-coordinate boxes of the first three rendered headings, taken when the base
// screenshot is shot and again when the Images/Page-map collector runs. When the document only grew in between
// (lazy content below the fold) and these boxes did not move, the markers still line up with the shot.
// Page code is serialised, so it cannot import this: the shot code evaluates REFBOXES_SRC and a11y-map's collector
// declares `pageDeps: { refBoxes: REFBOXES_SRC }`.

function refBoxes() {
  const out = [];
  for (const el of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push([Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)]);
    if (out.length >= 3) break;
  }
  return out;
}

export const REFBOXES_SRC = refBoxes.toString();
