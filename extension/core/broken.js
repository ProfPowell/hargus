// Broken links and assets: which recorded requests count as assets. Pure — no DOM, no chrome.*.

import { resourceType } from './har-util.js';

export const ASSET_KINDS = ['image', 'script', 'stylesheet', 'font', 'media', 'frame'];

/**
 * The asset kind of a recorded request, or null when it isn't one that can be broken.
 * `main` is the main document entry (har-util.mainEntry). A redirect hop (3xx) is never a frame:
 * the main document's chain is all 3xx up to `main`, and a hop can't be broken anyway.
 */
export function assetKind(entry, main) {
  const type = resourceType(entry);
  if (type === 'document' || entry._resourceType === 'iframe') {
    const s = entry.response?.status;
    if (entry === main || (s >= 300 && s < 400)) return null;
    return 'frame';
  }
  return ASSET_KINDS.includes(type) ? type : null;
}
