// CSS composition: how the site's styles are built. Parses every stylesheet with the browser's own
// CSS engine — document sheets, cross-origin sheets (from recorded bodies, via constructable
// stylesheets), adopted sheets and open shadow roots — and reports architecture, metrics,
// modern features and lint-style issues. Feature usage feeds the Baseline plugin.

function collect(args) {
  // Recorded bodies, keyed by every URL that led to them (redirect hops included).
  const texts = new Map();
  for (const s of args?.sheets || []) for (const href of [s.href, ...(s.aliases || [])]) texts.set(href, s.text);
  const errors = [];
  const sources = [];
  const seenSheets = new Set();
  const seenHrefs = new Set();
  const seenShadowText = new Set();
  // A recorded body parsed by the browser. replaceSync() drops @import, so follow those by hand.
  const addText = (href, label, kind) => {
    if (!href || seenHrefs.has(href) || !texts.has(href)) return false;
    seenHrefs.add(href);
    const text = texts.get(href);
    let rules = null;
    try { const copy = new CSSStyleSheet(); copy.replaceSync(text); rules = copy.cssRules; } catch { rules = null; }
    sources.push({ label, kind, href, rules, parsedFrom: 'recorded body', bytes: text.length, media: '', disabled: false });
    for (const m of text.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi)) {
      try { addText(new URL(m[1], href).href, `@import ${m[1]}`, 'import'); } catch { /* bad URL */ }
    }
    return true;
  };
  const addSheet = (sheet, label, kind) => {
    if (!sheet || seenSheets.has(sheet)) return;
    seenSheets.add(sheet);
    let rules = null;
    try { rules = sheet.cssRules; } catch { /* cross-origin: fall back to the recorded body */ }
    if (!rules && addText(sheet.href, label, kind)) return;
    if (sheet.href) seenHrefs.add(sheet.href);
    sources.push({
      label, kind, href: sheet.href || null, rules, parsedFrom: 'cssom',
      bytes: sheet.href ? (texts.get(sheet.href)?.length ?? null) : (sheet.ownerNode?.textContent?.length ?? null),
      media: sheet.media?.mediaText || '', disabled: !!sheet.disabled,
    });
  };
  try {
    for (const sh of document.styleSheets) addSheet(sh, sh.href || 'inline <style>', sh.href ? 'linked' : 'inline');
    for (const sh of document.adoptedStyleSheets || []) addSheet(sh, 'adopted (document)', 'adopted');
  } catch (e) { errors.push(`document sheets: ${e.message}`); }
  // Open shadow roots, including ones nested inside other components. Identical <style> text in
  // many instances of one component is counted once.
  let shadowRoots = 0;
  const shadowHosts = new Set();
  try {
    const queue = [...document.querySelectorAll('*')].filter((el) => el.shadowRoot);
    while (queue.length && shadowRoots < 300) {
      const el = queue.shift();
      const sr = el.shadowRoot;
      shadowRoots++;
      shadowHosts.add(el.localName);
      for (const sh of sr.styleSheets) {
        const text = sh.ownerNode?.textContent;
        if (text != null && !sh.href) { if (seenShadowText.has(text)) continue; seenShadowText.add(text); }
        addSheet(sh, `<${el.localName}> shadow <style>`, 'shadow');
      }
      for (const sh of sr.adoptedStyleSheets || []) addSheet(sh, `<${el.localName}> adopted`, 'shadow');
      for (const inner of sr.querySelectorAll('*')) if (inner.shadowRoot) queue.push(inner);
    }
  } catch (e) { errors.push(`shadow roots: ${e.message}`); }

  const inc = (map, k, n = 1) => { map[k] = (map[k] || 0) + n; };
  const S = {
    rules: 0, styleRules: 0, emptyRules: 0, selectors: 0, declarations: 0, important: 0,
    idSelectors: 0, universal: 0, nested: 0, maxNesting: 0,
    specificity: { max: [0, 0, 0], maxSelector: '', sum: [0, 0, 0] },
    atRules: {}, media: {}, mediaFeatures: {}, supports: [], layers: [], containerQueries: 0,
    fontFaces: [], keyframes: 0, properties: {}, values: {}, functions: {}, units: {},
    pseudoClasses: {}, pseudoElements: {}, colors: {}, fontFamilies: {}, fontSizes: {}, zIndex: {},
    customDefined: {}, customUsed: {}, customUsedNoFallback: {}, vendor: {}, duplicateSelectors: 0,
    longestSelector: '', vwRules: 0,
  };
  const selectorSeen = {};

  const splitTop = (text, sep) => {
    const out = []; let depth = 0; let cur = ''; let quote = null;
    for (const ch of text) {
      if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[') depth++;
      if (ch === ')' || ch === ']') depth--;
      if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map((s) => s.trim()).filter(Boolean);
  };
  const specificity = (sel) => {
    let a = 0; let b = 0; let c = 0;
    let s = sel.replace(/\\./g, 'x');
    s = s.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, '');
    s = s.replace(/:(?:is|not|has|matches|-webkit-any)\(((?:[^()]|\([^()]*\))*)\)/g, (m, inner) => {
      const best = splitTop(inner, ',').map(specificity).sort((x, y) => y[0] - x[0] || y[1] - x[1] || y[2] - x[2])[0] || [0, 0, 0];
      a += best[0]; b += best[1]; c += best[2];
      return ' ';
    });
    s = s.replace(/\[[^\]]*\]/g, () => { b++; return ' '; });
    s = s.replace(/::[\w-]+(\([^)]*\))?/g, () => { c++; return ' '; });
    s = s.replace(/:(before|after|first-line|first-letter)\b/g, () => { c++; return ' '; });
    s = s.replace(/:[\w-]+(\((?:[^()]|\([^()]*\))*\))?/g, () => { b++; return ' '; });
    s = s.replace(/#[\w-]+/g, () => { a++; return ' '; });
    s = s.replace(/\.[\w-]+/g, () => { b++; return ' '; });
    c += s.replace(/[*&>+~|]/g, ' ').trim().split(/\s+/).filter((x) => /^[a-z]/i.test(x)).length;
    return [a, b, c];
  };
  const bigger = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

  const COLOR = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*(?:\([^()]*\)[^()]*)*\)/gi;
  const declaration = (prop, value, important) => {
    S.declarations++;
    if (important) S.important++;
    inc(S.properties, prop);
    const vendor = prop.match(/^-(webkit|moz|ms|o)-(.+)$/);
    if (vendor) inc(S.vendor, prop);
    if (prop.startsWith('--')) inc(S.customDefined, prop);
    for (const m of value.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
      inc(S.customUsed, m[1]);
      if (!m[2]) inc(S.customUsedNoFallback, m[1]);
    }
    for (const m of value.matchAll(/(-?[a-z][\w-]*)\(/gi)) inc(S.functions, m[1].toLowerCase());
    for (const m of value.matchAll(/\d(rem|em|px|vw|vh|vmin|vmax|dvh|svh|lvh|dvw|svw|lvw|dvi|dvb|cqi|cqw|cqh|cqb|cqmin|cqmax|ch|ex|lh|rlh|fr|cm|mm|in|pt|pc|deg|turn|ms|s)\b/gi)) inc(S.units, m[1].toLowerCase());
    if (!prop.startsWith('--')) {
      const kws = value.toLowerCase().replace(/\([^()]*\)/g, ' ').match(/(?<![\w-])[a-z][a-z-]*/g) || [];
      if (kws.length) {
        const set = (S.values[prop] ||= []);
        for (const k of kws) if (!set.includes(k) && set.length < 40) set.push(k);
      }
      for (const c of value.match(COLOR) || []) inc(S.colors, c.toLowerCase().replace(/\s+/g, ''));
    }
    if (prop === 'font-family') inc(S.fontFamilies, value.split(',')[0].trim().replace(/["']/g, ''));
    if (prop === 'font-size') inc(S.fontSizes, value.trim());
    if (prop === 'z-index') inc(S.zIndex, value.trim());
  };

  const declarations = (style) => {
    const decls = splitTop(style?.cssText || '', ';');
    for (const d of decls) {
      const i = d.indexOf(':');
      if (i < 1) continue;
      const prop = d.slice(0, i).trim().toLowerCase();
      let value = d.slice(i + 1).trim();
      const important = /!\s*important$/i.test(value);
      if (important) value = value.replace(/!\s*important$/i, '').trim();
      declaration(prop, value, important);
    }
    for (const prop of ['width', 'min-width']) if (/100vw/.test(style.getPropertyValue(prop) || '')) S.vwRules++;
    return decls.length;
  };
  // "&" in a selector means nesting — unless it sits inside an attribute value or a string.
  const hasAmp = (sel) => sel.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '').replace(/\[[^\]]*\]/g, '').includes('&');

  const styleRule = (r, depth) => {
    S.styleRules++;
    const selText = r.selectorText || '';
    const sels = splitTop(selText, ',');
    S.selectors += sels.length;
    const amp = hasAmp(selText);
    if (depth > 0 || amp) { S.nested++; S.maxNesting = Math.max(S.maxNesting, depth + (amp ? 1 : 0)); }
    for (const sel of sels) {
      const sp = specificity(sel);
      S.specificity.sum = S.specificity.sum.map((v, i) => v + sp[i]);
      if (bigger(sp, S.specificity.max) > 0) { S.specificity.max = sp; S.specificity.maxSelector = sel.slice(0, 200); }
      if (/#[\w-]/.test(sel.replace(/\[[^\]]*\]/g, ''))) S.idSelectors++;
      if (/(^|[\s>+~(])\*($|[\s>+~:.[)])/.test(sel)) S.universal++;
      for (const m of sel.matchAll(/(?<!:):([a-z-]+)/gi)) inc(S.pseudoClasses, m[1].toLowerCase());
      for (const m of sel.matchAll(/::([a-z-]+)/gi)) inc(S.pseudoElements, m[1].toLowerCase());
      if (sel.length > S.longestSelector.length) S.longestSelector = sel.slice(0, 300);
    }
    const ctxKey = `${selText}`;
    selectorSeen[ctxKey] = (selectorSeen[ctxKey] || 0) + 1;
    if (selectorSeen[ctxKey] === 2) S.duplicateSelectors++;
    if (!declarations(r.style) && !(r.cssRules?.length)) S.emptyRules++;
  };

  const mediaFeatures = (text) => {
    for (const m of String(text).matchAll(/\(\s*(?:not\s+)?([a-z-]+)\s*(?=[:<>=)])/gi)) inc(S.mediaFeatures, m[1].toLowerCase());
    if (/[<>]=?/.test(text)) inc(S.mediaFeatures, 'range-syntax');
  };

  const walk = (rules, depth) => {
    for (const r of rules) {
      // Declarations that follow a nested rule (Chrome 130+): part of the parent rule, not a new rule.
      if (window.CSSNestedDeclarations && r instanceof CSSNestedDeclarations) { declarations(r.style); continue; }
      S.rules++;
      const at = (name) => inc(S.atRules, name);
      if (r instanceof CSSStyleRule) {
        styleRule(r, depth);
        if (r.cssRules?.length) walk(r.cssRules, depth + 1);
      } else if (r instanceof CSSMediaRule) {
        at('media');
        const text = r.conditionText || r.media.mediaText;
        inc(S.media, text);
        mediaFeatures(text);
        walk(r.cssRules, depth);
      } else if (r instanceof CSSSupportsRule) {
        at('supports');
        if (S.supports.length < 30) S.supports.push(r.conditionText);
        walk(r.cssRules, depth);
      } else if (window.CSSLayerBlockRule && r instanceof CSSLayerBlockRule) {
        at('layer');
        if (!S.layers.includes(r.name || '(anonymous)')) S.layers.push(r.name || '(anonymous)');
        walk(r.cssRules, depth);
      } else if (window.CSSLayerStatementRule && r instanceof CSSLayerStatementRule) {
        at('layer');
        for (const n of r.nameList) if (!S.layers.includes(n)) S.layers.push(n);
      } else if (window.CSSContainerRule && r instanceof CSSContainerRule) {
        at('container');
        S.containerQueries++;
        mediaFeatures(r.conditionText || '');
        walk(r.cssRules, depth);
      } else if (r instanceof CSSFontFaceRule) {
        at('font-face');
        const fam = r.style.getPropertyValue('font-family').replace(/["']/g, '').trim();
        const display = r.style.getPropertyValue('font-display');
        if (S.fontFaces.length < 60) S.fontFaces.push({ family: fam, display: display || undefined, weight: r.style.getPropertyValue('font-weight') || undefined });
        if (display) declaration('font-display', display, false);
      } else if (r instanceof CSSKeyframesRule) {
        at('keyframes');
        S.keyframes++;
      } else if (r instanceof CSSImportRule) {
        at('import');
        // The imported sheet becomes its own source (walked by the loop below).
        let href = r.href;
        try { href = new URL(r.href, r.parentStyleSheet?.href || document.baseURI).href; } catch { /* keep as written */ }
        if (r.styleSheet) addSheet(r.styleSheet, `@import ${r.href}`, 'import');
        else addText(href, `@import ${r.href}`, 'import');
      } else if (window.CSSPropertyRule && r instanceof CSSPropertyRule) {
        at('property');
      } else if (window.CSSScopeRule && r instanceof CSSScopeRule) {
        at('scope');
        walk(r.cssRules, depth);
      } else if (window.CSSStartingStyleRule && r instanceof CSSStartingStyleRule) {
        at('starting-style');
        walk(r.cssRules, depth);
      } else if (r instanceof CSSPageRule) {
        at('page');
      } else if (window.CSSCounterStyleRule && r instanceof CSSCounterStyleRule) {
        at('counter-style');
      } else if (window.CSSFontPaletteValuesRule && r instanceof CSSFontPaletteValuesRule) {
        at('font-palette-values');
      } else if (window.CSSViewTransitionRule && r instanceof CSSViewTransitionRule) {
        at('view-transition');
      } else if (window.CSSPositionTryRule && r instanceof CSSPositionTryRule) {
        at('position-try');
      } else if (r.cssRules) {
        at(r.constructor?.name || 'unknown');
        walk(r.cssRules, depth);
      }
    }
  };

  const sheets = [];
  for (const src of sources) { // grows while walking (@import)
    const before = { rules: S.rules, decl: S.declarations };
    if (src.rules) {
      try { walk(src.rules, 0); } catch (e) { errors.push(`${src.label}: ${e.message}`); }
    }
    sheets.push({
      label: src.label, kind: src.kind, href: src.href, bytes: src.bytes, media: src.media || undefined,
      parsed: !!src.rules, parsedFrom: src.rules ? src.parsedFrom : undefined,
      rules: S.rules - before.rules, declarations: S.declarations - before.decl,
    });
  }
  const top = (obj, n = 30) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    sheets,
    shadowRoots,
    shadowHosts: [...shadowHosts].slice(0, 40),
    stats: {
      rules: S.rules, styleRules: S.styleRules, emptyRules: S.emptyRules, selectors: S.selectors,
      declarations: S.declarations, important: S.important, idSelectors: S.idSelectors, universal: S.universal,
      nested: S.nested, maxNesting: S.maxNesting, duplicateSelectors: S.duplicateSelectors,
      specificity: { max: S.specificity.max, maxSelector: S.specificity.maxSelector, avg: S.selectors ? S.specificity.sum.map((v) => Math.round((v / S.selectors) * 100) / 100) : [0, 0, 0] },
      longestSelector: S.longestSelector, keyframes: S.keyframes, containerQueries: S.containerQueries,
    },
    atRules: S.atRules,
    media: top(S.media, 40),
    mediaFeatures: S.mediaFeatures,
    supports: S.supports,
    layers: S.layers.slice(0, 50),
    fontFaces: S.fontFaces,
    usage: {
      properties: S.properties,
      values: S.values,
      functions: S.functions,
      units: S.units,
      pseudoClasses: S.pseudoClasses,
      pseudoElements: S.pseudoElements,
    },
    colors: top(S.colors, 60),
    colorCount: Object.keys(S.colors).length,
    fontFamilies: top(S.fontFamilies, 20),
    fontSizes: top(S.fontSizes, 40),
    fontSizeCount: Object.keys(S.fontSizes).length,
    zIndex: top(S.zIndex, 30),
    custom: {
      defined: Object.keys(S.customDefined).length,
      used: Object.keys(S.customUsed).length,
      unused: Object.keys(S.customDefined).filter((k) => !S.customUsed[k]).slice(0, 200),
      undefinedUsed: Object.keys(S.customUsedNoFallback).filter((k) => !S.customDefined[k]).slice(0, 100),
      prefixes: top(Object.keys(S.customDefined).reduce((acc, k) => { const p = (k.match(/^--([a-z0-9]+)-/i) || [])[1]; if (p) acc[p] = (acc[p] || 0) + 1; return acc; }, {}), 15),
    },
    vendor: top(S.vendor, 40),
    vwRules: S.vwRules,
    errors,
  };
}

// Custom-property prefixes that give away a framework or design system.
const FRAMEWORK_PREFIXES = [
  [/^--tw-/, 'Tailwind CSS'], [/^--bs-/, 'Bootstrap 5'], [/^--bulma-/, 'Bulma'], [/^--pico-/, 'Pico CSS'],
  [/^--mdc-|^--md-sys-|^--md-ref-/, 'Material Design'], [/^--chakra-/, 'Chakra UI'], [/^--mantine-/, 'Mantine'],
  [/^--ifm-/, 'Infima (Docusaurus)'], [/^--wp--preset--|^--wp--style--/, 'WordPress block theme (theme.json)'],
  [/^--sl-/, 'Shoelace'], [/^--wa-/, 'Web Awesome'], [/^--fa-/, 'Font Awesome'], [/^--swiper-/, 'Swiper'],
  [/^--spectrum-/, 'Adobe Spectrum'], [/^--cds-/, 'Carbon Design System'], [/^--pf-/, 'PatternFly'],
  [/^--ion-/, 'Ionic'], [/^--vp-/, 'VitePress'], [/^--tblr-/, 'Tabler'], [/^--docsearch-/, 'Algolia DocSearch'],
  [/^--color-(fg|canvas|border)-default/, 'GitHub Primer'], [/^--size-\d|^--radius-\d|^--shadow-\d/, 'Open Props'],
  [/^--nextui-|^--heroui-/, 'NextUI / HeroUI'], [/^--radix-/, 'Radix UI'], [/^--fluent-|^--colorNeutral/, 'Fluent UI'],
  [/^--uswds-/, 'USWDS'], [/^--gcds-/, 'GC Design System'], [/^--govuk-/, 'GOV.UK Frontend'],
];
// Prefixes no longer needed in any current browser (unprefixed support is long established).
const OBSOLETE_PREFIX = /^-(webkit|moz|ms|o)-(border-radius|box-shadow|transition|transform|animation|box-sizing|flex|flex-\w+|align-items|justify-content|order|opacity|background-size|border-image|columns|column-\w+|keyframes|linear-gradient|transform-origin)$/;

function collectArgs(ctx) {
  // Cross-origin stylesheets can't be read through the CSSOM; hand the page the recorded bodies.
  let budget = 6_000_000;
  const sheets = [];
  for (const e of ctx.har.log.entries) {
    if (ctx.util.resourceType(e) !== 'stylesheet') continue;
    const text = ctx.util.bodyText(e);
    if (!text || text.length > budget) continue;
    budget -= text.length;
    // The page refers to a redirected sheet by its original URL; the body sits on the last hop.
    const aliases = ctx.util.redirectChain(ctx.har, e).slice(0, -1).map((x) => x.request.url);
    sheets.push({ href: e.request.url, text, aliases: aliases.length ? aliases : undefined });
  }
  return { sheets };
}

function run(reading, ctx) {
  const c = ctx.collected;
  if (!c) ctx.skip('no page data');
  const s = c.stats;
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  const findings = [];
  const add = (severity, category, title, detail, evidence) => findings.push({ severity, category, title, detail, evidence });

  const definedNames = Object.keys(c.usage.properties).filter((p) => p.startsWith('--'));
  const frameworks = FRAMEWORK_PREFIXES.filter(([re]) => definedNames.some((n) => re.test(n))).map(([, name]) => name);
  const modern = [];
  if (c.layers.length) modern.push(`@layer (${c.layers.length})`);
  if (s.nested) modern.push('nesting');
  if (c.atRules.container) modern.push('container queries');
  if (c.usage.pseudoClasses.has) modern.push(':has()');
  if (c.atRules.scope) modern.push('@scope');
  if (c.atRules['starting-style']) modern.push('@starting-style');
  if (c.atRules.property) modern.push('@property');
  if (c.usage.properties['view-transition-name'] || c.atRules['view-transition']) modern.push('view transitions');
  if (c.usage.properties['anchor-name'] || c.usage.properties['position-anchor']) modern.push('anchor positioning');
  if (c.usage.values['grid-template-columns']?.includes('subgrid') || c.usage.values['grid-template-rows']?.includes('subgrid')) modern.push('subgrid');
  if (c.usage.functions.oklch || c.usage.functions.oklab) modern.push('OKLCH/OKLab colour');
  if (c.usage.functions['color-mix']) modern.push('color-mix()');
  if (c.usage.functions['light-dark']) modern.push('light-dark()');
  if (c.usage.functions.clamp) modern.push('clamp()');
  if (Object.keys(c.usage.properties).some((p) => /^(margin|padding|inset|border)-(block|inline)/.test(p))) modern.push('logical properties');
  if (c.mediaFeatures['range-syntax']) modern.push('media range syntax');
  if (c.mediaFeatures['prefers-color-scheme']) modern.push('dark-mode media query');
  if (c.mediaFeatures['prefers-reduced-motion']) modern.push('reduced-motion media query');

  const importantPct = pct(s.important, s.declarations);
  if (importantPct > 10) add('medium', 'quality', `!important on ${importantPct}% of declarations (${s.important})`, 'Heavy !important use usually signals a specificity war.');
  else if (importantPct > 2) add('low', 'quality', `!important on ${importantPct}% of declarations (${s.important})`);
  const idPct = pct(s.idSelectors, s.selectors);
  if (idPct > 10) add('low', 'quality', `${idPct}% of selectors use IDs`, 'ID selectors are hard to override; classes keep specificity flat.');
  if (s.specificity.max[0] >= 2) add('info', 'quality', `Highest specificity ${s.specificity.max.join(',')}`, s.specificity.maxSelector);
  if (s.duplicateSelectors > 50) add('info', 'quality', `${s.duplicateSelectors} selectors are declared more than once`);
  if (s.emptyRules > 10) add('info', 'quality', `${s.emptyRules} empty rules`);
  const obsolete = c.vendor.filter(([p]) => OBSOLETE_PREFIX.test(p));
  if (obsolete.length) add('info', 'quality', `${obsolete.length} obsolete vendor-prefixed properties`, 'Unprefixed versions have been supported for years.', obsolete.map(([p, n]) => `${p} ×${n}`).join('\n'));
  if (c.custom.undefinedUsed.length) add('low', 'quality', `${c.custom.undefinedUsed.length} custom properties used without a definition or fallback`, 'May be set from JavaScript or inline styles; otherwise they resolve to nothing.', c.custom.undefinedUsed.slice(0, 20).join(', '));
  if (c.custom.unused.length > 50) add('info', 'performance', `${c.custom.unused.length} custom properties defined but never used in CSS`, 'Typical of framework/design-token bundles.');
  if (c.colorCount > 100) add('info', 'quality', `${c.colorCount} distinct colour values`, 'A design-token palette usually needs far fewer.');
  if (c.fontSizeCount > 30) add('info', 'quality', `${c.fontSizeCount} distinct font-size values`);
  const unreadable = c.sheets.filter((x) => !x.parsed);
  if (unreadable.length) add('info', 'quality', `${unreadable.length} stylesheets could not be parsed (cross-origin, not recorded)`, 'Capture response bodies (text) to include them.', unreadable.map((x) => x.label).join('\n'));

  const totalBytes = c.sheets.reduce((n, x) => n + (x.bytes || 0), 0);
  const kinds = c.sheets.reduce((acc, x) => { acc[x.kind] = (acc[x.kind] || 0) + 1; return acc; }, {});
  const breakpoints = Object.keys(c.mediaFeatures).length
    ? c.media.map(([q]) => (q.match(/(min|max)-width:\s*([\d.]+(px|em|rem))|width\s*[<>]=?\s*([\d.]+(px|em|rem))/) || [])[0]).filter(Boolean)
    : [];
  return {
    data: { ...c, frameworks, modern, totalBytes, breakpoints: [...new Set(breakpoints)].slice(0, 12) },
    findings,
    summary: [
      { label: 'Stylesheets', value: `${c.sheets.length} (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')})${totalBytes ? ` · ${ctx.util.formatBytes(totalBytes)}` : ''}` },
      { label: 'Rules · selectors · declarations', value: `${s.styleRules.toLocaleString()} · ${s.selectors.toLocaleString()} · ${s.declarations.toLocaleString()}` },
      { label: 'Specificity', value: `max ${s.specificity.max.join(',')} · avg ${s.specificity.avg.join(',')}` },
      { label: '!important', value: `${s.important} (${importantPct}%)` },
      { label: 'Custom properties', value: `${c.custom.defined} defined · ${c.custom.used} used` },
      { label: 'Modern CSS', value: modern.join(', ') || 'none detected' },
      { label: 'Framework signals', value: frameworks.join(', ') },
      { label: 'Palette', value: `${c.colorCount} colours · ${c.fontSizeCount} font sizes · ${c.fontFamilies.length} families` },
      { label: 'Web components', value: c.shadowRoots ? `${c.shadowRoots} shadow roots (${c.shadowHosts.slice(0, 4).join(', ')})` : '' },
    ],
  };
}

function render(r, h) {
  const d = r.data;
  const s = d.stats;
  const pairs = (list) => list.map(([k, n]) => `${k} ×${n}`);
  return h.html`
    ${h.sub('Stylesheets', h.table(d.sheets.map((x) => ({
      source: x.href ? h.link(x.href, x.href.split('/').pop() || x.href) : x.label, kind: x.kind, size: x.bytes ? h.bytes(x.bytes) : '',
      rules: x.rules, declarations: x.declarations, parsed: x.parsed ? x.parsedFrom : 'no',
    })), ['source', 'kind', 'size', 'rules', 'declarations', 'parsed']))}
    ${h.sub('Architecture', h.kv([
      ['Cascade layers', d.layers.join(' → ')], ['Modern features', d.modern.join(', ')],
      ['Framework signals', d.frameworks.join(', ')], ['Custom property prefixes', pairs(d.custom.prefixes).join(', ')],
      ['Nesting', s.nested ? `${s.nested} nested rules, depth ${s.maxNesting}` : ''],
      ['At-rules', pairs(Object.entries(d.atRules)).join(', ')], ['@supports', d.supports.slice(0, 8).join(' | ')],
      ['Breakpoints', d.breakpoints.join(', ')], ['Media features', Object.keys(d.mediaFeatures).join(', ')],
    ]))}
    ${h.sub('Metrics', h.kv([
      ['Rules', s.rules], ['Style rules', s.styleRules], ['Selectors', s.selectors], ['Declarations', s.declarations],
      ['!important', s.important], ['ID selectors', s.idSelectors], ['Universal selectors', s.universal],
      ['Duplicate selectors', s.duplicateSelectors], ['Empty rules', s.emptyRules],
      ['Max specificity', `${s.specificity.max.join(',')} — ${s.specificity.maxSelector}`], ['Average specificity', s.specificity.avg.join(',')],
      ['Longest selector', s.longestSelector], ['Keyframes', s.keyframes],
    ]))}
    ${h.sub(`Colours (${d.colorCount})`, h.html`<div class="swatches">${d.colors.map(([col, n]) => h.html`<span class="swatch" title="${col} ×${n}"><i style="background:${/^[#a-z0-9(),.%\s/-]+$/i.test(col) ? col : 'transparent'}"></i>${col}</span>`)}</div>`)}
    ${h.sub('Typography', h.kv([
      ['Families', pairs(d.fontFamilies).join(', ')], ['@font-face', d.fontFaces.map((f) => `${f.family}${f.weight ? ` ${f.weight}` : ''}${f.display ? ` (${f.display})` : ''}`).join(', ')],
      [`Font sizes (${d.fontSizeCount})`, pairs(d.fontSizes).join(', ')],
    ]))}
    ${h.sub('Most used properties', h.tags(Object.entries(d.usage.properties).filter(([p]) => !p.startsWith('--')).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([p, n]) => `${p} ×${n}`)))}
    ${h.sub('Functions & units', h.kv([
      ['Functions', pairs(Object.entries(d.usage.functions).sort((a, b) => b[1] - a[1]).slice(0, 30)).join(', ')],
      ['Units', pairs(Object.entries(d.usage.units).sort((a, b) => b[1] - a[1])).join(', ')],
      ['Pseudo-classes', pairs(Object.entries(d.usage.pseudoClasses).sort((a, b) => b[1] - a[1]).slice(0, 30)).join(', ')],
      ['Pseudo-elements', pairs(Object.entries(d.usage.pseudoElements)).join(', ')],
    ]))}
    ${d.custom.undefinedUsed.length ? h.sub('Custom properties used but not defined', h.tags(d.custom.undefinedUsed)) : ''}
    ${d.vendor.length ? h.sub('Vendor-prefixed properties', h.tags(pairs(d.vendor))) : ''}
    ${d.zIndex.length ? h.sub('z-index values', h.tags(pairs(d.zIndex))) : ''}
    ${d.errors?.length ? h.html`<p class="note">Parts that could not be read: ${d.errors.join('; ')}</p>` : ''}
  `;
}

function glance(r, h) {
  const d = r.data;
  const s = d.stats;
  const pct = s.declarations ? Math.round((s.important / s.declarations) * 1000) / 10 : 0;
  return h.html`<div class="tiles">
    ${h.stat({ label: 'CSS rules', value: s.styleRules.toLocaleString('en-US') })}
    ${h.stat({ label: '!important', value: `${pct}%`, rating: pct <= 2 ? 'good' : pct <= 10 ? 'needs-improvement' : 'poor', note: `${s.important} declarations` })}
    ${h.stat({ label: 'Custom properties', value: d.custom.defined.toLocaleString('en-US'), note: `${d.custom.used} used` })}
    ${h.stat({ label: 'Colours', value: d.colorCount, note: `${d.fontFamilies.length} font families` })}
  </div>`;
}

export default {
  id: 'css',
  group: 'build',
  name: 'CSS composition',
  version: '0.1.1',
  phase: 'page',
  world: 'isolated', // recorded cross-origin CSS must not be handed to the page's own scripts
  description: 'Stylesheet architecture, metrics, specificity, custom properties, palette, modern CSS features and framework signals — parsed by the browser.',
  tags: ['quality', 'composition'],
  timeoutMs: 30_000,
  collectArgs,
  collect,
  run,
  render,
  glance,
};
