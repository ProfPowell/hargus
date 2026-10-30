// Representative inputs for the Link check plugin, shared by test/links.test.mjs and the findings baseline
// (links-findings-baseline.json, taken from the plugin before places were added to its non-broken findings).
// Link check is an enrich plugin, so score-check cannot replay it; this is what proves every finding field
// but `places` is unchanged.

// fetch stub: routes[url] = { status, finalUrl?, headStatus?, throws?, headers?, body? }
export function stubFetch(routes) {
  return async (url, init = {}) => {
    const r = routes[url];
    if (!r || r.throws) throw new TypeError('network');
    const status = init.method === 'HEAD' && r.headStatus ? r.headStatus : r.status;
    const res = new Response(init.method === 'HEAD' ? null : (r.body ?? ''), { status, headers: r.headers });
    Object.defineProperty(res, 'url', { value: r.finalUrl || url });
    Object.defineProperty(res, 'redirected', { value: !!r.finalUrl && r.finalUrl !== url });
    return res;
  };
}

export function caseCtx({ routes = {}, internal = [], external = [], totals, missing, og, a11y, options = {} } = {}) {
  return {
    results: {
      content: { status: 'ok', data: { linkTargets: { internal, external, ...(totals ? { totals } : {}) }, ...(missing ? { links: { missing, missingCount: missing.length } } : {}) } },
      meta: { status: 'ok', data: { og: og ? { 'og:image': og } : {} } },
      ...(a11y ? { 'a11y-basics': { status: a11y } } : {}),
    },
    target: { url: 'https://s.test/' },
    options: { external: false, max: 150, ...options },
    fetch: stubFetch(routes),
    signal: new AbortController().signal,
    skip: (m) => { const e = new Error(m); e.name = 'SkipError'; throw e; },
  };
}

const S = 'https://s.test/';
export const LONG = `${S}${'deep/'.repeat(150)}page?v=${'x'.repeat(200)}`;
export const ODD = `${S}odd?q=<b>&r="1"`;
const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));

export const CASES = {
  base: {
    internal: [`${S}ok`, `${S}gone`, `${S}old`, `${S}nohead`, `${S}down`, `${S}insecure`, `${S}logout`, `${S}private`, `${S}locked`],
    routes: {
      [`${S}ok`]: { status: 200 },
      [`${S}gone`]: { status: 404 },
      [`${S}old`]: { status: 200, finalUrl: `${S}new` },
      [`${S}nohead`]: { status: 200, headStatus: 405 },
      [`${S}down`]: { throws: true },
      [`${S}insecure`]: { status: 200, finalUrl: 'http://s.test/insecure' },
      [`${S}private`]: { status: 403 },
      [`${S}locked`]: { status: 401 },
    },
    og: `${S}og.png`,
    missing: [{ href: `${S}#nope`, text: 'Jump', region: 'main', selector: 'main > a' }],
  },
  redirects: {
    internal: [...many(12, (i) => `${S}i${i}`), ...many(12, (i) => `${S}w${i}`), ...many(3, (i) => `${S}r${i}`)],
    routes: Object.fromEntries([
      ...many(12, (i) => [`${S}i${i}`, { status: 200, finalUrl: `http://s.test/i${i}` }]),
      ...many(12, (i) => [`${S}w${i}`, { status: 200, finalUrl: `http://waf.example/block?id=${i}` }]),
      ...many(3, (i) => [`${S}r${i}`, { status: 200, finalUrl: `${S}moved/${i}` }]),
    ]),
    options: { max: 0 },
    a11y: 'ok',
  },
  'rate limited': {
    internal: many(10, (i) => `https://r.test/${i}`),
    external: ['https://e.test/a', 'https://e.test/b', 'https://e.test/gone'],
    routes: Object.fromEntries([...many(10, (i) => [`https://r.test/${i}`, { status: 429 }]),
      ['https://e.test/a', { status: 200 }], ['https://e.test/b', { status: 200 }], ['https://e.test/gone', { status: 410 }]]),
    options: { external: true, max: 0 },
  },
  'over the limit': {
    internal: many(6, (i) => `${S}m${i}`),
    routes: Object.fromEntries(many(6, (i) => [`${S}m${i}`, { status: 200 }])),
    options: { max: 2 },
    og: `${S}og-missing.png`,
  },
  'content cap': {
    internal: [`${S}a`, `${S}b`],
    totals: { internal: 5007, external: 3 },
    routes: { [`${S}a`]: { status: 200 }, [`${S}b`]: { status: 200 } },
    options: { max: 0 },
    og: `${S}og-big.png`,
  },
  odd: {
    internal: [LONG, ODD, `${S}fail1`, `${S}fail2`, ...many(12, (i) => `${S}x${i}`)],
    routes: {
      [LONG]: { status: 200, finalUrl: `${S}short` },
      [ODD]: { status: 403 },
      ...Object.fromEntries(many(12, (i) => [`${S}x${i}`, { throws: true }])),
    },
    options: { max: 0 },
  },
};

// The og-big route's content-length passes X's 5 MB limit; it needs a header, so it is added here.
CASES['content cap'].routes[`${S}og-big.png`] = { status: 200, body: 'xx', headers: { 'content-length': String(6 * 1024 * 1024) } };
CASES.base.routes[`${S}og.png`] = { status: 500 };

export const runCase = (plugin, c) => plugin.run({}, caseCtx(c));
