#!/usr/bin/env node
// Renders site/og.png (1200×630, the Open Graph share image) from
// scripts/og/template.html, which is written in the site's design system.
// Dev-only: needs a Playwright Chromium on this machine (not a dependency of
// the pipeline). Run after any change to the template; never hand-edit the PNG.
//
//   node scripts/og/render.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('[og] playwright is not installed here; install it (npm i -D playwright && npx playwright install chromium) and rerun.');
  process.exit(1);
}
const out = path.resolve(here, '../../site/og.png');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(`file://${path.join(here, 'template.html')}`);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(500);
await page.screenshot({ path: out, type: 'png' });
await browser.close();
console.log(`[og] wrote ${out}`);
