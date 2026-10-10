import { define } from 'badge';
define();
// Content that only exists when JavaScript runs — gives the no-JS view something to miss.
const section = document.createElement('section');
section.id = 'js-content';
section.innerHTML = `<h2>Rendered by JavaScript</h2>${'<p>This paragraph is added by a script, so it appears only when JavaScript runs. Readers without JavaScript never see it, which is exactly what the resilience view measures.</p>'.repeat(6)}
  <p><a href="/page2.html">Trail guides</a> · <a href="/page2.html#gear">Gear lists</a> · <a href="/page2.html#maps">Maps</a></p>`;
document.querySelector('main')?.append(section);
//# sourceMappingURL=main.js.map
