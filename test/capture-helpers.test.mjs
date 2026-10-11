import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freezeMedia } from '../extension/browser/capture.js';

test('freezeMedia pauses what plays and resumes exactly that', () => {
  const mk = (paused) => ({ paused, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } });
  const a = mk(false), b = mk(true);
  const anim = { playState: 'running', pause() { this.playState = 'paused'; }, play() { this.playState = 'running'; } };
  globalThis.window = globalThis;
  globalThis.document = { querySelectorAll: (s) => (s === 'video, audio' ? [a, b] : []), getAnimations: () => [anim] };
  freezeMedia(true);
  assert.equal(a.paused, true); assert.equal(b.paused, true); assert.equal(anim.playState, 'paused');
  freezeMedia(false);
  assert.equal(a.paused, false, 'was playing → resumed');
  assert.equal(b.paused, true, 'was paused → stays paused');
  assert.equal(anim.playState, 'running');
  delete globalThis.document;
});
