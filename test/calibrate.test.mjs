import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pickUrls, SITES, SITES_2, SITES_A11Y } from '../scripts/calibrate.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/calibrate.mjs', import.meta.url));

test('calibrate: --round 1 and --round 2 pick their lists; --all both; given URLs win', () => {
  assert.deepEqual(pickUrls([]), SITES);
  assert.deepEqual(pickUrls(['--round', '1']), SITES);
  assert.deepEqual(pickUrls(['--round', '2']), SITES_2);
  assert.deepEqual(pickUrls(['--all']), [...SITES, ...SITES_2]);
  assert.deepEqual(pickUrls(['--round', '2', 'https://x.test/']), ['https://x.test/']);
  for (const bad of [['--round', '3'], ['--round'], ['--round', 'two'], ['--round', '--all']]) assert.equal(pickUrls(bad), null, bad.join(' '));
});

test('calibrate: an invalid --round prints the usage and exits 2 without starting a browser', () => {
  for (const args of [['--round', '3'], ['--round']]) {
    const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /^Usage: node scripts\/calibrate\.mjs \[--round 1\|2 \| --all \| --a11y\] \[--out dir\] \[--coverage on\|off\] \[--runs 1\|3\|5\] \[--timeout S\] \[url …\]/);
  }
});

test('calibrate: SITES_A11Y is the GDS test page plus thymecare and --a11y selects it', () => {
  assert.deepEqual(SITES_A11Y, ['https://alphagov.github.io/accessibility-tool-audit/test-cases.html', 'https://www.thymecare.com/']);
  assert.deepEqual(pickUrls(['--a11y']), SITES_A11Y);
  assert.deepEqual(pickUrls(['--a11y', 'https://x.test/']), ['https://x.test/']);
});

test('calibrate: parseArgs reads --out and --coverage and skips their values when picking URLs', async () => {
  const { parseArgs } = await import('../scripts/calibrate.mjs');
  const a = parseArgs(['--out', '/tmp/x', 'https://a.test']);
  assert.equal(a.out, '/tmp/x');
  assert.deepEqual(a.urls, ['https://a.test']);
  assert.equal(parseArgs(['--coverage', 'off']).coverage, false);
  assert.equal(parseArgs(['--coverage', 'on']).coverage, true);
  const d = parseArgs([]);
  assert.equal(d.coverage, undefined);
  assert.match(d.out, /test\/e2e\/out\/calibrate$/);
  assert.deepEqual(d.urls, SITES);
  assert.deepEqual(parseArgs(['--coverage', 'off', '--out', '/o']).urls, SITES);
});

test('calibrate: --runs sets runs and the default timeout; the default is 1 run and 300 s', async () => {
  const { parseArgs } = await import('../scripts/calibrate.mjs');
  const r3 = parseArgs(['--runs', '3']);
  assert.equal(r3.runs, 3);
  assert.equal(r3.timeoutSec, 900);
  assert.equal(parseArgs(['--runs', '5']).timeoutSec, 1500);
  const d = parseArgs([]);
  assert.equal(d.runs, 1);
  assert.equal(d.timeoutSec, 300);
  assert.equal(parseArgs(['--runs', '3', '--timeout', '60']).timeoutSec, 60);
  assert.deepEqual(parseArgs(['--runs', '3', 'https://a.test']).urls, ['https://a.test']);
});

test('calibrate: parseArgs throws on a bad --runs, --coverage, --out or --timeout', async () => {
  const { parseArgs } = await import('../scripts/calibrate.mjs');
  assert.throws(() => parseArgs(['--runs', '4']), /--runs must be 1, 3 or 5/);
  assert.throws(() => parseArgs(['--runs']), /--runs must be 1, 3 or 5/);
  assert.throws(() => parseArgs(['--coverage', 'maybe']), /--coverage must be on or off/);
  assert.throws(() => parseArgs(['--out', '--runs']), /--out needs a directory/);
  assert.throws(() => parseArgs(['--out']), /--out needs a directory/);
  assert.throws(() => parseArgs(['--timeout', '0']), /--timeout must be a positive number/);
});

test('calibrate: a bad flag value exits 2 with the message and no browser', () => {
  const r = spawnSync('node', [SCRIPT, '--runs', '4'], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--runs must be 1, 3 or 5/);
});

test('calibrate: withDeadline rejects with "timed out" after ms and passes results through', async () => {
  const { withDeadline } = await import('../scripts/calibrate.mjs');
  await assert.rejects(withDeadline(new Promise(() => {}), 20, 'x'), (e) => e.message === 'timed out' && e.label === 'x');
  assert.equal(await withDeadline(Promise.resolve(7), 1000, 'x'), 7);
  await assert.rejects(withDeadline(Promise.reject(new Error('boom')), 1000, 'x'), /boom/);
});
