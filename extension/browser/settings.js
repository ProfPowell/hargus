// Extension settings in chrome.storage.local, merged over defaults.

export const DEFAULTS = {
  capture: {
    mode: 'reload',        // reload | snapshot | record
    device: 'desktop',     // desktop | mobile | tablet
    throttle: 'none',      // none | slow-4g | 3g
    bypassCache: true,
    fullPage: true,
    views: {
      desktop: true, tablet: true, mobile: true, nojs: true, nocss: true, noimages: true, rtl: true, 'translated-de': true, 'translated-ar': true, 'translated-ja': true, pseudo: true,
      vision: true, protanopia: true, deuteranopia: true, tritanopia: true, achromatopsia: true, blurred: true, lowcontrast: true,
      dark: true, forced: true, morecontrast: true, print: true, spacing: true, reflow: true, text200: true, breakpoints: true,
    },
    scroll: true,          // scroll through the page to trigger lazy loading before screenshots
    focusCheck: true,      // force :focus/:focus-visible on one sample per focusable kind and diff the styles
    keyboardWalk: true,    // press Tab through the page (up to 250 stops or 60 s) and record every focus stop
    bodies: 'text',        // none | document | text | all
    maxBodyKB: 1024,
    idleMs: 1500,
    maxWaitSec: 30,
  },
  lookups: { resolver: 'cloudflare' },   // cloudflare | google | https://your-doh/dns-query
  phases: { page: true, analyze: true, enrich: true },
  plugins: {},                            // { [id]: { enabled, options } }
  keys: { pagespeed: '', ipinfo: '', abuseipdb: '', virustotal: '', greynoise: '' },
  remotes: [],                            // [{ id, name, url, send, token, timeoutSec, enabled }]
  ui: { openWhenDone: true },
  scoring: {
    profile: 'general',      // general | content | commerce | webapp | public | custom
    custom: {
      weights: { performance: 18, accessibility: 18, security: 18, content: 12, build: 10, infrastructure: 9, international: 8, sustainability: 7 },
      critical: [],
    },
  },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? structuredClone(base) : over;
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return merge(DEFAULTS, settings || {});
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
  return settings;
}

export async function updateSettings(mutate) {
  const s = await getSettings();
  mutate(s);
  return saveSettings(s);
}
