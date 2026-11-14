// Live diagnostic: watches the status line and every console/worker/network
// failure while a transcription runs, so a stall can be attributed instead of
// guessed at.
//
//   E2E_URL=https://shorts.kruxor.com/ node tests/e2e/diagnose-live.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixture = path.resolve(process.env.E2E_FIXTURE || path.join(root, 'tests/fixtures/shorts-studio-speech-test.mp4'));
const appUrl = process.env.E2E_URL || 'https://shorts.kruxor.com/';
const chromiumPath = process.env.CHROMIUM_EXECUTABLE_PATH || '/home/hermes/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';
const deadlineSeconds = Number(process.env.E2E_DEADLINE || 90);

const log = { appUrl, events: [], samples: [], status: 'FAIL' };
let browser;

try {
  browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  page.on('console', m => log.events.push(`console.${m.type()}: ${m.text()}`));
  page.on('pageerror', e => log.events.push(`pageerror: ${e.message}`));
  page.on('requestfailed', r => log.events.push(`requestfailed: ${r.url()} ${r.failure()?.errorText || ''}`));
  page.on('worker', w => {
    log.events.push(`worker created: ${w.url()}`);
    w.on('close', () => log.events.push('worker closed'));
  });
  page.on('response', r => {
    const url = r.url();
    if (/transcribe|vendor\/ort|vendor\/common|models\//.test(url) && r.status() >= 400) {
      log.events.push(`http ${r.status()}: ${url}`);
    }
  });

  await page.goto(appUrl, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', fixture);
  await page.waitForFunction(() => !document.querySelector('#startButton').disabled, null, { timeout: 20_000 });
  await page.click('#startButton');

  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineSeconds * 1000) {
    const snapshot = await page.evaluate(() => ({
      progress: document.querySelector('#progressLabel')?.textContent?.trim() || null,
      percent: document.querySelector('#progressPercent')?.textContent?.trim() || null,
      workflow: document.querySelector('#workflowStatus')?.textContent?.trim() || null,
      notice: document.querySelector('.notice, #errorNotice, #notice')?.textContent?.trim() || null,
      workspaceVisible: !document.querySelector('#workspace').hidden,
    })).catch(error => ({ evalError: error.message }));
    log.samples.push({ atSeconds: Math.round((Date.now() - startedAt) / 1000), ...snapshot });
    if (snapshot.workspaceVisible) { log.status = 'PASS'; break; }
    if (snapshot.notice) break;
    await page.waitForTimeout(5000);
  }
} catch (error) {
  log.error = error.message;
} finally {
  await browser?.close().catch(() => {});
  console.log(JSON.stringify(log, null, 2));
  process.exitCode = log.status === 'PASS' ? 0 : 1;
}
