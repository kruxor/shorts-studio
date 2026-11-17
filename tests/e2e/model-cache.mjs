// Does small.en re-download its 242 MB of weights on every visit, or is the
// delay pure inference? Two runs in one browser profile: the first is cold, the
// second reuses the HTTP cache. Model bytes are counted from response headers,
// and the same runs are repeated for base.en as a control.

import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_URL = process.env.E2E_URL || 'http://localhost:8099/';
const FIXTURE = process.env.E2E_FIXTURE || 'tests/fixtures/shorts-studio-speech-test.mp4';
const MODELS = (process.env.E2E_MODELS || 'base.en,small.en').split(',').map((s) => s.trim()).filter(Boolean);

const profileDir = mkdtempSync(join(tmpdir(), 'shorts-cache-'));

async function runOnce(context, model) {
  const page = await context.newPage();
  let modelBytes = 0;
  let modelRequests = 0;
  page.on('response', (response) => {
    const url = response.url();
    if (!url.includes('/models/')) return;
    // The worker HEAD-checks each required model file; a HEAD carries the full
    // content-length while transferring no body, so counting it inflates a warm
    // profile by exactly one model's worth of bytes and looks like a re-download.
    if (response.request().method() !== 'GET') return;
    const length = Number(response.headers()['content-length'] || 0);
    if (length > 0) {
      modelBytes += length;
      modelRequests += 1;
    }
  });

  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

  await page.goto(APP_URL, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', FIXTURE);

  const modelGroup = model === 'small.en' ? 'small' : 'base';
  if (modelGroup === 'small') {
    // The footer dot is the only way in; a fresh profile has just Base English.
    // Wait for the option rather than sleeping after the click: if the page's
    // listeners never attached (a half-written app.js), the click does nothing
    // and selectOption would fail later with a misleading "did not find some options".
    // A warm profile is already unlocked; clicking again would re-lock it.
    if (!(await page.$('#modelSelect option[value="small.en"]'))) await page.click('#modelUnlock');
    // <option> descendants are never "visible" to Playwright, so wait for attachment.
    await page.waitForSelector('#modelSelect option[value="small.en"]', { state: 'attached', timeout: 10000 });
  }
  await page.selectOption('#modelSelect', model);

  const started = Date.now();
  await page.click('#startButton');
  await page.waitForSelector('#captionList .caption-row', { timeout: 600000 });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const words = await page.$eval('#transcriptEditor', (node) => node.value.trim().split(/\s+/u).filter(Boolean).length);

  await page.close();
  return { model, seconds, words, modelBytes, modelRequests, errors };
}

const browser = await chromium.launchPersistentContext(profileDir, {
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const results = [];
try {
  for (const model of MODELS) {
    const cold = await runOnce(browser, model);
    const warm = await runOnce(browser, model);
    results.push({
      model,
      coldSeconds: cold.seconds,
      warmSeconds: warm.seconds,
      coldModelMb: Math.round(cold.modelBytes / 1048576),
      warmModelMb: Math.round(warm.modelBytes / 1048576),
      warmRequests: warm.modelRequests,
      words: warm.words,
      errors: cold.errors.concat(warm.errors),
    });
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ appUrl: APP_URL, fixture: FIXTURE, results }, null, 2));
const reDownloads = results.filter((r) => r.warmModelMb > 0);
console.log(reDownloads.length
  ? `VERDICT: ${reDownloads.map((r) => `${r.model} re-downloads ${r.warmModelMb} MB on a warm profile`).join('; ')}`
  : 'VERDICT: no model bytes on a second visit; the delay is inference, not download');
process.exit(0);
