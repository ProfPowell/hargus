// Rule data for the punch list: for each finding rule (key "<plugin>/<id>") what correct looks like (Expected)
// and whether it can be checked on any server (Page), needs the real server or CDN (Deploy), or depends on
// measured speed (Timing). Pure data and lookups. Accessibility Expected text and links come from a11y-reference.js.
// Tag rule: when unsure, Deploy. A wrong Deploy tag costs a "verify after deploy"; a wrong Page tag costs a false "fixed".

import { referenceFor, wcagLabel } from './a11y-reference.js';

const PAGE = 'Page';
const DEPLOY = 'Deploy';
const TIMING = 'Timing';

/** Tag by plugin area; Performance, Build and Sustainability are tagged rule by rule below. */
const AREA_TAG = { accessibility: PAGE, content: PAGE, international: PAGE, security: DEPLOY, infrastructure: DEPLOY };
/** Plugins whose every rule depends on measured speed. */
const PLUGIN_TAG = { pagespeed: TIMING };

const p = (expected) => ({ tag: PAGE, expected });
const d = (expected) => ({ tag: DEPLOY, expected });
const t = (expected) => ({ tag: TIMING, expected });
const x = (expected) => ({ expected });

/**
 * Rule data keyed "<plugin>/<rule id>". `tag` is set where the area default is wrong or where the area has no default
 * (performance, build, sustainability). `expected` is one outcome-shaped sentence: what correct looks like.
 */
