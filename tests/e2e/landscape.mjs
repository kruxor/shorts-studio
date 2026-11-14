// Landscape gate. Expected RED until landscape support lands: it describes the
// contract, not the current behaviour. Portrait output stays 1080x1920; a 16:9
// source must come out 1920x1080, and the preview must flip to match instead of
// letterboxing the video inside a 9:16 box.
//
//   E2E_URL=http://localhost:8099/ node tests/e2e/landscape.mjs
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixture = path.resolve(process.env.E2E_FIXTURE || path.join(root, 'tests/fixtures/shorts-studio-landscape-test.mp4'));
const appUrl = process.env.E2E_URL || 'http://localhost:8099/';
const chromiumPath = process.env.CHROMIUM_EXECUTABLE_PATH || '/home/hermes/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';

const result = { appUrl, status: 'FAIL', consoleErrors: [] };
let browser;

const probe = file => {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim();
  const [width, height] = out.split(',').map(Number);
  return { width, height };
};

try {
  browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true, viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('console', m => { if (m.type() === 'error') result.consoleErrors.push(m.text()); });
  page.on('pageerror', e => result.consoleErrors.push(e.message));

  await page.goto(appUrl, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', fixture);
  await page.waitForFunction(() => !document.querySelector('#startButton').disabled, null, { timeout: 20_000 });
  await page.click('#startButton');
  await page.waitForFunction(() => !document.querySelector('#workspace').hidden, null, { timeout: 180_000 });

  const geometry = await page.evaluate(() => {
    const stage = document.querySelector('#previewStage') || document.querySelector('.preview-stage');
    const box = stage.getBoundingClientRect();
    const canvas = document.querySelector('#previewCanvas');
    return {
      stageWidth: Math.round(box.width),
      stageHeight: Math.round(box.height),
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      readout: document.querySelector('#dimensionsReadout')?.textContent?.trim() || null,
    };
  });
  result.geometry = geometry;

  const stageRatio = geometry.stageWidth / geometry.stageHeight;
  if (Math.abs(stageRatio - 16 / 9) > 0.03) {
    throw new Error(`preview stage is ${geometry.stageWidth}x${geometry.stageHeight} (ratio ${stageRatio.toFixed(3)}), expected 16:9 for a landscape source. It is still using the fixed 9:16 box.`);
  }

  await page.click('#renderButton');
  await page.waitForSelector('#downloadLink:not([hidden])', { timeout: 300_000 });
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click('#downloadLink')]);
  const savedTo = path.join(root, 'tests/e2e/output', 'landscape-rendered.mp4');
  await download.saveAs(savedTo);

  const observed = probe(savedTo);
  result.rendered = observed;
  if (observed.width !== 1920 || observed.height !== 1080) {
    throw new Error(`rendered video is ${observed.width}x${observed.height}, expected 1920x1080. The output size is still hard-coded to portrait.`);
  }

  if (result.consoleErrors.length) throw new Error(`console errors: ${JSON.stringify(result.consoleErrors)}`);
  result.status = 'PASS';
} catch (error) {
  result.error = error.message;
} finally {
  await browser?.close().catch(() => {});
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
