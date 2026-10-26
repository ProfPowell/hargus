import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_LEVEL, populationFor, withExtent } from '../extension/core/extent.js';

test('populationFor: picks the population a rule is counted against', () => {
  assert.deepEqual(populationFor('link-name', { links: 819 }), { of: 819, unit: 'links' });
  assert.deepEqual(populationFor('image-alt', { images: 20 }), { of: 20, unit: 'images' });
  assert.deepEqual(populationFor('label', { fields: 12 }), { of: 12, unit: 'form fields' });
  assert.deepEqual(populationFor('label-in-name', { fields: 12, focusables: 90 }), { of: 90, unit: 'focusable elements' });
  assert.deepEqual(populationFor('small-fields', { fields: 12, focusables: 90 }), { of: 12, unit: 'form fields' });
  assert.deepEqual(populationFor('color-contrast', { text: 300 }), { of: 300, unit: 'text elements' });
  assert.deepEqual(populationFor('empty-heading', { headings: 7 }), { of: 7, unit: 'headings' });
  assert.deepEqual(populationFor('button-name', { buttons: 5 }), { of: 5, unit: 'buttons' });
  assert.deepEqual(populationFor('kb-focus-hidden', { images: 5, focusables: 40 }), { of: 40, unit: 'focusable elements' }, 'kb- is never images');
});

test('populationFor: page-level and population-less rules get none', () => {
  assert.ok(PAGE_LEVEL.has('landmark-one-main'));
  assert.equal(populationFor('landmark-one-main', { links: 3, focusables: 9 }), null);
  for (const id of ['possible-heading', 'possible-list', 'layout-table', 'forced-icons']) assert.equal(populationFor(id, { focusables: 9 }), null, id);
});

test('populationFor: falls back to focusables, then to no population', () => {
  assert.deepEqual(populationFor('link-name', { focusables: 50 }), { of: 50, unit: 'focusable elements' });
  assert.deepEqual(populationFor('link-name', { links: 0, focusables: 50 }), { of: 50, unit: 'focusable elements' });
  assert.deepEqual(populationFor('link-name', {}), { of: null, unit: 'links' });
  assert.deepEqual(populationFor('link-name', undefined), { of: null, unit: 'links' });
  assert.deepEqual(populationFor('button-name', { focusables: 50 }), { of: 50, unit: 'focusable elements' });
  assert.deepEqual(populationFor('label', { focusables: 50 }), { of: 50, unit: 'focusable elements' });
});

test('populationFor: text, images and headings never fall back to focusables', () => {
  assert.deepEqual(populationFor('small-fields', { fields: 12, focusables: 90 }), { of: 12, unit: 'form fields' });
  assert.deepEqual(populationFor('color-contrast', { focusables: 50 }), { of: null, unit: 'text elements' });
  assert.deepEqual(populationFor('image-alt', { focusables: 50 }), { of: null, unit: 'images' });
  assert.deepEqual(populationFor('empty-heading', { focusables: 50 }), { of: null, unit: 'headings' });
});

test('withExtent: adds count, of and unit; leaves bad counts alone', () => {
  const f = { id: 'x' };
  assert.deepEqual(withExtent(f, 3, { of: 10, unit: 'links' }), { id: 'x', count: 3, of: 10, unit: 'links' });
  assert.deepEqual(withExtent(f, 3, { of: null, unit: 'links' }), { id: 'x', count: 3, unit: 'links' });
  assert.deepEqual(withExtent(f, 3, null), { id: 'x', count: 3 });
  assert.equal(withExtent(f, '3', { of: 10, unit: 'links' }), f);
  assert.equal(withExtent(f, 0, { of: 10, unit: 'links' }), f);
  assert.equal(withExtent(f, 1.5, null), f);
});