export const RULES = {
  // accessibility overrides: outcome-shaped where the reference's fix describes a code change
  'a11y-basics/image-alt': p('Every image has alt text that conveys its purpose, or an empty alt when it is decorative.'),
  'a11y-basics/input-label': p('Every form field has a visible label that is tied to it.'),
  'a11y-basics/button-name': p('Every button has an accessible name that says what it does.'),
  'a11y-basics/link-name': p('Every link has an accessible name that says where it goes.'),
  'a11y-basics/frame-title': p('Every iframe has a short title that describes its content.'),
  'a11y-basics/focusable-hidden': p('Nothing focusable sits inside an aria-hidden container.'),
  'a11y-basics/link-broken-anchor': p('Every in-page link points at an element that exists.'),
  'a11y-basics/layout-table': p('Layout uses CSS, and tables are used only for data with header cells.'),
  'a11y-basics/autoplay-audio': p('Media does not play sound on its own, or it can be paused from the first control.'),
  'a11y-map/long-alt': p('Alt text is short, under about 100 characters, with longer descriptions given in the page text.'),
  'a11y-structure/headings-skipped': p('Heading levels descend one at a time, with none skipped.'),
  'a11y-structure/aria-refs': p('Every ARIA reference points at an id that exists.'),
  'a11y-structure/http-links': p('Links point at HTTPS addresses.'),
  'a11y-structure/kb-clickable': p('Everything that can be clicked can also be reached and used with the keyboard.'),
  'a11y-structure/kb-focus-lost': p('Focus never falls back to the page start while tabbing.'),
  'a11y-structure/kb-hidden': p('Every keyboard stop is visible on screen.'),
  'a11y-structure/kb-no-focus-style': p('Every keyboard stop shows a clear visible focus indicator.'),
  'a11y-structure/kb-no-skip-link': p('A skip link to the main content is the first keyboard stop.'),
  'a11y-structure/kb-skip-target': p('The skip link lands on a visible main content target.'),
  'a11y-structure/label-in-name': p('A control\'s accessible name contains its visible label text.'),
  'a11y-structure/possible-heading': p('Text that works as a heading is marked up as a heading.'),
  'a11y-structure/small-text': p('Text is at least 12 px.'),
  'a11y-structure/tiny-text': p('Text is at least 12 px.'),
  'a11y-structure/targets-24': p('Touch and click targets are at least 24 by 24 px, or have enough space around them.'),
  'a11y-structure/underline-nonlink': p('Underlines are used only for links.'),
  'a11y-structure/vague-link': p('Link text says where the link goes.'),
  'a11y-views/forced-icons': p('Icon-only controls stay visible in forced colours mode.'),
  'a11y-views/print-chrome': p('Printed pages leave out navigation and site chrome.'),
  'a11y-views/print-overlays': p('Fixed and sticky overlays are hidden when the page is printed.'),
  'a11y-views/reflow-scroll': p('At 320 px wide the page reflows to one column with no sideways scroll.'),
  'a11y-views/text200-ignored': p('Text follows the browser\'s font-size setting.'),
  'a11y-views/text200-scroll': p('At 200% text size the page does not scroll sideways.'),
  'contrast/contrast-pair': p('Text has a contrast ratio of at least 4.5:1 against its background (3:1 for large text).'),
  'contrast/contrast-unknown': p('Text over images or gradients is readable against every part of its background.'),
  'contrast/contrast-apca': p('Text contrast also meets APCA guidance for its size and weight.'),
  // security (Deploy unless noted)
  'security/plain-http': x('The page is served over HTTPS, and plain HTTP requests redirect to it.'),
  'security/missing-hsts': x('Responses carry a Strict-Transport-Security header with a max-age of at least six months.'),
  'security/short-hsts': x('The Strict-Transport-Security max-age is at least six months (15552000 seconds).'),
  'security/csp-report-only': x('The Content-Security-Policy is enforced, not only reported.'),
  'security/missing-csp': x('Responses carry a Content-Security-Policy that restricts where scripts and other content can load from.'),
  'security/csp-unsafe-inline': x('The Content-Security-Policy does not allow unsafe-inline scripts.'),
  'security/csp-unsafe-eval': x('The Content-Security-Policy does not allow unsafe-eval.'),
  'security/csp-wildcard-script-src': x('The Content-Security-Policy lists specific script sources instead of a wildcard.'),
  'security/csp-no-object-src': x('The Content-Security-Policy sets object-src (usually to none).'),
  'security/csp-no-base-uri': x('The Content-Security-Policy sets base-uri (usually to self or none).'),
  'security/framable': x('Other sites cannot embed the page in a frame, via frame-ancestors or X-Frame-Options.'),
  'security/missing-nosniff': x('Responses carry X-Content-Type-Options: nosniff.'),
  'security/missing-referrer-policy': x('Responses carry a Referrer-Policy that limits what is sent to other sites.'),
  'security/missing-permissions-policy': x('Responses carry a Permissions-Policy that turns off browser features the site does not use.'),
  'security/version-disclosure': x('Response headers do not reveal server software or version numbers.'),
  'security/cors-any-origin': x('Cross-origin access is limited to the origins that need it, not every origin.'),
  'security/cookie-no-secure': x('Every cookie is sent with the Secure attribute.'),
  'security/cookie-no-httponly': x('Cookies that scripts do not need are sent with the HttpOnly attribute.'),
  'security/cookie-samesite-none-insecure': x('Cookies with SameSite=None also carry the Secure attribute.'),
  'security/mixed-content': x('Everything the page loads comes over HTTPS.'),
  'security/missing-sri': p('Scripts and styles loaded from other sites carry a Subresource Integrity hash.'),
  'security/tls-expired': x('The TLS certificate is valid and has not expired.'),
  'security/tls-expiring': x('The TLS certificate is valid for at least another 30 days, or renews automatically.'),
  'security/outdated-tls': x('The server negotiates TLS 1.2 or newer.'),
  'security/ct-not-compliant': x('The certificate is logged in Certificate Transparency logs.'),
  'security/other-cert-expiring': x('Certificates on the other hosts the page uses are valid for at least another 30 days.'),
  // well-known
  'well-known/missing-robots': x('The site serves a robots.txt at its root.'),
  'well-known/robots-allows-only-this-page': x('robots.txt does not leave the rest of the site blocked from crawlers.'),
  'well-known/robots-blocks-all': x('robots.txt does not block all crawlers from the whole site.'),
  'well-known/missing-security-txt': x('The site publishes a security.txt that says how to report a vulnerability.'),
  'well-known/security-txt-expired': x('The security.txt Expires date is in the future.'),
  'well-known/missing-sitemap': x('The site publishes a sitemap and links it from robots.txt.'),
  'well-known/robots-blocks-crawler': x('robots.txt blocks only the crawlers you intend to block.'),
  'well-known/x-robots-noindex': x('The page is not marked noindex in the X-Robots-Tag header unless it should stay out of search.'),
  'well-known/robots-noindex': x('robots.txt does not carry noindex rules that keep the page out of search by mistake.'),
  'well-known/robots-crawl-delay': x('robots.txt does not rely on Crawl-delay, which most major crawlers ignore.'),
  'well-known/robots-unknown-directives': x('robots.txt contains only directives that crawlers understand.'),
  'well-known/robots-duplicate-groups': x('robots.txt lists each user-agent group once.'),
  'well-known/robots-blocks-ai': x('robots.txt blocks or allows AI crawlers as you intend.'),
  'well-known/mobile-apps': x('The app association files the site declares are served and valid.'),
  'well-known/ads-txt': x('The ads.txt file is served and lists only sellers you authorise.'),
  // dns
  'dns/missing-spf': x('The domain publishes one SPF record that lists the servers allowed to send its mail.'),
  'dns/spf-no-mx-not-locked': x('The SPF record ends in -all or ~all so unlisted senders are rejected or flagged.'),
  'dns/multiple-spf': x('The domain publishes exactly one SPF record.'),
  'dns/spf-plus-all': x('The SPF record does not end in +all, which authorises every sender.'),
  'dns/spf-neutral-all': x('The SPF record ends in -all or ~all, not ?all.'),
  'dns/spf-too-many-lookups': x('The SPF record needs no more than 10 DNS lookups.'),
  'dns/missing-dmarc': x('The domain publishes a DMARC record.'),
  'dns/dmarc-none': x('The DMARC policy is quarantine or reject, not none.'),
  'dns/dmarc-partial': x('The DMARC policy applies to all mail (pct=100).'),
  'dns/missing-caa': x('The domain publishes CAA records that name the certificate authorities allowed to issue for it.'),
  'dns/no-dnssec': x('The domain is signed with DNSSEC.'),
  'dns/parked-nameservers': x('The domain uses working nameservers, not a parking service.'),
  // whois
  'whois/domain-expired': x('The domain registration is current.'),
  'whois/domain-expiring': x('The domain registration runs for at least another 60 days or renews automatically.'),
  'whois/new-domain': x('The domain has been registered for longer than a few weeks.'),
  'whois/young-domain': x('The domain has been registered for longer than a year.'),
  'whois/domain-on-hold': x('The domain is not on hold and resolves normally.'),
  'whois/not-transfer-locked': x('The domain has a registrar transfer lock turned on.'),
  // exposure and reputation
  'exposure/known-cves': x('The servers behind the site run software with no known vulnerabilities.'),
  'exposure/sensitive-services': x('Database, remote-access and admin services are not reachable from the internet.'),
  'exposure/extra-open-ports': x('Only the ports the site needs are open to the internet.'),
  'exposure/shodan-tag': x('Shodan no longer tags the server as vulnerable or end of life.'),
  'reputation/abuseipdb-reported': x('The server addresses have no abuse reports.'),
  'reputation/virustotal-malicious': x('No security vendor flags the site as malicious.'),
  'reputation/virustotal-suspicious': x('No security vendor flags the site as suspicious.'),
  'reputation/greynoise-malicious': x('The server address is not seen attacking other hosts.'),
  'reputation/greynoise-scanning': x('The server address is not seen scanning the internet.'),
  'observatory/observatory-grade': x('The site scores a B or better in the MDN HTTP Observatory.'),
  // network
  'network/heavy-page': d('The page transfers a size in line with its content, ideally under about 2 MB.'),
  'network/many-requests': p('The page makes a modest number of requests, ideally under about 100.'),
  'network/heavy-javascript': d('The JavaScript the page loads is small enough to download and run quickly on a phone.'),
  'network/uncompressed-text': d('Text responses such as HTML, CSS, JavaScript and JSON are compressed with Brotli or gzip.'),
  'network/no-cache-headers': d('Static files carry cache headers (Cache-Control with a max-age) so repeat visits reuse them.'),
  'network/failed-requests': d('Every request the page makes succeeds.'),
  'network/asset-errors': p('Every image, script and style the page references loads without an error.'),
  'network/request-errors': d('Every request the page makes succeeds.'),
  'network/long-redirect-chain': d('Requests reach their final address in at most one redirect.'),
  'network/http1-main-document': d('The page is served over HTTP/2 or HTTP/3.'),
  'network/many-third-party-hosts': p('The page loads from a small number of third-party hosts.'),
  'network/large-images': p('Images are sized and compressed so none is unusually large.'),
  'network/snapshot-reading': d('The page is recorded from a live load so every network check can run.'),
  'head-order/head-out-of-order': p('The head lists meta, title, preconnect, scripts and styles in the recommended order.'),
  'head-order/late-charset': p('The character set declaration comes in the first 1024 bytes of the head.'),
  // meta
  'meta/missing-title': p('The page has a title element that says what the page is.'),
  'meta/long-title': p('The title is short enough that search results do not cut it off, about 60 characters.'),
  'meta/short-title': p('The title is long enough to describe the page.'),
  'meta/missing-description': p('The page has a meta description that summarises it.'),
  'meta/long-description': p('The meta description is short enough to show in search results.'),
  'meta/short-description': p('The meta description summarises the page in its own words, not the title.'),
  'meta/missing-canonical': p('The page declares a canonical URL.'),
  'meta/canonical-other-host': d('The canonical URL points at the site\'s own address.'),
  'meta/noindex': p('The page is not marked noindex unless it should stay out of search.'),
  'meta/missing-viewport': p('The page has a viewport meta tag with width=device-width.'),
  'meta/missing-h1': p('The page has one h1 heading that names the page.'),
  'meta/multiple-h1': p('The page has a single h1 heading.'),
  'meta/incomplete-og': p('The page sets the Open Graph title, description, image and url for link previews.'),
  'meta/og-url-mismatch': d('The Open Graph url matches the page\'s canonical address.'),
  'meta/relative-share-image': p('The share image uses a full address, including the host.'),
  'meta/duplicate-meta-tags': p('Each meta tag appears once.'),
  'meta/missing-twitter-card': p('The page sets a Twitter card type for link previews.'),
  'meta/missing-jsonld': p('The page carries JSON-LD structured data that describes it.'),
  'meta/missing-favicon': p('The page declares a favicon.'),
  'meta/jsonld-parse-error': p('Every JSON-LD block is valid JSON.'),
  'meta/quirks-mode': p('The page starts with a doctype so browsers render it in standards mode.'),
  'meta/non-utf8-encoding': d('The page is served and declared as UTF-8.'),
  'meta/images-no-dimensions': p('Images carry width and height attributes so the layout does not shift as they load.'),
  'meta/form-plain-http': d('Forms submit to HTTPS addresses.'),
  'meta/password-over-http': d('Password fields sit on pages that submit over HTTPS.'),
  'meta/third-party-form': p('Forms submit to the site\'s own host unless a trusted service handles them.'),
  // tech
  'tech/outdated-jquery': p('The page uses a supported jQuery version with no known vulnerabilities.'),
  'tech/outdated-jquery-ui': p('The page uses a supported jQuery UI version with no known vulnerabilities.'),
  'tech/outdated-bootstrap-3': p('The page uses a supported Bootstrap version.'),
  'tech/outdated-bootstrap-4': p('The page uses a supported Bootstrap version.'),
  'tech/angularjs-eol': p('The page does not depend on AngularJS, which is no longer supported.'),
  'tech/moment-maintenance': p('The page uses a library that is still actively maintained instead of Moment.js.'),
  'tech/ad-vendors': p('The page loads only the advertising and tracking vendors you intend.'),
  // html
  'html/fake-buttons': p('Clickable controls are real button or a elements, not divs and spans.'),
  'html/generic-markup': p('Content uses meaningful elements such as header, nav, main, article and section, not generic divs.'),
  'html/inline-handlers': p('Behaviour is attached with script, not inline on-event attributes.'),
  'html/many-inline-styles': p('Styles live in stylesheets, not in style attributes.'),
  'html/obsolete-elements': p('The page uses no obsolete HTML elements.'),
  'html/presentational-attributes': p('Appearance is set in CSS, not in presentational HTML attributes.'),
  'html/no-lazy-images': p('Images below the fold carry loading="lazy".'),
  'html/legacy-doctype': p('The page starts with the HTML doctype.'),
  'html/undefined-custom-elements': p('Every custom element on the page is defined.'),
  'html-validate/html-validation-errors': p('The HTML passes the W3C validator with no errors.'),
  'css-validate/css-validation-errors': p('The CSS passes the W3C validator with no errors.'),
  // css
  'css/important-overuse': p('Styles rarely need !important.'),
  'css/id-selectors': p('Styles select by class or element, not by id.'),
  'css/high-specificity': p('Selectors stay low in specificity so later rules can override them.'),
  'css/duplicate-selectors': p('Each selector is defined once and rules are merged.'),
  'css/empty-rules': p('Stylesheets contain no empty rules.'),
  'css/obsolete-vendor-prefixes': p('Stylesheets use standard properties without obsolete vendor prefixes.'),
  'css/undefined-custom-properties': p('Every CSS variable that is used is defined.'),
  'css/unused-custom-properties': p('Every CSS variable that is defined is used.'),
  'css/many-colours': p('The stylesheets draw from a small, consistent palette.'),
  'css/many-font-sizes': p('The stylesheets use a small, consistent set of font sizes.'),
  'css/unparsed-stylesheets': p('Every stylesheet can be read and checked.'),
  // javascript
  'javascript/compromised-script-host': p('The page loads no script from a host known to serve malicious code.'),
  'javascript/public-source-maps': d('Source maps are not publicly served in production.'),
  'javascript/unminified-scripts': d('Production scripts are minified.'),
  'javascript/legacy-transpilation': d('Scripts ship modern syntax and are not transpiled for old browsers.'),
  'javascript/eval-used': p('Scripts do not call eval or build code from strings.'),
  'javascript/document-write': p('Scripts do not use document.write.'),
  'javascript/third-party-js-share': p('Most of the JavaScript on the page is the site\'s own.'),
  'javascript/script-bodies-missing': d('The script bodies were readable so the script checks could run.'),
  // console
  'console/uncaught-errors': p('The page runs without uncaught JavaScript errors.'),
  'console/console-errors': p('The page logs no errors to the console.'),
  'console/csp-violations': d('The page triggers no Content-Security-Policy violations.'),
  'console/mixed-content-blocked': d('The browser blocks no mixed content because everything loads over HTTPS.'),
  'console/deprecated-features': p('The page uses no features the browser has deprecated.'),
  'console/cookie-issues': d('The browser reports no cookie issues.'),
  'console/failed-requests': d('The console shows no failed requests.'),
  // layout, resilience
  'layout/viewport-width-100vw': p('Layout uses 100% width instead of 100vw so a vertical scrollbar adds no sideways scroll.'),
  'layout/breakpoint-overflow': p('The page does not scroll sideways at or around the site\'s own breakpoints.'),
  'layout/breakpoint-text-clip': p('Text is not clipped at or around the site\'s own breakpoints.'),
  'resilience/nojs-almost-no-content': p('The main content is in the HTML, so the page is readable without JavaScript.'),
  'resilience/nojs-partial-content': p('Most of the content is in the HTML, so the page is readable without JavaScript.'),
  'resilience/nojs-links-missing': p('Navigation links are in the HTML, so they work without JavaScript.'),
  'resilience/nocss-hidden-content': p('Content is not hidden by default and revealed only by CSS.'),
  'resilience/view-unverified': p('The views the page is tested in were recorded.'),
  // vitals
  'vitals/slow-metric': t('The measured loading metrics (TTFB, FCP, LCP and CLS) fall in the good range.'),
  'vitals/main-thread-blocked': t('Scripts do not block the main thread for long stretches during load.'),
  'vitals/render-blocking': p('Scripts and styles in the head do not block the first paint.'),
  'vitals/large-dom': p('The page keeps its DOM small, ideally under about 1,500 elements.'),
  'vitals/tab-hidden': t('The page is measured in a visible tab so the timings are valid.'),
  // images
  'images/oversized-images': p('Images are no larger than the size they are shown at.'),
  'images/modern-formats': d('Images are served as AVIF or WebP where the browser supports them.'),
  'images/lcp-image-lazy': p('The main image is not lazy loaded.'),
  'images/lcp-image-no-priority': p('The main image has fetchpriority="high" so it loads early.'),
  'images/animated-gif': p('Animations use video or animated WebP, not large GIFs.'),
  // carbon
  'carbon/carbon-rating': d('A page view emits little carbon, with a rating of C or better.'),
  'carbon/host-not-green': d('The site is hosted on verified green hosting.'),
  // coverage
  'coverage/unused-js': p('Most of the JavaScript the page loads is used.'),
  'coverage/unused-css': p('Most of the CSS the page loads is used.'),
  // content
  'content/long-sentences': p('Sentences are short enough to read in one go.'),
  'content/wall-of-text': p('Text is broken into short paragraphs with headings.'),
  'content/thin-content': p('The page carries enough text to be useful.'),
  'content/hard-to-read': p('The text reads at a level the audience can follow, around grade 8 for general readers.'),
  'content/mostly-markup': p('Most of the page\'s bytes are text, not markup.'),
  'content/long-headings': p('Headings are short and scannable.'),
  'content/title-repeats-h1': p('The title adds to the h1 instead of repeating it.'),
  'content/title-site-name-only': p('The title says what the page is, not only the site name.'),
  'content/menu-overload': p('Menus offer a manageable number of choices.'),
  'content/no-breadcrumbs': p('Pages deep in the site show breadcrumbs.'),
  'content/url-shape': p('The page address is short, readable and lowercase.'),
  'content/vague-link-text': p('Link text says where the link goes.'),
  'content/conflicting-link-text': p('Links with the same text go to the same place.'),
  'content/missing-anchors': p('Headings carry ids so sections can be linked to.'),
  'content/link-dense': p('Links make up a modest share of the page text.'),
  'content/long-lines': p('Lines of text are about 45 to 80 characters wide.'),
  'content/short-lines': p('Lines of text are wide enough to read comfortably, about 45 characters or more.'),
  // links
  'links/insecure-redirect': p('Links to the site\'s own pages point at the final HTTPS address.'),
  'links/insecure-redirect-more': p('Links to the site\'s own pages point at the final HTTPS address.'),
  'links/cross-site-http-redirect': p('Links point at the final HTTPS address of other sites.'),
  'links/link-redirects': p('Links point at the final address, not a redirect.'),
  'links/broken-page': p('The page itself responds successfully.'),
  'links/broken-internal': p('Every link to a page on the site works.'),
  'links/broken-external': p('Every link to another site works.'),
  'links/og-image-broken': d('The share image loads.'),
  'links/og-image-small': p('The share image is at least 1200 by 630 pixels.'),
  'links/share-image-heavy': d('The share image is under about 1 MB.'),
  // international and language
  'international/pseudo-text-clipped': p('Text with longer translations still fits in its container.'),
  'international/pseudo-sideways-scroll': p('Longer translated text does not make the page scroll sideways.'),
  'international/rtl-sideways-scroll': p('The page does not scroll sideways when set right to left.'),
  'international/rtl-text-unmarked': p('Right-to-left text is marked with the dir attribute.'),
  'international/physical-css-properties': p('Layout CSS uses logical properties such as margin-inline-start instead of left and right.'),
  'international/invalid-lang-tag': p('Every lang attribute is a valid language tag.'),
  'international/hreflang-problems': p('hreflang links are valid and point back to each other.'),
  'international/translated-text-clipped': p('Text still fits when the browser translates the page.'),
  'international/translated-sideways-scroll': p('The page does not scroll sideways when the browser translates it.'),
  'international/translated-text-left': p('Translatable text is not left in its source language when the browser translates the page.'),
  'international/translated-embedded-areas': p('Translated pages keep text inside embedded areas readable.'),
  'language/missing-lang': p('The html element carries a lang attribute.'),
  'language/declared-lang-mismatch': p('The declared page language matches the language of the text.'),
  'language/untagged-passages': p('Passages in another language carry their own lang attribute.'),
  'language/wrong-lang-attribute': p('Each lang attribute names the language of the text it covers.'),
  'language/attribute-text-language': p('Alt and label text is in the same language as the page, or marked with its own lang.'),
  'language/content-language-mismatch': d('The Content-Language header matches the page language.'),
  'language/encoding-inconsistent': d('The header and the page declare the same character encoding.'),
  'language/encoding-undeclared': d('The page declares its character encoding as UTF-8.'),
  'language/garbled-text': p('Text displays correctly with no garbled characters.'),
  'language/replacement-characters': p('Text contains no replacement characters (�).'),
  'language/regional-formats': p('Dates, numbers and currency follow the formats of the page language.'),
  'language/text-in-images': p('Text is real text, not part of an image.'),
};

