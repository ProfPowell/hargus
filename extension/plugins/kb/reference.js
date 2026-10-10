// Large reference datasets (fingerprints, web-features) are downloaded at runtime and cached for a
// week: Cache Storage in the extension, in-memory elsewhere (CLI).

export const TTL = 7 * 86_400_000;
const CACHE_NAME = 'harplus-reference-data';
const memory = new Map();

/** Fetch JSON with a week-long cache. */
export async function cachedJSON(fetchFn, url) {
  const mem = memory.get(url);
  if (mem && Date.now() - mem.at < TTL) return mem.value;
  const store = globalThis.caches ? await caches.open(CACHE_NAME).catch(() => null) : null;
  if (store) {
    const hit = await store.match(url);
    if (hit && Date.now() - Number(hit.headers.get('x-harplus-fetched') || 0) < TTL) {
      const value = await hit.json();
      memory.set(url, { at: Date.now(), value });
      return value;
    }
  }
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const text = await r.text();
  if (store) {
    await store.put(url, new Response(text, { headers: { 'content-type': 'application/json', 'x-harplus-fetched': String(Date.now()) } }))
      .catch(() => {});
  }
  const value = JSON.parse(text);
  memory.set(url, { at: Date.now(), value });
  return value;
}
