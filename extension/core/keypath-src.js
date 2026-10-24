// The one keyPath: a selector that names one element (a unique id, or tag/class/nth-of-type steps up to six levels),
// prefixed by its shadow host's path and " >>> " inside an open shadow root. The keyboard walk's stops, the structure
// collector's markers and the basics collector's evidence all use it, and the Page map resolves it.
// Page code is serialised, so it cannot import this: collectors declare `pageDeps: { keyPath: KEYPATH_SRC }` and
// fnSource (browser/capture.js) compiles the source in front of them, so `keyPath` is in scope in the page.

function keyPath(node) {
  const parts = [];
  for (let n = node; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
    let p = n.localName;
    const root = n.getRootNode?.() || document;
    if (n.id && (root.querySelectorAll ? root : document).querySelectorAll(`#${CSS.escape(n.id)}`).length === 1) { parts.unshift(`${p}#${CSS.escape(n.id)}`); break; }
    if (n.classList.length) p += `.${[...n.classList].slice(0, 2).map((c) => CSS.escape(c)).join('.')}`;
    const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.localName === n.localName) : [];
    if (same.length > 1) p += `:nth-of-type(${same.indexOf(n) + 1})`;
    parts.unshift(p);
    if (n.localName === 'body') break;
  }
  const host = node.getRootNode?.()?.host;
  return host ? `${keyPath(host)} >>> ${parts.join(' > ')}` : parts.join(' > ');
}

export const KEYPATH_SRC = keyPath.toString();
