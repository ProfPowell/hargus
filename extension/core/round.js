// Round runner: records a set's URLs one at a time in one working tab. Every browser call is an injected dep.
import { startRound, updateSite, endRound } from './sets.js';

/** Per-site deadline for capture and analysis together, per timing run. */
export const SITE_DEADLINE_MS = 300_000;

/** The deadline for one site: 300 s × runs (1 run by default). */
export const deadlineFor = (settings = {}) => SITE_DEADLINE_MS * Math.max(1, Number(settings.runs) || 1);

const TIMED_OUT = Symbol('timed out');

/**
 * Record every URL of `set` in a new round and return the set as last saved.
 * deps: { save, openTab, closeTab?, navigate, capture, analysisDone, abandon?, busy?, deadlineMs?, stopped, gone?, now,
 *         workingTab? }. `analysisDone` resolves 'done' | 'error' | 'timeout' | 'stopped' (the round was cut off).
 * `gone` resolves true once the set has been deleted: the round stops and never saves it back.
 */
export async function runRound(set, deps) {
  const deadlineMs = deps.deadlineMs ?? deadlineFor;
  let current = startRound(set, deps.now());
  const ri = current.rounds.length - 1;
  let removed = false;
  const commit = async (next) => {
    current = next;
    if (removed || (deps.gone && await deps.gone())) { removed = true; return; }
    await deps.save(current);
  };
  await commit(current);

  let tabId = deps.workingTab ?? await deps.openTab('about:blank');
  const settings = { ...set.settings, mode: 'reload' };

  for (const url of set.urls) {
    if (removed || deps.stopped()) break;
    const limit = deadlineMs(set.settings);
    const startedAt = deps.now();
    let open = true; // false once the deadline passed: a late finish must not write over the failure
    const step = (patch) => (open ? commit(updateSite(current, ri, url, patch)) : undefined);

    const attempt = (async () => {
      await step({ state: 'recording', id: null, error: null });
      await deps.navigate(tabId, url);
      if (!open) return null; // the deadline passed while loading: don't start a capture the round has left behind
      const id = await deps.capture(tabId, settings);
      if (!open) return null;
      if (id == null) throw new Error('no reading was saved');
      const remaining = Math.max(0, limit - (deps.now() - startedAt));
      const analysed = Promise.resolve(deps.analysisDone(id, remaining)); // listen before the save: a quick finish isn't missed
      analysed.catch(() => {}); // a rejection is handled when awaited below
      await step({ state: 'analysing', id });
      const result = await analysed;
      if (result === 'stopped') return { error: 'stopped' };
      return result === 'timeout' ? TIMED_OUT : { id };
    })();

    let outcome;
    let timer;
    try {
      outcome = await Promise.race([attempt, new Promise((r) => { timer = setTimeout(() => r(TIMED_OUT), limit); })]);
    } catch (e) {
      outcome = { error: deps.stopped() ? 'stopped' : e?.message || String(e) };
    }
    clearTimeout(timer);
    open = false;
    attempt.catch(() => {}); // an abandoned attempt may still reject later

    if (outcome === TIMED_OUT) {
      await commit(updateSite(current, ri, url, { state: 'failed', error: 'timed out' }));
      await deps.abandon?.(tabId);
      if (deps.busy?.(tabId)) {
        // The abandoned capture still holds the tab: carry on in a fresh one.
        const old = tabId;
        tabId = await deps.openTab('about:blank');
        await deps.closeTab?.(old);
      }
    } else if (outcome.error) {
      await commit(updateSite(current, ri, url, { state: 'failed', error: outcome.error }));
    } else {
      await commit(updateSite(current, ri, url, { state: 'done', id: outcome.id, error: null }));
    }
  }

  await commit(endRound(current, ri, deps.stopped() ? 'stopped' : 'done'));
  return current;
}
