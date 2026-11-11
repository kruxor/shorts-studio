// Verifies drag-to-position on the preview canvas: the drag must move the
// caption block, keep the y slider in sync, and actually change drawn pixels.
//   python3 -m http.server 8099 -d public
//   E2E_URL=http://localhost:8099/ node tests/e2e/drag-position.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixture = process.env.E2E_FIXTURE || path.join(root, 'tests/fixtures/shorts-studio-speech-test.mp4');
const appUrl = process.env.E2E_URL || 'http://localhost:8099/';
const exe = process.env.CHROMIUM_EXECUTABLE_PATH || '/home/hermes/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';
const out = { appUrl, consoleErrors: [], pageErrors: [] };

// Count near-white pixels per horizontal third of the caption area. Captions
// are white with a black stroke, so the band containing text lights up.
const bandInk = async (page) => page.evaluate(() => {
  const canvas = document.querySelector('#previewCanvas');
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const bands = [0, 0, 0];
  for (let y = 0; y < height; y += 1) {
    const band = Math.min(2, Math.floor(y / (height / 3)));
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) bands[band] += 1;
    }
  }
  return { width, height, bands };
});

const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  page.setDefaultTimeout(30_000);
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

  // The workspace sits below the fold and the preview only paints a caption once
  // playback reaches the first word, so scroll it into view and force a draw at
  // a time that definitely has a caption before sampling anything.
  await page.locator('#previewCanvas').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const video = document.querySelector('#sourceVideo');
    if (video) video.currentTime = 1.2;
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const slider = document.querySelector('#y_position');
    if (slider) slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(400);

  const before = await bandInk(page);
  const sliderBefore = await page.locator('#y_position').inputValue();

  const box = await page.locator('#previewCanvas').boundingBox();
  if (!box) throw new Error('preview canvas has no layout box');
  const fromX = box.x + box.width / 2;
  const fromY = box.y + box.height * 0.66;
  const toX = box.x + box.width * 0.3;
  const toY = box.y + box.height * 0.25;
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(toX, toY, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const after = await bandInk(page);
  const sliderAfter = await page.locator('#y_position').inputValue();
  const styleY = Number(sliderAfter);

  const inkUp = after.bands[0] - before.bands[0];
  const inkDown = after.bands[2] - before.bands[2];
  out.slider = { before: Number(sliderBefore), after: styleY };
  out.bands = { before: before.bands, after: after.bands };
  out.movedUp = inkUp > 0 && inkUp > inkDown;
  out.verdict = (
    Math.abs(styleY - 0.25) < 0.08
    && (inkUp > 0 || inkDown < 0)
    && !out.pageErrors.length
  ) ? 'PASS' : 'FAIL';
  out.reason = out.verdict === 'PASS'
    ? `slider ${sliderBefore} -> ${sliderAfter}, ink moved to top band (+${inkUp})`
    : `slider ${sliderBefore} -> ${sliderAfter}, inkUp ${inkUp}, inkDown ${inkDown}`;
} catch (error) {
  out.error = error.message;
  out.verdict = 'FAIL';
} finally {
  await browser.close();
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = out.verdict === 'PASS' ? 0 : 1;
}
