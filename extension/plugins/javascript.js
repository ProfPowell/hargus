// JavaScript & build: how the scripts were made and shipped. Bundler and framework build output,
// modules vs classic scripts, minification, legacy transpilation and polyfills, public source maps,
// risky patterns (eval, document.write, compromised CDNs) and web-platform API references.
// Works offline from recorded response bodies (capture with bodies = text, the default).

import { resourceType, transferSize, decodedSize, hostOf, resolveUrl, header, bodyText, formatBytes } from '../core/har-util.js';

const BUILD = [
  // [label, test(url, body)]
  ['webpack', (u, b) => /__webpack_require__|webpackChunk[\w$]*|webpackJsonp/.test(b)],
  ['Vite', (u, b) => /\/assets\/[\w.-]+-[\w-]{8}\.js$/.test(u) && /import\.meta|__vite|modulepreload/.test(b) || /vite\/modulepreload-polyfill|__vite__/.test(b)],
  ['Rollup', (u, b) => /\/\*\s*rollup|ROLLUP_/.test(b)],
  ['esbuild', (u, b) => /\b__toESM\(|\b__commonJS\(|\b__esm\(/.test(b)],
  ['Parcel', (u, b) => /parcelRequire|\$parcel\$/.test(b)],
  ['Turbopack', (u, b) => /TURBOPACK/.test(b)],
  ['Browserify', (u, b) => /\{\s*\d+\s*:\s*\[\s*function\s*\(require,\s*module,\s*exports\)/.test(b)],
  ['Next.js build', (u) => /\/_next\/static\//.test(u)],
  ['Nuxt build', (u) => /\/_nuxt\//.test(u)],
  ['Astro build', (u) => /\/_astro\//.test(u)],
  ['SvelteKit build', (u) => /\/_app\/immutable\//.test(u)],
  ['Gatsby build', (u) => /\/(webpack-runtime|framework|app)-[a-f0-9]{16,}\.js/.test(u)],
  ['Remix build', (u) => /\/build\/_shared\/|\/build\/root-[A-Z0-9]{8}\.js/.test(u)],
  ['Angular CLI build', (u, b) => /\/(main|polyfills|runtime)[.-][a-z0-9]{16,20}\.js$/.test(u) || /ɵɵdefineComponent|ɵɵelementStart/.test(b)],
  ['Create React App', (u) => /\/static\/js\/(main|\d+)\.[a-f0-9]{8}\.(chunk\.)?js$/.test(u)],
];

const LEGACY = [
  ['regenerator-runtime (ES5 async transpilation)', /regeneratorRuntime|_regeneratorRuntime/],
  ['core-js polyfills', /__core-js_shared__|core-js\/modules|core-js@\d/],
  ['Babel helpers', /_classCallCheck|_createClass\(|_inherits\(|_interopRequireDefault/],
];

// Domains tied to the 2024 polyfill.io supply-chain compromise (same operator).
/** A script's origin and path, without the query: stable across loads that bust caches. */
const scriptSubject = (url) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return String(url).split('?')[0]; } };

const COMPROMISED = [
  [/(^|\.)polyfill\.io$/, 'high', 'polyfill.io was taken over in 2024 and served malware'],
  [/(^|\.)(bootcdn\.net|bootcss\.com|staticfile\.net|staticfile\.org)$/, 'high', 'CDN reported as run by the polyfill.io operator'],
];

// Web-platform APIs referenced in script source → browser-compat-data keys (for the Baseline plugin).
// A reference is not proof of use (feature detection, polyfills), so the Baseline plugin labels these "referenced".
export const API_REFERENCES = [
  [/\bIntersectionObserver\b/, 'api.IntersectionObserver'],
  [/\bResizeObserver\b/, 'api.ResizeObserver'],
  [/\bMutationObserver\b/, 'api.MutationObserver'],
  [/\bPerformanceObserver\b/, 'api.PerformanceObserver'],
  [/customElements\.define\b/, 'api.CustomElementRegistry.define'],
  [/\.attachShadow\(/, 'api.Element.attachShadow'],
  [/\badoptedStyleSheets\b/, 'api.Document.adoptedStyleSheets'],
  [/\.replaceSync\(/, 'api.CSSStyleSheet.replaceSync'],
  [/navigator\.serviceWorker\b/, 'api.ServiceWorker'],
  [/\bstructuredClone\(/, 'api.structuredClone'],
  [/\brequestIdleCallback\(/, 'api.Window.requestIdleCallback'],
  [/\.startViewTransition\(/, 'api.Document.startViewTransition'],
  [/\bBroadcastChannel\b/, 'api.BroadcastChannel'],
  [/\bnew\s+(Shared)?Worker\(/, 'api.Worker'],
  [/\bindexedDB\.open\(/, 'api.IDBFactory.open'],
  [/navigator\.clipboard\b/, 'api.Clipboard'],
  [/navigator\.share\(/, 'api.Navigator.share'],
  [/\bAbortController\b/, 'api.AbortController'],
  [/\bnew\s+WebSocket\(/, 'api.WebSocket'],
  [/navigator\.sendBeacon\(/, 'api.Navigator.sendBeacon'],
  [/\bEventSource\(/, 'api.EventSource'],
  [/\bOffscreenCanvas\b/, 'api.OffscreenCanvas'],
  [/\bWebAssembly\.(instantiate|compile)/, 'webassembly.api.instantiate_static'],
  [/crypto\.randomUUID\(/, 'api.Crypto.randomUUID'],
  [/scheduler\.postTask\(/, 'api.Scheduler.postTask'],
  [/scheduler\.yield\(/, 'api.Scheduler.yield'],
  [/\bURLPattern\b/, 'api.URLPattern'],
  [/\bnavigation\.addEventListener\(\s*['"]navigate/, 'api.Navigation'],
  [/\.showPopover\(|\.togglePopover\(/, 'api.HTMLElement.showPopover'],
  [/\.showModal\(/, 'api.HTMLDialogElement.showModal'],
  [/\bIntl\.Segmenter\b/, 'javascript.builtins.Intl.Segmenter'],
  [/\bPromise\.withResolvers\b/, 'javascript.builtins.Promise.withResolvers'],
  [/\bObject\.groupBy\b/, 'javascript.builtins.Object.groupBy'],
  [/\bTemporal\.(Now|PlainDate|Instant|ZonedDateTime)\b/, 'javascript.builtins.Temporal'],
  [/navigator\.storage\.(estimate|persist)/, 'api.StorageManager'],
  [/\.getUserMedia\(/, 'api.MediaDevices.getUserMedia'],
  [/navigator\.geolocation\b/, 'api.Geolocation'],
  [/\bNotification\.requestPermission\b/, 'api.Notification.requestPermission_static'],
  [/\bnew\s+Intl\.(DateTimeFormat|NumberFormat|RelativeTimeFormat|ListFormat|PluralRules)\b/, 'javascript.builtins.Intl'],
  [/\bfetchLater\(/, 'api.Window.fetchLater'],
  [/\.checkVisibility\(/, 'api.Element.checkVisibility'],
  [/\bimport\.meta\b/, 'javascript.operators.import_meta'],
  [/\bawait\s+import\(|\bimport\(\s*['"`]/, 'javascript.operators.import'],
];

function minified(body) {
  if (body.length < 2000) return null;
  const lines = body.split('\n').length;
  return body.length / lines > 300;
}

function run(reading, ctx) {
  const entries = reading.log.entries.filter((e) => resourceType(e) === 'script');
  const site = ctx.target.site;
  const metaScripts = ctx.results.meta?.data?.scripts || [];
  const htmlData = ctx.results.html?.data;
  const scripts = entries.map((e) => {
    const url = e.request.url;
    const body = bodyText(e);
    const map = (body.match(/\/\/[#@]\s*sourceMappingURL=([^\s'"]+)\s*$/m) || [])[1] ||
      header(e.response.headers, 'sourcemap') || header(e.response.headers, 'x-sourcemap');
    const tag = metaScripts.find((s) => s.src === url);
    return {
      url, host: hostOf(url), firstParty: !ctx.util.isThirdParty(hostOf(url), site),
      bytes: transferSize(e), decoded: decodedSize(e), captured: !!body,
      module: tag?.type === 'module', async: !!tag?.async, defer: !!tag?.defer,
      minified: body ? minified(body) : null,
      sourceMap: map ? (map.startsWith('data:') ? 'inline (data: URL)' : resolveUrl(map, url)) : null,
      build: BUILD.filter(([, test]) => test(url, body)).map(([label]) => label),
      legacy: LEGACY.filter(([, re]) => re.test(body)).map(([label]) => label),
      eval: (body.match(/\beval\(|new Function\(/g) || []).length,
      documentWrite: (body.match(/document\.write(ln)?\(/g) || []).length,
      modern: /=>|\bclass\s+\w+|\basync\s+function|\?\.|\?\?|`/.test(body),
      body,
    };
  });
  const captured = scripts.filter((s) => s.captured);
  const builds = [...new Set(scripts.flatMap((s) => s.build))];
  const legacy = [...new Set(scripts.flatMap((s) => s.legacy))];
  const maps = scripts.filter((s) => s.sourceMap);
  const total = scripts.reduce((n, s) => n + s.bytes, 0);
  const third = scripts.filter((s) => !s.firstParty).reduce((n, s) => n + s.bytes, 0);
  const apis = {};
  for (const s of captured) for (const [re, key] of API_REFERENCES) if (re.test(s.body)) (apis[key] ||= []).push(s.url);
  const scriptTypes = htmlData?.scriptTypes || {};
  const importMap = scriptTypes.importmap > 0;

  const findings = [];
  const add = (id, severity, category, title, detail, evidence, places, subject) => findings.push({ id, ...(subject ? { subject } : {}), severity, category, title, detail, evidence, ...(places?.length ? { places: places.slice(0, 200) } : {}) });
  for (const s of scripts) {
    for (const [re, severity, why] of COMPROMISED) {
      if (re.test(s.host)) add('compromised-script-host', severity, 'security', `Script loaded from ${s.host}`, why, s.url, [{ url: s.url }], scriptSubject(s.url));
    }
  }
  // A map with a URL is the place; an inline map has none of its own, so its script is.
  const mapPlace = (s) => (/^https?:/i.test(s.sourceMap) ? { url: s.sourceMap } : { url: s.url, note: s.sourceMap });
  if (maps.length) add('public-source-maps', 'info', 'quality', `${maps.length} scripts publish source maps`, 'The original, unminified source is downloadable — great for learning, and worth knowing for security.', maps.slice(0, 10).map((s) => s.sourceMap).join('\n'), maps.map(mapPlace));
  const bigUnminified = captured.filter((s) => s.firstParty && s.minified === false && s.decoded > 20_000);
  if (bigUnminified.length) add('unminified-scripts', 'low', 'performance', `${bigUnminified.length} large first-party scripts are not minified`, undefined, bigUnminified.map((s) => `${s.url} (${formatBytes(s.decoded)})`).join('\n'), bigUnminified.map((s) => ({ url: s.url, note: formatBytes(s.decoded) })));
  if (legacy.length) add('legacy-transpilation', 'info', 'performance', 'Ships legacy transpilation / polyfills', 'Modern browsers do not need ES5 output; module/nomodule or a modern target saves bytes.', legacy.join(', '));
  const evalScripts = captured.filter((s) => s.eval);
  const evals = evalScripts.reduce((n, s) => n + s.eval, 0);
  if (evals) add('eval-used', 'info', 'security', `eval()/new Function used ${evals} times`, 'Requires unsafe-eval in a Content-Security-Policy.', undefined, evalScripts.map((s) => ({ url: s.url, note: `×${s.eval}` })));
  const writes = captured.filter((s) => s.documentWrite);
  if (writes.length) add('document-write', 'low', 'performance', `document.write in ${writes.length} scripts`, 'Blocks the parser; Chrome may refuse it on slow connections.', writes.map((s) => s.url).join('\n'), writes.map((s) => ({ url: s.url, note: `×${s.documentWrite}` })));
  if (total > 0 && third / total > 0.5) add('third-party-js-share', 'info', 'performance', `${Math.round((third / total) * 100)}% of JavaScript bytes are third-party`);
  if (!captured.length && scripts.length) add('script-bodies-missing', 'info', 'quality', 'Script bodies were not recorded — build analysis is limited to URLs', 'Capture with response bodies = text.');

  const modules = Object.entries(scriptTypes).filter(([k]) => k === 'module').reduce((n, [, v]) => n + v, 0);
  return {
    data: {
      scripts: scripts.map(({ body, ...rest }) => rest),
      builds, legacy, apis, importMap,
      totals: { count: scripts.length, bytes: total, thirdPartyBytes: third, captured: captured.length, sourceMaps: maps.length, modules },
    },
    findings,
    summary: [
      { label: 'Scripts', headline: true, value: `${scripts.length} files · ${formatBytes(total)} (${total ? Math.round((third / total) * 100) : 0}% third-party)` },
      { label: 'Build tooling', value: builds.join(', ') || 'no bundler fingerprint' },
      { label: 'Loading', value: [`${modules} module`, `${(scriptTypes.classic || 0) + (scriptTypes['text/javascript'] || 0)} classic`, importMap && 'import map'].filter(Boolean).join(' · ') },
      { label: 'Minified', value: captured.length ? `${captured.filter((s) => s.minified).length} of ${captured.filter((s) => s.minified !== null).length} sizable scripts` : '' },
      { label: 'Source maps', value: maps.length ? `${maps.length} public` : 'none found' },
      { label: 'Legacy output', value: legacy.join(', ') },
      { label: 'Platform APIs referenced', value: Object.keys(apis).length ? `${Object.keys(apis).length} (${Object.keys(apis).slice(0, 5).map((k) => k.split('.').pop()).join(', ')}…)` : '' },
    ],
  };
}


/**
 * Answer first (minified, source maps, API references), then build tooling and the script table.
 * The glance has the file count, the bytes and the first / third-party split, so they are not repeated.
 */
function render(r, h) {
  const d = r.data;
  const rated = d.scripts.filter((s) => s.minified != null);
  const apis = Object.keys(d.apis || {});
  const rows = d.scripts.map((s) => ({
    script: /^https?:/i.test(s.url) ? h.link(s.url) : h.url(s.url),
    party: s.firstParty ? 'first' : 'third', size: h.bytes(s.bytes),
    loading: [s.module && 'module', s.async && 'async', s.defer && 'defer'].filter(Boolean).join(' '),
    minified: s.minified == null ? '' : s.minified ? 'yes' : 'no',
    build: s.build.join(', '), map: s.sourceMap ? (s.sourceMap.startsWith('http') ? h.link(s.sourceMap, 'map') : s.sourceMap) : '',
  }));
  return h.html`
    ${h.stats([
      rated.length ? h.stat({ label: 'Minified', value: `${rated.filter((s) => s.minified).length} of ${rated.length}`, note: 'sizable scripts' }) : '',
      h.stat({ label: 'Source maps', value: d.totals.sourceMaps, note: 'public' }),
      h.stat({ label: 'APIs referenced', value: apis.length }),
    ])}
    ${h.kv([['Build tooling', d.builds.join(', ') || 'no bundler fingerprint'], ['Legacy output', d.legacy.join(', ')], ['Import map', d.importMap ? 'yes' : '']])}
    ${h.table(rows, ['script', 'party', 'size', 'loading', 'minified', 'build', 'map'])}
    ${apis.length ? h.sub('Web platform APIs referenced in source', h.tags(apis), { foot: 'String matches: feature detection and polyfills count too. Baseline has their availability.' }) : ''}
  `;
}

function glance(r, h) {
  const t = r.data.totals;
  return h.html`<section class="card"><h4>Script bytes · ${t.count} files · ${h.bytes(t.bytes)}</h4>${h.stackBar({ label: '', segments: [
    { label: 'First party', value: t.bytes - t.thirdPartyBytes, display: h.bytes(t.bytes - t.thirdPartyBytes), color: 'var(--c1)' },
    { label: 'Third party', value: t.thirdPartyBytes, display: h.bytes(t.thirdPartyBytes), color: 'var(--c2)' },
  ] })}</section>`;
}

export default {
  id: 'javascript',
  group: 'build',
  name: 'JavaScript & build',
  version: '0.1.0',
  phase: 'analyze',
  after: ['meta'],
  description: 'Bundler/build fingerprints, modules, minification, legacy transpilation, source maps, eval/document.write, compromised CDNs, API references.',
  tags: ['quality', 'composition', 'security'],
  run,
  render,
  glance,
};
