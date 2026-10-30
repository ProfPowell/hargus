// Representative inputs for the Content plugin's analyze(), shared by test/content.test.mjs and the findings baseline
// (content-findings-baseline.json, taken from the plugin before places were added). score-check cannot replay
// Content (a reading saves its analysis, not its input), so this is what proves every finding field but `places`
// is unchanged.

const W = 'https://www.site.test/';
export const LONG = `${W}${'deep/'.repeat(150)}page?v=${'x'.repeat(200)}`;
export const ODD = `${W}odd?q=<b>&r="1"`;
const words = (n, w = 'word') => Array(n).fill(w).join(' ');
const sentencesOf = (n, perSentence, w = 'word') => Array.from({ length: n }, () => `${words(perSentence, w)}.`).join(' ');
const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));

export const base = (over = {}) => ({
  url: `${W}a/b/`, lang: 'en', text: '', bodyTextBytes: 0,
  paragraphs: [], headings: [], navs: [], breadcrumb: false, links: [], ids: [], ...over,
});

const link = (href, text, extra = {}) => ({ href, raw: href, text, aria: '', region: 'main', selector: 'main > a', ...extra });

export const CASES = {
  links: {
    c: base({
      text: sentencesOf(8, 30),
      paragraphs: [{ text: words(160) }],
      links: [
        link(`${W}a`, 'Click here', { selector: 'main > p > a' }),
        link(`${W}b`, 'Read more', { region: 'footer', selector: 'footer > a' }),
        link(`${W}c`, 'Pricing'), link(`${W}d`, 'Pricing', { region: 'nav', selector: 'nav > a' }),
        link(`${W}a/b/#gone`, 'Jump', { selector: '#toc > a' }), link(`${W}a/b/#here`, 'Here'), link(`${W}a/b/#top`, 'Top'),
        link('mailto:x@site.test', 'Mail'), link('tel:+1', 'Call'), link('javascript:void(0)', 'JS'),
        link('https://other.test/x', 'Elsewhere'),
      ],
      ids: ['here'],
      headings: [{ level: 1, text: 'Hello' }, { level: 3, text: '' }],
    }),
    opts: { meta: { title: 'Hello' }, url: `${W}a/b/`, docBytes: 100_000 },
  },
  covered: {
    c: base({
      text: words(300),
      links: [link(`${W}a`, 'Click here'), link(`${W}a/b/#gone`, 'Jump')],
    }),
    opts: { meta: {}, url: `${W}a/b/`, covered: { vague: true, anchors: true } },
  },
  structure: {
    c: base({
      url: 'https://www.site.test/Shop/Big_Things/x/y/z/?sessionid=1',
      text: sentencesOf(6, 50, 'extraordinairement'), lang: 'fr',
      headings: [{ level: 1, text: 'Site' }, { level: 2, text: 'x'.repeat(130) }],
      navs: [{ links: 70, depth: 2, label: 'main' }],
      lineLengths: [90, 100, 40, 95, 85],
    }),
    opts: { meta: { title: 'Site', og: { 'og:site_name': 'Site' } }, url: 'https://www.site.test/Shop/Big_Things/x/y/z/?sessionid=1' },
  },
  crowded: {
    c: base({
      text: words(260),
      links: [
        ...many(15, (i) => link(`${W}v${i}`, 'Learn more', { selector: `main > a:nth-of-type(${i + 1})` })),
        ...many(250, (i) => link(`${W}a/b/#missing-${i}`, `Anchor ${i}`, { selector: `#toc > a:nth-of-type(${i + 1})` })),
        link(`${W}a/b/#odd<b>"1"`, 'Odd <b>'), link(`${LONG}`, 'More'),
        ...many(12, (i) => link(`${W}t${i}`, 'Same')),
      ],
    }),
    opts: { meta: {}, url: `${W}a/b/` },
  },
  odd: {
    c: base({ text: words(10), links: [link(ODD, 'Here'), link(`${W}odd2`, 'Here'), link(`${W}a/b/#<x>`, 'Go')] }),
    opts: { meta: {}, url: `${W}a/b/` },
  },
  empty: { c: base(), opts: { meta: {}, url: W } },
};
