// Boot guard for the real vhost. Catches the failure where the app never starts
// because a module script is served with the wrong MIME type - the console only
// says "Expected a JavaScript-or-Wasm module script", which looks like a wasm
// problem and is not one. Run it against whatever nginx config is deployed:
//
//   E2E_URL=https://shorts-studio.local:7443/ node tests/e2e/vhost-boot.mjs
//
// It does not transcribe or render: it only proves the page booted, the script
// modules were served as JavaScript, and a chosen file is accepted.
import { chromium } from 'playwright';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixture = path.resolve(process.env.E2E_FIXTURE || path.join(root, 'tests/fixtures/shorts-studio-speech-test.mp4'));
const appUrl = process.env.E2E_URL || 'https://shorts-studio.local:7443/';
const chromiumPath = process.env.CHROMIUM_EXECUTABLE_PATH || '/home/hermes/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';

const result = { appUrl, scriptMime: [], consoleErrors: [], pageErrors: [], fileSelected: null, status: 'FAIL' };
let browser;

try {
  await Promise.all([access(fixture), access(chromiumPath)]);
  browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  page.on('console', m => { if (m.type() === 'error') result.consoleErrors.push(m.text()); });
  page.on('pageerror', e => result.pageErrors.push(e.message));
  page.on('response', response => {
    const url = new URL(response.url());
    if (!/\.(m?js)$/.test(url.pathname)) return;
    result.scriptMime.push({ path: url.pathname, contentType: response.headers()['content-type'] || '' });
  });

  await page.goto(appUrl, { waitUntil: 'load' });

  const badType = result.scriptMime.filter(s => !/javascript/i.test(s.contentType));
  if (badType.length) throw new Error(`module scripts served with a non-JavaScript MIME type: ${JSON.stringify(badType)}`);

  await page.setInputFiles('#fileInput', fixture);
  await page.waitForFunction(() => !document.querySelector('#startButton').disabled, null, { timeout: 20_000 });

  result.fileSelected = await page.evaluate(() => ({
    summary: document.querySelector('#fileSummary').textContent.trim(),
    startEnabled: !document.querySelector('#startButton').disabled,
    videoReadyState: document.querySelector('#sourceVideo').readyState,
    videoError: document.querySelector('#sourceVideo').error?.code ?? null,
    modelOptions: [...document.querySelectorAll('#modelSelect option')].map(o => o.value),
  }));

  if (result.consoleErrors.length) throw new Error(`console errors: ${JSON.stringify(result.consoleErrors)}`);
  if (result.pageErrors.length) throw new Error(`page errors: ${JSON.stringify(result.pageErrors)}`);
  result.status = 'PASS';
} catch (error) {
  result.error = error.message;
} finally {
  await browser?.close().catch(() => {});
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
