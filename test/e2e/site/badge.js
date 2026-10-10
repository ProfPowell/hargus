const sheet = new CSSStyleSheet();
sheet.replaceSync(':host { display: block; padding: 1rem; border-radius: 8px; background: light-dark(#eef, #223); } ::slotted(*) { color: inherit; }');
export function define() {
  customElements.define('hp-card', class extends HTMLElement {
    constructor() { super(); const root = this.attachShadow({ mode: 'open' }); root.adoptedStyleSheets = [sheet]; root.innerHTML = '<slot></slot>'; }
  });
  new IntersectionObserver(() => {}).observe(document.body);
}
