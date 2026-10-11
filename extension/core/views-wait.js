import { mergeViewsPatch } from './harplus.js';

// Waiting for a reading's views patch: from the store (already there), a "views done" message, a capture
// error, or a deadline. Pure: the caller supplies the store read and the message subscription.

const skipped = (reason) => ({ screenshots: [], capture: { viewsSkipped: [{ view: 'all', reason }] }, warnings: [reason] });

/**
 * fromStore(): Promise<patch|null>
 * subscribe(fn): unsubscribe — fn receives { kind: 'views' } or { kind: 'error', text }
 */
export function waitForViews({ fromStore, subscribe, timeoutMs = 5 * 60 * 1000, signal }) {
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe = () => {};
    let timer;
    const finish = (patch, reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      resolve({ patch, reason });
    };
    const onAbort = () => finish(null, 'aborted');
    if (signal?.aborted) return resolve({ patch: null, reason: 'aborted' });
    signal?.addEventListener('abort', onAbort);
    const check = async () => { const p = await fromStore().catch(() => null); if (p) finish(p, 'stored'); };
    unsubscribe = subscribe((m) => {
      if (m?.kind === 'views') check();
      else if (m?.kind === 'error') finish(skipped(`views did not finish: ${m.text || 'capture failed'}`), 'error');
    });
    timer = setTimeout(() => finish(skipped(`views did not finish: timed out after ${Math.round(timeoutMs / 1000)} s`), 'timeout'), timeoutMs);
    check(); // after subscribing, so a broadcast cannot slip between the two
  });
}

/** The analysis threw before the views arrived: merge the stored patch if there is one, else record the views as skipped. */
export async function settleViewsAfterFailure(reading, getPatch) {
  if (!reading?.log?._harplus?.capture?.viewsPending) return reading;
  const patch = await Promise.resolve().then(getPatch).catch(() => null);
  return mergeViewsPatch(reading, patch || { capture: { viewsSkipped: [{ view: 'all', reason: 'analysis failed before the views arrived' }] } });
}

/** Save, and only once the save has landed run the cleanup (deleting the views patch).
 *  Resolves true when the save succeeded, false when it failed (cleanup skipped, so the patch survives for the next open). */
export async function persistAndCleanup(save, cleanup) {
  try {
    await save();
  } catch {
    return false;
  }
  await Promise.resolve().then(cleanup).catch(() => {});
  return true;
}
