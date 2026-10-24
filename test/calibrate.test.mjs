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
    assert.match(r.stderr, /^Usage: node scripts\/calibrate\.mjs \[--round 1\|2 \| --all \| --a11y\] \[url …\]/);
  }
});

test('calibrate: SITES_A11Y is the GDS test page plus thymecare and --a11y selects it', () => {
  assert.deepEqual(SITES_A11Y, ['https://alphagov.github.io/accessibility-tool-audit/test-cases.html', 'https://www.thymecare.com/']);
  assert.deepEqual(pickUrls(['--a11y']), SITES_A11Y);
  assert.deepEqual(pickUrls(['--a11y', 'https://x.test/']), ['https://x.test/']);
});
