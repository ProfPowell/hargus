import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardHtml } from '../extension/ui/library-card.js';

const base = { id: 'a1', title: 'Example', host: 'example.com', capturedAt: 0, entries: 3, bytes: 100, mode: 'load' };

test('library card: severity chips carry a glyph and an sr word; ring has its grade word', () => {
  const out = String(cardHtml({ ...base, score: 78, status: 'warning', counts: { high: 6, medium: 2, low: 0 } }));
  assert.match(out, /data-sev="high"[^>]*><span class="sev-ico" aria-hidden="true"><\/span><span class="sr-only">6 high<\/span><\/span>\s*6/);
  assert.match(out, /<span class="sr-only">2 medium<\/span>/);
  assert.doesNotMatch(out, /data-sev="low"/);
  assert.doesNotMatch(out, /sev-high/);
  assert.match(out, /C\+ · needs work/);
});

test('library card: no scores gives no ring, grade word or chips', () => {
  const out = String(cardHtml(base));
  assert.doesNotMatch(out, /card-score|card-grade|class="chips"|data-sev/);
});
