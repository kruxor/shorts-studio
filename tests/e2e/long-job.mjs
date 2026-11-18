// Is a long transcription "locked up", or just slow with no progress feedback?
// Transcribes a 5.2-minute clip with small.en on the live host and samples the
// status line, percentage and worker events every 15 s until it finishes.

import { chromium } from 'playwright';

const APP_URL = process.env.E2E_URL || 'https://shorts.kruxor.com/';
const FIXTURE = process.env.E2E_FIXTURE || 'tests/fixtures/shorts-studio-long-landscape.mp4';
const MODEL = process.env.E2E_MODEL || 'small.en';
const DEADLINE_S = Number(process.env.E2E_DEADLINE || 2400);
const SAMPLE_S = Number(process.env.E2E_SAMPLE || 15);

const browser = await chromium.launch({
  headless: true,
  executablePath: '/home/hermes/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
const events = [];
page.on('console', m => events.push(`console.${m.type()}: ${m.text()}`));
page.on('pageerror', e => events.push(`pageerror: ${e.message}`));
page.on('worker', w => { events.push(`worker: ${w.url()}`); w.on('close', () => events.push('worker closed')); });

await page.goto(APP_URL, { waitUntil: 'load' });
await page.locator('#fileInput').setInputFiles(FIXTURE);
if (MODEL === 'small.en' && !(await page.$('#modelSelect option[value="small.en"]'))) {
  await page.click('#modelUnlock');
  await page.waitForSelector('#modelSelect option[value="small.en"]', { state: 'attached' });
}
await page.selectOption('#modelSelect', MODEL);
await page.waitForFunction(() => document.querySelector('#startButton')?.disabled === false);

const started = Date.now();
await page.click('#startButton');

const samples = [];
const seenPercents = new Set();
let outcome = 'timeout';
while ((Date.now() - started) / 1000 < DEADLINE_S) {
  const snap = await page.evaluate(() => ({
    progress: document.querySelector('#renderProgressLabel')?.textContent?.trim()
      || document.querySelector('#progressLabel')?.textContent?.trim() || null,
    percent: document.querySelector('#progressPercent')?.textContent?.trim() || null,
    status: document.querySelector('#workflowStatus')?.textContent?.trim() || null,
    notice: (() => {
      const el = document.querySelector('#errorNotice');
      if (!el || el.hidden || !el.offsetParent) return null;
      const text = el.innerText.trim();
      return text || null;
    })(),
  }));
  const at = Math.round((Date.now() - started) / 100) / 10;
  if (snap.percent) seenPercents.add(snap.percent);
  samples.push({ atSeconds: at, ...snap });
  if (snap.status === 'Review your captions' || snap.status === 'Could not process this video') {
    outcome = snap.status;
    break;
  }
  await new Promise(r => setTimeout(r, SAMPLE_S * 1000));
}

const rows = await page.locator('#captionList .caption-row').count();
const words = rows
  ? (await page.$eval('#transcriptEditor', n => n.value.trim().split(/\s+/u).filter(Boolean).length))
  : 0;
await browser.close();

const wall = Math.round((Date.now() - started) / 100) / 10;
console.log(JSON.stringify({
  appUrl: APP_URL, fixture: FIXTURE, model: MODEL, outcome,
  wallSeconds: wall,
  distinctPercents: [...seenPercents],
  distinctPercentCount: seenPercents.size,
  sampleCount: samples.length,
  samples: samples.filter((s, i) => i % 4 === 0 || i === samples.length - 1),
  captionGroups: rows, words,
  events: events.slice(0, 25),
}, null, 2));
console.log(outcome === 'Review your captions'
  ? `VERDICT: finished in ${wall}s with ${seenPercents.size} distinct percentage value(s) - slow, not hung`
  : `VERDICT: ${outcome} after ${wall}s`);
process.exit(0);
