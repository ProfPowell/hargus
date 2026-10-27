// One plugin's result can name findings of other plugins that it replaces ("pluginId:findingId" in
// `supersedes`). Those findings drop out of scores and lists only while the superseding plugin is ok.

export function activeFindings(result, results = {}) {
  const gone = new Set();
  for (const r of Object.values(results || {})) {
    if (r?.status === 'ok' && Array.isArray(r.supersedes)) for (const s of r.supersedes) gone.add(s);
  }
  return (result.findings || []).filter((f) => !f.id || !gone.has(`${result.id}:${f.id}`));
}
