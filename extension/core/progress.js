// Progress of a reading — shared by the service worker (badge, tooltip, status), the popup and the
// reading tab's live checklist. Pure.

export const STAGES = {
  loading: { label: 'Reloading the page', badge: 'LOAD' },
  scrolling: { label: 'Scrolling for lazy content', badge: 'SCRL' },
  collecting: { label: 'Reading the page', badge: 'READ' },
  screenshot: { label: 'Screenshots', badge: 'SHOT' },
  bodies: { label: 'Response bodies', badge: 'BODY' },
  sensing: { label: 'In-page checks', badge: 'PAGE' },
  views: { label: 'Extra views', badge: 'VIEW' },
  saving: { label: 'Saving', badge: 'SAVE' },
  analyzing: { label: 'Analysis and lookups', badge: 'LOOK' },
  done: { label: 'Done', badge: '✓' },
  error: { label: 'Failed', badge: '!' },
  recording: { label: 'Recording', badge: 'REC' },
};

export const labelFor = (stage) => STAGES[stage]?.label || String(stage);
export const badgeFor = (stage) => STAGES[stage]?.badge ?? '…';

/** Append a step, closing the open one. 'plugin' events only update the current step's text. */
export function addStep(steps = [], { stage, text = '', at }) {
  const last = steps[steps.length - 1];
  if (stage === 'plugin') return last ? [...steps.slice(0, -1), { ...last, text }] : steps;
  if (last && last.stage === stage && last.text === text) return steps;
  const before = last && last.end == null ? [...steps.slice(0, -1), { ...last, end: at }] : steps;
  const step = { stage, text, start: at };
  if (stage === 'done' || stage === 'error') step.end = at;
  return [...before, step];
}

export const elapsed = (step, now) => Math.max(0, (step.end ?? now) - step.start);

export function formatElapsed(ms) {
  const s = Math.round(Math.max(0, ms) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
