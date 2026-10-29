// The issue list behind the Issues pane: every scored finding with a stable, linkable key.
import { topFindings } from './score.js';

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** `plugin-id`, or `plugin-<index>` for a finding with no id. Lower-case [a-z0-9-]. */
export function issueKey({ plugin, id, index }) {
  const tail = id != null && slug(id) ? slug(id) : slug(index ?? 0) || '0';
  return [slug(plugin), tail].filter(Boolean).join('-');
}

/** Every scored finding, info included, in report order, each with a unique `key`. */
export function allIssues(scores) {
  const seen = new Set();
  return topFindings(scores, Infinity, null, { includeInfo: true }).map((f) => {
    const base = issueKey(f);
    let key = base;
    for (let n = 2; seen.has(key); n++) key = `${base}-${n}`;
    seen.add(key);
    return { ...f, key };
  });
}
