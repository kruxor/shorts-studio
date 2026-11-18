// Cancel a running transcription, then start another one in the same page.
// The second run is the part that usually breaks: if the in-flight guard or the
// worker reference survives a cancel, the retry either hangs forever or reuses a
// terminated worker. Also samples the elapsed label to prove it ticks.

import { chromium } from 'playwright';

const APP_URL = process.env.E2E_URL || 'http://localhost:8099/';
const LONG = process.env.E2E_LONG || 'tests/fixtures/shorts-studio-long-landscape.mp4';
const SHORT = process.env.E2E_SHORT || 'tests/fixtures/shorts-studio-speech-test.mp4';
const CANCEL_AFTER_MS = Number(process.env.E2E_CANCEL_AFTER_MS || 12000);

const browser = await chromium.launch({
  headless: true,
  executablePath: '/home/hermes/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

const read = () => page.evaluate(() => {
  const text = (id) => document.querySelector(id)?.textContent?.trim() || null;
  const visible = (id) => {
    const el = document.querySelector(id);
    return Boolean(el) && !el.hidden && el.offsetParent !== null;
  };
  return {
    status: text('#workflowStatus'),
    label: text('#progressLabel'),
    percent: text('#progressPercent'),
    cancelVisible: visible('#cancelTranscription'),
    expectationVisible: visible('#transcriptionExpectation'),
    expectation: text('#transcriptionExpectation'),
    startEnabled: document.querySelector('#startButton')?.disabled === false,
    errorVisible: visible('#errorNotice'),
    error: visible('#errorNotice') ? text('#errorNotice') : null,
    workspaceVisible: visible('#workspace'),
    captionRows: document.querySelectorAll('#captionList .caption-row').length,
  };
});

await page.goto(APP_URL, { waitUntil: 'load' });
await page.locator('#fileInput').setInputFiles(LONG);
await page.selectOption('#modelSelect', 'base.en');
await page.waitForFunction(() => document.querySelector('#startButton')?.disabled === false);
await page.click('#startButton');

// Wait for the transcription stage to actually begin (cancel button appears).
await page.waitForSelector('#cancelTranscription:not([hidden])', { timeout: 180000 });
const during1 = await read();
await page.waitForTimeout(3000);
const during2 = await read();

await page.waitForTimeout(Math.max(0, CANCEL_AFTER_MS - 3000));
await page.click('#cancelTranscription');
await page.waitForFunction(() => document.querySelector('#workflowStatus')?.textContent?.trim() === 'Transcription cancelled', null, { timeout: 30000 });
const afterCancel = await read();

// Same page, second run. base.en on a 24 s clip finishes in well under a minute.
await page.locator('#fileInput').setInputFiles(SHORT);
await page.waitForFunction(() => document.querySelector('#startButton')?.disabled === false, null, { timeout: 30000 });
await page.click('#startButton');
let secondOutcome = 'timeout';
try {
  await page.waitForFunction(() => {
    const status = document.querySelector('#workflowStatus')?.textContent?.trim();
    return status === 'Review your captions' || status === 'Could not process this video';
  }, null, { timeout: 600000, polling: 1000 });
  secondOutcome = (await read()).status;
} catch { secondOutcome = 'timeout waiting for captions'; }
const afterRetry = await read();

await browser.close();

const ticks = during1.label !== during2.label && /elapsed/.test(during1.label || '');
console.log(JSON.stringify({ appUrl: APP_URL, during1, during2, afterCancel, secondOutcome, afterRetry, errors }, null, 2));

const checks = {
  elapsedLabelTicks: ticks,
  cancelVisibleDuringRun: during1.cancelVisible,
  expectationShownForLongClip: during1.expectationVisible && /tab/i.test(during1.expectation || ''),
  cancelledStatus: afterCancel.status === 'Transcription cancelled',
  noErrorNoticeOnCancel: afterCancel.errorVisible === false,
  startReEnabledAfterCancel: afterCancel.startEnabled,
  cancelHiddenAfterCancel: afterCancel.cancelVisible === false,
  retryReachedCaptions: secondOutcome === 'Review your captions',
  retryHasCaptions: afterRetry.captionRows > 0,
  noConsoleErrors: errors.length === 0,
};
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
console.log(JSON.stringify({ checks, failed }, null, 2));
console.log(failed.length ? `VERDICT: FAIL (${failed.join(', ')})` : 'VERDICT: PASS');
process.exit(0);
