// The live checklist a reading tab shows while the reading is captured and analysed. Pure markup.

import { html } from './html.js';
import { icon } from './charts.js';
import { labelFor, elapsed, formatElapsed } from '../core/progress.js';

function row(state, label, text, ms) {
  const mark = state === 'running'
    ? html`<span class="status-dot status-running" aria-hidden="true"></span>`
    : icon(state === 'error' ? 'fail' : state === 'skipped' ? 'info' : 'ok', { size: 14, title: state });
  return html`<li class="prog-row prog-${state}">${mark}<span class="prog-label">${label}</span><span class="prog-text">${text || ''}</span><span class="prog-time">${formatElapsed(ms)}</span></li>`;
}

export function renderProgress({ host = '', steps = [], plugins = [], startedAt, now = Date.now(), error = '', retry = false, note = '' } = {}) {
  const t0 = startedAt ?? steps[0]?.start ?? now;
  const capture = steps.filter((s) => s.stage !== 'done');
  return html`<section class="card progress" aria-live="polite">
    <h1>Reading ${host || 'page'} <small>· ${formatElapsed(now - t0)}</small></h1>
    ${error ? html`<p class="error">${error}</p>${retry ? html`<p><button class="btn primary" type="button" id="retry">Try again</button></p>` : ''}` : ''}
    ${capture.length ? html`<h2>Capture</h2><ol class="prog-list">${capture.map((s) => row(
      s.stage === 'error' ? 'error' : s.end == null ? 'running' : 'ok', labelFor(s.stage), s.text, elapsed(s, now),
    ))}</ol>` : ''}
    ${plugins.length ? html`<h2>Analysis and lookups</h2><ol class="prog-list">${plugins.map((p) => row(
      p.status, p.name, p.status === 'error' || p.status === 'skipped' ? p.error || p.status : '', (p.end ?? now) - p.start,
    ))}</ol>` : ''}
    <p class="note">${note || 'You can switch tabs — this page finishes the lookups and turns into the report.'}</p>
  </section>`;
}
