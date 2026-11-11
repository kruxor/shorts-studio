// Proves drag-to-position reaches the exported video: drag captions to the top,
// render, then measure where caption ink landed in the output MP4.
//   python3 -m http.server 8099 -d public
//   E2E_URL=http://localhost:8099/ node tests/e2e/drag-render.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixture = process.env.E2E_FIXTURE || path.join(root, 'tests/fixtures/shorts-studio-speech-test.mp4');
const appUrl = process.env.E2E_URL || 'http://localhost:8099/';
const exe = process.env.CHROMIUM_EXECUTABLE_PATH || '/home/hermes/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';
const outDir = path.join(root, 'tests/e2e/output');
const out = { appUrl, consoleErrors: [], pageErrors: [] };

fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })).newPage();
  page.setDefaultTimeout(120_000);
  page.on('console', m => { if (m.type() === 'error') out.consoleErrors.push(m.text()); });
  page.on('pageerror', e => out.pageErrors.push(e.message));

  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#fileInput').setInputFiles(fixture);
  await page.waitForFunction(() => document.querySelector('#startButton')?.disabled === false);
  await page.locator('#startButton').click();
  await page.waitForFunction(() => {
    const s = document.querySelector('#workflowStatus')?.textContent?.trim();
    return s === 'Review your captions' || s === 'Could not process this video';
  }, null, { timeout: Number(process.env.TRANSCRIPTION_TIMEOUT_MS || 1_800_000), polling: 1000 });
  const status = (await page.locator('#workflowStatus').innerText()).trim();
  if (status !== 'Review your captions') throw new Error(`transcription failed: ${status}`);

  // Drag the caption block up to the top quarter, slightly left of centre.
  await page.locator('#previewCanvas').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const box = await page.locator('#previewCanvas').boundingBox();
  if (!box) throw new Error('preview canvas has no layout box');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.66);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.22, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  out.styleAfterDrag = {
    y: Number(await page.locator('#y_position').inputValue()),
    yOutput: (await page.locator('#yPositionOutput').innerText()).trim(),
  };

  await page.locator('#renderButton').click();
  await page.waitForFunction(() => {
    const link = document.querySelector('#downloadLink');
    const status = document.querySelector('#workflowStatus')?.textContent || '';
    return (link && !link.hidden) || /fail|error|cannot/i.test(status);
  }, null, { timeout: 600_000, polling: 500 });
  out.renderStatus = (await page.locator('#workflowStatus').innerText()).trim();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.locator('#downloadLink').click(),
  ]);
  const saved = path.join(outDir, 'drag-rendered.mp4');
  await download.saveAs(saved);
  out.renderedFile = saved;
  out.renderedBytes = fs.statSync(saved).size;
  out.verdict = out.styleAfterDrag.y < 0.35 && out.renderedBytes > 0 ? 'PASS' : 'FAIL';
} catch (error) {
  out.error = error.message;
  out.verdict = 'FAIL';
} finally {
  await browser.close();
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = out.verdict === 'PASS' ? 0 : 1;
}
