// Structure outline: headings nested by level inside the landmarks they sit in. Pure; the page-side collect()
// in plugins/a11y-structure.js records, per heading and per landmark, the chain of landmark ancestors
// (OUTERMOST first, so a heading in <nav> inside <header> carries [banner, navigation]).
//
// headings: [{ level, text, landmarks: [{ role, label, id? }], pos? }] in document order
// landmarksAll: [{ role, label, id?, landmarks: [ancestors, outermost first], pos? }] in document order
// -> nodes { kind: 'landmark' | 'heading', role?, label?, level?, text?, issues: ('empty' | 'skipped')[], children }
// A landmark is identified by its id (distinct elements), else by role and label. Where every sibling carries a
// document position (pos) headings and landmarks interleave in document order.

export function landmarkLabel(l) {
  return l.label ? `${l.role} “${l.label}”` : l.role;
}

const ident = (l) => (l.id != null ? `#${l.id}` : `${l.role}:${l.label || ''}`);

export function buildOutline(headings = [], landmarksAll = []) {
  const root = { children: [] };
  const nodes = new Map();
  const landmarkNode = (chain) => {
    let parent = root;
    let key = '';
    for (const l of chain) {
      key += `/${ident(l)}`;
      let node = nodes.get(key);
      if (!node) {
        node = { kind: 'landmark', role: l.role, label: l.label || '', issues: [], children: [], pos: l.pos, stack: [] };
        nodes.set(key, node);
        parent.children.push(node);
      }
      parent = node;
    }
    return parent;
  };
  for (const l of landmarksAll) {
    const node = landmarkNode([...(l.landmarks || []), l]);
    if (l.pos != null) node.pos = l.pos;
  }
  root.stack = [];
  let prev = null;
  for (const x of headings) {
    const container = landmarkNode(x.landmarks || []);
    const stack = container.stack;
    const text = String(x.text || '').trim();
    const issues = [];
    if (!text) issues.push('empty');
    if (prev != null && x.level > prev + 1) issues.push('skipped');
    prev = x.level;
    const node = { kind: 'heading', level: x.level, text, issues, children: [], pos: x.pos };
    while (stack.length && stack[stack.length - 1].level >= x.level) stack.pop();
    (stack.length ? stack[stack.length - 1] : container).children.push(node);
    stack.push(node);
  }
  const finish = (list) => {
    if (list.length > 1) {
      // Without positions, a landmark's own headings come before the landmarks nested in it.
      if (list.every((n) => n.pos != null)) list.sort((a, b) => a.pos - b.pos);
      else list.sort((a, b) => (a.kind === 'heading' ? 0 : 1) - (b.kind === 'heading' ? 0 : 1));
    }
    for (const n of list) {
      delete n.stack;
      delete n.pos;
      finish(n.children);
    }
    return list;
  };
  return finish(root.children);
}
