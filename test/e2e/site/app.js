// Pretend jQuery so the tech plugin has something to fingerprint.
window.jQuery = { fn: { jquery: '3.4.1' } };
customElements.define('hp-badge', class extends HTMLElement {});
fetch('/api/data.json').then((r) => r.json()).then((d) => { document.querySelector('main p').append(` (${d.items} items)`); });