/** Whether `text` is one outcome sentence: a single line, ends with a full stop, no code fence. */
export const isOneSentence = (text) => typeof text === 'string' && text.length > 0 && !/[\r\n]/.test(text) && !text.includes('```') && text.endsWith('.');

/** First sentence of a block of text, ending with a full stop. */
function firstSentence(text) {
  const s = String(text || '').trim().split(/(?<=[.!?])\s+(?=[A-Z])/)[0].trim();
  return s ? (/[.!?]$/.test(s) ? s : `${s}.`) : '';
}

/** The tag for a rule not in the table: by plugin, then area; Deploy when unknown. */
function defaultTag(pluginId, area) {
  return PLUGIN_TAG[pluginId] || AREA_TAG[area] || DEPLOY;
}

/**
 * What the punch list needs to know about a rule: { tag: 'Page'|'Deploy'|'Timing', expected?, ref? }.
 * `extra` is { help, url, tags } from an axe finding. Accessibility rules without table text use the first sentence of the
 * reference's fix.
 */
export function ruleInfo(pluginId, ruleId, area, extra = {}) {
  const row = Object.hasOwn(RULES, `${pluginId}/${ruleId}`) ? RULES[`${pluginId}/${ruleId}`] : {};
  const info = { tag: row.tag || defaultTag(pluginId, area) };
  let expected = row.expected;
  if (area === 'accessibility') {
    const ref = referenceFor(pluginId, ruleId, extra.tags, extra);
    if (ref) {
      const w = ref.wcag[0];
      if (ref.url) info.ref = { label: `${pluginId === 'axe' ? 'axe' : 'Guidance'}: ${ruleId}`, url: ref.url };
      else if (w) info.ref = { label: wcagLabel(w), url: w.url };
      if (!expected) expected = pluginId === 'axe' ? (extra.help ? `${String(extra.help).replace(/\.$/, '')}.` : '') : firstSentence(ref.fix);
    }
  }
  if (expected) info.expected = expected;
  return info;
}

/** The rule keys ("plugin/id") that have no Expected text. */
export function missingExpected(ruleKeys = []) {
  return [...new Set(ruleKeys)].filter((k) => {
    const [plugin, ...rest] = String(k).split('/');
    const id = rest.join('/');
    if (plugin === 'axe') return false; // axe text comes from the finding's own help
    if (Object.hasOwn(RULES, k) && RULES[k].expected) return false;
    const a11y = ['a11y-basics', 'a11y-structure', 'a11y-views', 'a11y-map', 'contrast'].includes(plugin);
    return !(a11y && ruleInfo(plugin, id, 'accessibility').expected);
  }).sort();
}
