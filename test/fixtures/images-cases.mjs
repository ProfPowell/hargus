// Representative inputs for the images plugin, shared by test/images.test.mjs and the findings baseline
// (images-findings-baseline.json, taken from the plugin before places were added). score-check cannot replay
// images, so this is what proves every finding field but `places` is unchanged.

import * as util from '../../extension/core/har-util.js';

// Fake encoder: WebP 0.1 B/px, AVIF 0.07 B/px (or PNG when AVIF is "unsupported").
export const fakeEnv = ({ avif = true } = {}) => ({
  createImageBitmap: async () => ({ close() {} }),
  OffscreenCanvas: class {
    constructor(w, h) { this.w = w; this.h = h; }
    getContext() { return { drawImage() {} }; }
    async convertToBlob({ type }) {
      if (type === 'image/avif') return avif ? { type, size: Math.round(this.w * this.h * 0.07) } : { type: 'image/png', size: 1 };
      return { type, size: Math.round(this.w * this.h * 0.1) };
    }
  },
});

export const img = (src, nw, nh, dw, dh, extra = {}) => ({
  src, naturalWidth: nw, naturalHeight: nh, displayWidth: dw, displayHeight: dh, dpr: 1, loading: '', fetchpriority: '',
  decoding: '', sized: true, aboveFold: true, inPicture: false, alt: true, ...extra,
});

export const entry = (url, bytes, mime) => ({
  request: { url, method: 'GET', headers: [] },
  response: { status: 200, headers: [], bodySize: bytes, headersSize: 0, _transferSize: bytes, content: { mimeType: mime, size: bytes } },
  timings: {}, time: 1, startedDateTime: new Date(0).toISOString(),
});

const S = 'https://s.test/';
export const LONG = `${S}${'deep/'.repeat(150)}hero.jpg?v=${'x'.repeat(200)}`;
export const ODD = `${S}odd.png?q=<b>&r="1"`;

const base = {
  collected: {
    images: [
      img(`${S}big.jpg`, 2400, 1600, 300, 200, { loading: 'lazy', sized: false }),
      img(`${S}logo.png`, 400, 100, 400, 100),
      img(`${S}tiny.png`, 10, 10, 10, 10),
      img(`${S}anim.gif`, 300, 300, 300, 300),
      img(`${S}fail.jpg`, 800, 600, 800, 600),
      img('data:image/png;base64,xx', 1, 1, 1, 1),
    ],
    lcp: `${S}big.jpg`,
  },
  entries: [
    entry(`${S}big.jpg`, 1_000_000, 'image/jpeg'), entry(`${S}logo.png`, 60_000, 'image/png'), entry(`${S}tiny.png`, 2_000, 'image/png'),
    entry(`${S}anim.gif`, 400_000, 'image/gif'), entry(`${S}fail.jpg`, 200_000, 'image/jpeg'),
  ],
};

// Seven oversized images (detail names only five), one with a very long URL, one with "<" in its query; the LCP
// image is above the fold without fetchpriority; a small GIF stays below the GIF threshold.
const many = Array.from({ length: 7 }, (_, i) => (i === 0 ? LONG : i === 1 ? ODD : `${S}photo-${i}.jpg`));
const crowd = {
  collected: {
    images: [...many.map((u) => img(u, 1600, 1200, 200, 150)), img(`${S}small.gif`, 50, 50, 50, 50)],
    lcp: LONG,
  },
  entries: [...many.map((u, i) => entry(u, 120_000 + i * 1000, i === 1 ? 'image/png' : 'image/jpeg')), entry(`${S}small.gif`, 30_000, 'image/gif')],
};

/** name → { env, collected, entries, fetch? } */
export const CASES = {
  base: { env: fakeEnv(), ...base },
  'no avif': { env: fakeEnv({ avif: false }), ...base },
  'nothing measured': { env: fakeEnv(), ...base, fetch: async () => { throw new Error('offline'); } },
  crowd: { env: fakeEnv(), ...crowd },
};

const okFetch = async (url) => { if (url.endsWith('fail.jpg')) throw new Error('CORS'); return { ok: true, status: 200, blob: async () => ({}) }; };

/** Run the plugin on one case. */
export async function runCase(plugin, setImageEnv, c) {
  setImageEnv(c.env);
  try {
    return await plugin.run({ log: { entries: c.entries, _harplus: {} } }, {
      collected: c.collected, util, fetch: c.fetch || okFetch, skip: (m) => { throw new Error(m); },
    });
  } finally { setImageEnv(); }
}
