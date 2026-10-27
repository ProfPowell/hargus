import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeFindings } from '../extension/core/supersede.js';

const network = () => ({ id: 'network', findings: [{ id: 'asset-errors', title: 'a' }, { id: 'request-errors', title: 'r' }] });
const ids = (fs) => fs.map((f) => f.id);

test('activeFindings drops a superseded finding when the superseding plugin is ok', () => {
  const n = network();
  const results = { network: n, links: { id: 'links', status: 'ok', supersedes: ['network:asset-errors'] } };
  assert.deepEqual(ids(activeFindings(n, results)), ['request-errors']);
});

test('keeps it when the superseding plugin is skipped, errored or absent', () => {
  const n = network();
  for (const status of ['skipped', 'error']) {
    const results = { network: n, links: { id: 'links', status, supersedes: ['network:asset-errors'] } };
    assert.deepEqual(ids(activeFindings(n, results)), ['asset-errors', 'request-errors']);
  }
  assert.deepEqual(ids(activeFindings(n, { network: n })), ['asset-errors', 'request-errors']);
});

test('findings without an id are never dropped', () => {
  const n = { id: 'network', findings: [{ title: 'no id' }] };
  const results = { network: n, links: { id: 'links', status: 'ok', supersedes: ['network:undefined', 'network:'] } };
  assert.equal(activeFindings(n, results).length, 1);
});
