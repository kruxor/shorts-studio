// Verifies the two UI changes:
//   1. the preview scales with viewport height instead of a fixed 430px width
//   2. the render panel itself shows progress and a final status
//
//   E2E_URL=http://localhost:8099/ node tests/e2e/render-status.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixture = path.resolve(process.env.E2E_FIXTURE || path.join(root, 'tests/fixtures/shorts-studio-speech-test.mp4'));
const appUrl = process.env.E2E_URL || 'http://localhost:8099/';
const chromiumPath = process.env.CHROMIUM_EXECUTABLE_PATH || '/home/hermes/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';

const result = { appUrl, preview: {}, render: {}, consoleErrors: [], status: 'FAIL' };
let browser;

try {
  browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('console', m => { if (m.type() === 'error') result.consoleErrors.push(m.text()); });
  page.on('pageerror', e => result.consoleErrors.push(e.message));

  await page.goto(appUrl, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', fixture);
  await page.waitForFunction(() => !document.querySelector('#startButton').disabled, null, { timeout: 20_000 });
  await page.click('#startButton');
  await page.waitForFunction(() => !document.querySelector('#workspace').hidden, null, { timeout: 180_000 });

  const measure = async height => {
    await page.setViewportSize({ width: 1400, height });
    // Let layout settle after the viewport change.
    await page.waitForTimeout(250);
    return page.evaluate(() => {
      const stage = document.querySelector('#previewStage').getBoundingClientRect();
      const controls = document.querySelector('.preview-controls').getBoundingClientRect();
      return {
        stageWidth: Math.round(stage.width),
        stageHeight: Math.round(stage.height),
        controlsWidth: Math.round(controls.width),
        viewportHeight: window.innerHeight,
      };
    });
  };

  result.preview.roomy = await measure(1000);
  result.preview.laptop = await measure(800);
  result.preview.tight = await measure(640);

  // Same rule drives all three: height = min(72vh, 620), width = height * 9/16.
  const expected = viewportHeight => Math.min(Math.round(viewportHeight * 0.72), 620);
  for (const [name, m] of Object.entries(result.preview)) {
    m.expectedHeight = expected(m.viewportHeight);
    m.heightOk = Math.abs(m.stageHeight - m.expectedHeight) <= 2;
    m.aspectOk = Math.abs(m.stageWidth / m.stageHeight - 9 / 16) < 0.01;
    m.controlsAligned = Math.abs(m.controlsWidth - m.stageWidth) <= 2;
    if (!m.heightOk || !m.aspectOk || !m.controlsAligned) throw new Error(`preview sizing wrong at ${name}: ${JSON.stringify(m)}`);
  }

  await page.setViewportSize({ width: 1400, height: 900 });

  result.render.hiddenBeforeStart = await page.evaluate(() => document.querySelector('#renderProgress').hidden);
  if (result.render.hiddenBeforeStart !== true) throw new Error('render progress should be hidden before a render starts');

  await page.click('#renderButton');

  // Sample the render panel while the job runs: it must become visible and the
  // bar must actually move, not just exist.
  const samples = [];
  for (let i = 0; i < 40; i += 1) {
    const snap = await page.evaluate(() => ({
      hidden: document.querySelector('#renderProgress').hidden,
      value: Number(document.querySelector('#renderProgressBar').value),
      label: document.querySelector('#renderProgressLabel').textContent.trim(),
      status: document.querySelector('#renderStatus').textContent.trim(),
      downloadVisible: !document.querySelector('#downloadLink').hidden,
    }));
    samples.push(snap);
    if (snap.downloadVisible) break;
    await page.waitForTimeout(1000);
  }

  result.render.samples = samples.length;
  result.render.visibleDuringRun = samples.some(s => s.hidden === false);
  result.render.maxPercent = Math.max(...samples.map(s => s.value));
  result.render.distinctValues = [...new Set(samples.map(s => s.value))].length;
  result.render.progressLabel = samples.filter(s => s.label).at(-1)?.label || '';
  result.render.finalStatus = samples.at(-1).status;
  result.render.downloadVisible = samples.at(-1).downloadVisible;

  if (!result.render.visibleDuringRun) throw new Error('render panel progress never became visible');
  if (result.render.maxPercent < 99) throw new Error(`render progress never reached the end: ${result.render.maxPercent}%`);
  if (result.render.distinctValues < 3) throw new Error(`progress bar barely moved: ${result.render.distinctValues} distinct values`);
  if (!/Render complete/.test(result.render.finalStatus)) throw new Error(`unexpected final status: ${result.render.finalStatus}`);
  if (!result.render.downloadVisible) throw new Error('download link did not appear');
  if (result.consoleErrors.length) throw new Error(`console errors: ${JSON.stringify(result.consoleErrors)}`);

  delete result.render.samples;
  result.status = 'PASS';
} catch (error) {
  result.error = error.message;
} finally {
  await browser?.close().catch(() => {});
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
