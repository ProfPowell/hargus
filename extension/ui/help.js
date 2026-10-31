// The Help overlay: static text, rendered once by renderReport so the extension and the export share it.
// Each area's exact scoring table stays in its own "How is this scored?"; this text stays general.

import { AREAS, VERDICT } from '../core/score.js';
import { html } from './html.js';

const AREA_LINE = {
  performance: 'How fast the page loads and how much it transfers.',
  accessibility: 'Whether people using a keyboard, a screen reader or zoom can use the page.',
  security: 'Transport, headers, cookies and what the page tells third parties.',
  content: 'Titles, descriptions, links and what search engines and readers see.',
  build: 'The quality of the HTML, CSS and scripts, and the tools behind them.',
  infrastructure: 'Servers, DNS, certificates and caching.',
  international: 'Language, text direction and how the page copes with other scripts.',
  sustainability: 'The carbon cost of one visit.',
};

export function helpOverlay() {
  return html`<div id="help" popover class="help" role="dialog" aria-labelledby="help-h">
    <header class="help-head">
      <h2 id="help-h">Reading this report</h2>
      <button type="button" class="btn help-close" popovertarget="help" popovertargetaction="hide" autofocus>Close</button>
    </header>
    <section>
      <h3>How to read this report</h3>
      <p>Start at the score, then the area that scored worst, then an issue in that area, then the place on the page or in the network where it happens. The Overview gives the score, Issues lists everything, and each area page shows what was checked.</p>
    </section>
    <section>
      <h3>How scores work</h3>
      <p>Each area is scored from 0 to 100. Its findings take points off, more for severe ones, and where a measured input exists (for example Lighthouse, web vitals or carbon per visit) it is combined with the findings so the weaker of the two counts for more. The overall score is a weighted average of the areas that were measured. If an area the scoring profile treats as critical is below 60, the overall score is capped at D.</p>
      <p>Grades run from A down to F. Scores of 85 or more are ${VERDICT.good}, 70 and up ${VERDICT.warning}, 50 and up ${VERDICT.serious}, and lower is ${VERDICT.critical}. An area with nothing measured shows ${VERDICT.none}. Each area page has "How is this scored?" with its exact table.</p>
    </section>
    <section>
      <h3>Severities</h3>
      <ul>
        <li><b>High:</b> likely to break the page for some people or expose them to harm. Fix first.</li>
        <li><b>Medium:</b> a real problem that does not stop use.</li>
        <li><b>Low:</b> a small gap or a missed improvement.</li>
        <li><b>Info:</b> worth knowing and not scored.</li>
      </ul>
    </section>
    <section>
      <h3>The eight areas</h3>
      <ul>${AREAS.map((a) => html`<li><b>${a.label}:</b> ${AREA_LINE[a.id]}</li>`)}</ul>
    </section>
    <section>
      <h3>Not used during load</h3>
      <p>Code not used during load (scripts that never ran, CSS rules matching nothing) may still serve menus, forms and later pages, but large amounts cost every visit. Measuring it adds work during load, so its timings don't compare with readings taken without it: leave it off when comparing speed. Where Chrome blocks JavaScript coverage, only CSS is measured; the panel says so. Off by default; enable it in Options.</p>
    </section>
    <section>
      <h3>Runs</h3>
      <p>Timings change from one load to the next. With 3 or 5 runs, HARgus reloads the page that many times and reports the median, with the range from fastest to slowest. "Varies" means the runs disagree enough that a single reading could mislead. Only timings are repeated; the element details, checks and views come from the full reading. Each extra run adds a few seconds.</p>
    </section>
    <section>
      <h3>Reading health</h3>
      <p>A view is one extra capture of the page, such as a phone width, no CSS, or a dark scheme. A view is skipped when it times out, the browser cannot produce it, or the page changes while it is captured. A partial reading still has its scores, but with views or checks missing some areas may look better than they are.</p>
    </section>
  </div>`;
}
