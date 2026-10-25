import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusChanges, nearFocusChange } from '../extension/core/focus.js';

const plain = { outlineStyle: 'none', outlineWidth: '0px', outlineColor: 'rgb(0, 0, 0)', boxShadow: 'none', borderColor: 'rgb(0, 0, 0)', borderWidth: '0px', backgroundColor: 'rgba(0, 0, 0, 0)', textDecorationLine: 'none', color: 'rgb(0, 0, 0)' };
const ringed = { ...plain, outlineStyle: 'solid', outlineWidth: '2px' };

test('focusChanges sees an outline appear', () => {
  assert.deepEqual(focusChanges(plain, ringed), ['outline']);
});

test('nearFocusChange picks the first changed relative', () => {
  const near = [
    { rel: 'parent', before: plain, after: ringed },
    { rel: 'child', before: plain, after: { ...plain, color: 'red' } },
  ];
  assert.deepEqual(nearFocusChange(near), { rel: 'parent', changes: ['outline'] });
  assert.deepEqual(nearFocusChange([near[1], near[0]]), { rel: 'child', changes: ['color'] });
});

test('nearFocusChange is null when nothing changed or nothing was given', () => {
  assert.equal(nearFocusChange([{ rel: 'parent', before: plain, after: plain }, { rel: 'child', before: plain, after: plain }]), null);
  assert.equal(nearFocusChange(undefined), null);
  assert.equal(nearFocusChange([]), null);
});
