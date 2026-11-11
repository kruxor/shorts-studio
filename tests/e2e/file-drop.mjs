// Proves the drop zone accepts a real File via drag events, which `setInputFiles`
// does not exercise. The fixture is served through a route handler so the page
// can build a genuine File object on its own origin.
//
//   E2E_URL=https://shorts-studio.local:7443/ node tests/e2e/file-drop.mjs
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixture = path.resolve(process.env.E2E_FIXTURE || path.join(root, 'tests/fixtures/shorts-studio-speech-test.mp4'));
const appUrl = process.env.E2E_URL || 'https://shorts-studio.local:7443/';
const chromiumPath = process.env.CHROMIUM_EXECUTABLE_PATH || '/home/hermes/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';

const result = { appUrl, drop: null, consoleErrors: [], pageErrors: [], status: 'FAIL' };
let browser;

try {
  const bytes = await readFile(fixture);
  browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('console', m => { if (m.type() === 'error') result.consoleErrors.push(m.text()); });
  page.on('pageerror', e => result.pageErrors.push(e.message));

  await page.route('**/__fixture.mp4', route => route.fulfill({ status: 200, contentType: 'video/mp4', body: bytes }));
  await page.goto(appUrl, { waitUntil: 'load' });

  result.drop = await page.evaluate(async () => {
    const zone = document.querySelector('#dropZone');
    const response = await fetch('/__fixture.mp4');
    const file = new File([await response.blob()], 'dropped-test.mp4', { type: 'video/mp4' });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    const seen = {};
    for (const type of ['dragenter', 'dragover', 'drop']) {
      zone.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }));
      seen[type] = zone.classList.contains('is-dragging');
    }
    return seen;
  });

  await page.waitForFunction(() => !document.querySelector('#startButton').disabled, null, { timeout: 20_000 });
  result.fileSelected = await page.evaluate(() => ({
    summary: document.querySelector('#fileSummary').textContent.trim(),
    startEnabled: !document.querySelector('#startButton').disabled,
    videoReadyState: document.querySelector('#sourceVideo').readyState,
    draggingClassCleared: !document.querySelector('#dropZone').classList.contains('is-dragging'),
  }));

  if (!/dropped-test\.mp4/.test(result.fileSelected.summary)) throw new Error(`drop did not select the file: ${result.fileSelected.summary}`);
  if (!result.fileSelected.videoReadyState) throw new Error('video element has no metadata after drop');
  if (!result.fileSelected.draggingClassCleared) throw new Error('is-dragging class stuck after drop');
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
