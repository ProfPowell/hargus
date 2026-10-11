import { mergeViewsPatch } from './harplus.js';

// Waiting for a reading's views patch: from the store (already there), a "views done" message, a capture
// error, a liveness probe saying the capture is gone, or a deadline. Pure: the caller supplies the store read,
// the message subscription and the probe.

const skipped = (reason) => ({ screenshots: [], capture: { viewsSkipped: [{ view: 'all', reason }] }, warnings: [reason] });

/**
 * fromStore(): Promise<patch|null>
 * subscribe(fn): unsubscribe — fn receives { kind: 'views' } or { kind: 'error', text }
 * isAlive(): Promise<boolean> — optional; asked every pollMs while no patch is stored. false → give up at once
 *   (after one last store read); true → the deadline moves timeoutMs forward; throws → no news, keep waiting.
 * timeoutMs: how long to wait without proof of life. hardMs: the cap regardless of liveness.
 */
export function waitForViews({ fromStore, subscribe, timeoutMs = 5 * 60 * 1000, signal, isAlive, pollMs = 5000, hardMs = 15 * 60 * 1000 }) {
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe = () => {};
    let timer;
    let hardTimer;
    let pollTimer;
    const finish = (patch, reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      clearTimeout(pollTimer);
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      resolve({ patch, reason });
    };
    const onAbort = () => finish(null, 'aborted');
    if (signal?.aborted) return resolve({ patch: null, reason: 'aborted' });
    signal?.addEventListener('abort', onAbort);
    const check = async () => { const p = await fromStore().catch(() => null); if (p) finish(p, 'stored'); return p; };
    const armDeadline = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(skipped(`views did not finish: timed out after ${Math.round(timeoutMs / 1000)} s`), 'timeout'), timeoutMs);
    };
    const poll = async () => {
      if (done || await check() || done) return;
      let alive;
      try { alive = await isAlive(); } catch { alive = null; } // no answer is not proof of death
      if (done) return;
      if (alive === false) {
        if (!await check()) finish(skipped('views did not finish: capture is no longer running'), 'gone');
        return;
      }
      if (alive === true) armDeadline();
      pollTimer = setTimeout(poll, pollMs);
    };
    unsubscribe = subscribe((m) => {
      if (m?.kind === 'views') check();
      else if (m?.kind === 'error') finish(skipped(`views did not finish: ${m.text || 'capture failed'}`), 'error');
    });
    armDeadline();
    if (isAlive) {
      hardTimer = setTimeout(() => finish(skipped(`views did not finish: gave up after ${Math.round(hardMs / 1000)} s`), 'timeout'), hardMs);
      pollTimer = setTimeout(poll, pollMs);
    }
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
