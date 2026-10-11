// Waiting for a reading's views patch: from the store (already there), a "views done" message, a capture
// error, or a deadline. Pure: the caller supplies the store read and the message subscription.

const skipped = (reason) => ({ screenshots: [], capture: { viewsSkipped: [{ view: 'all', reason }] }, warnings: [reason] });

/**
 * fromStore(): Promise<patch|null>
 * subscribe(fn): unsubscribe — fn receives { kind: 'views' } or { kind: 'error', text }
 */
export function waitForViews({ fromStore, subscribe, timeoutMs = 5 * 60 * 1000 }) {
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe = () => {};
    let timer;
    const finish = (patch, reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve({ patch, reason });
    };
    const check = async () => { const p = await fromStore().catch(() => null); if (p) finish(p, 'stored'); };
    unsubscribe = subscribe((m) => {
      if (m?.kind === 'views') check();
      else if (m?.kind === 'error') finish(skipped(`views did not finish: ${m.text || 'capture failed'}`), 'error');
    });
    timer = setTimeout(() => finish(skipped(`views did not finish: timed out after ${Math.round(timeoutMs / 1000)} s`), 'timeout'), timeoutMs);
    check(); // after subscribing, so a broadcast cannot slip between the two
  });
}
