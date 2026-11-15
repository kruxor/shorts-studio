import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const appUrl = process.env.E2E_URL || 'http://localhost:8099/';
const chromiumPath = process.env.CHROMIUM_EXECUTABLE_PATH || '/home/hermes/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';
const STORAGE_KEY = 'shorts-studio:unlock-small';
const result = { appUrl, status: 'FAIL', steps: [], consoleErrors: [], smallModelRequests: [] };
let browser;

try {
  browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', message => { if (message.type() === 'error') result.consoleErrors.push(message.text()); });
  page.on('pageerror', error => result.consoleErrors.push(error.message));
  page.on('request', request => {
    if (request.url().includes('/models/whisper-small.en/')) result.smallModelRequests.push(request.url());
  });

  await page.goto(appUrl, { waitUntil: 'load' });
  const initial = await page.locator('#modelSelect option').evaluateAll(options => options.map(option => ({ value: option.value, label: option.textContent.trim() })));
  assert.equal(initial.length, 1, 'fresh profile must have exactly one model option');
  assert.equal(await page.locator('#modelSelect option[value="small.en"]').count(), 0, 'small.en must not exist in the default DOM');
  assert.equal(initial[0].label, 'Base English', 'the default visible model must stay Base English');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY), null, 'fresh profile must not already be unlocked');
  assert.equal(result.smallModelRequests.length, 0, 'page load must not request small.en weights');
  result.steps.push('fresh profile has only Base English; small.en option absent; no small.en requests');

  const unlock = page.locator('#modelUnlock');
  assert.equal(await unlock.count(), 1, '#modelUnlock must exist');
  assert.equal(await unlock.getAttribute('type'), 'button');
  assert.ok(await unlock.getAttribute('aria-label'), 'unlock target must have an accessible name');
  await unlock.click();
  const unlocked = await page.locator('#modelSelect option').evaluateAll(options => options.map(option => ({ value: option.value, label: option.textContent.trim() })));
  assert.equal(unlocked.length, 2, 'clicking unlock must add exactly one option');
  assert.equal(await page.locator('#modelSelect option[value="small.en"]').count(), 1);
  assert.match(unlocked.find(option => option.value === 'small.en').label, /Small English.*more accurate.*242 MB.*first use/i);
  assert.equal(await page.locator('#modelSelect').inputValue(), 'base.en', 'unlocking must leave Base English selected');
  result.steps.push('unlock click adds the Small English option without changing the selection');

  assert.equal(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY), '1', 'unlock must persist its single localStorage key');
  assert.equal(result.smallModelRequests.length, 0, 'unlock must not request small.en weights');
  await page.locator('#modelSelect').selectOption('small.en');
  assert.equal(result.smallModelRequests.length, 0, 'selecting small.en without starting transcription must not request weights');
  await page.locator('#modelSelect').selectOption('base.en');
  result.steps.push('unlock persisted; selecting small.en still requests no weights until transcription starts');

  await page.reload({ waitUntil: 'load' });
  assert.equal(await page.locator('#modelSelect option').count(), 2, 'unlock must survive reload');
  assert.equal(await page.locator('#modelSelect option[value="small.en"]').count(), 1);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY), '1');
  assert.equal(result.smallModelRequests.length, 0, 'reload must not request small.en weights');
  result.steps.push('unlock survives reload without loading small.en weights');

  await page.locator('#modelUnlock').click();
  assert.equal(await page.locator('#modelSelect option').count(), 1, 'second click must remove small.en');
  assert.equal(await page.locator('#modelSelect option[value="small.en"]').count(), 0);
  assert.equal(await page.locator('#modelSelect').inputValue(), 'base.en', 'locking must reset the selection to Base English');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY), null, 'locking must clear the localStorage key');
  assert.equal(result.smallModelRequests.length, 0, 'locking must not request small.en weights');
  result.steps.push('second click locks, removes the option, resets Base English, and clears storage');

  assert.deepEqual(result.consoleErrors, [], 'there must be zero console errors throughout the probe');
  result.status = 'PASS';
} catch (error) {
  result.error = error.message;
} finally {
  await browser?.close().catch(() => {});
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
