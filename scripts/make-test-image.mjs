// Generates test/e2e/site/img/big.jpg — a 1600×1000 noisy JPEG for the images e2e check.
// Run once with Playwright's Chromium: node scripts/make-test-image.mjs
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* fall back to a global install */ }
  const root = execSync('npm root -g').toString().trim();
  return import(pathToFileURL(join(root, 'playwright', 'index.mjs')).href);
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage();
const dataUrl = await page.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 1600;
  c.height = 1000;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 1600, 1000);
  grad.addColorStop(0, '#2a78d6');
  grad.addColorStop(1, '#1baf7a');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1600, 1000);
  const img = g.getImageData(0, 0, 1600, 1000);
  let s = 7;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 16807) % 2147483647;
    const n = (s % 64) - 32;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/jpeg', 0.9);
});
writeFileSync(fileURLToPath(new URL('../test/e2e/site/img/big.jpg', import.meta.url)), Buffer.from(dataUrl.split(',')[1], 'base64'));
await browser.close();
console.log('wrote test/e2e/site/img/big.jpg');
