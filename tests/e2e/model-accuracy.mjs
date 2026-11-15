// Does small.en actually transcribe better than base.en? Runs the same fixture
// through both models and prints the transcripts side by side, with timings, so
// the answer is evidence rather than "smaller models score better on benchmarks".
//
// The small.en run needs the weights (FETCH_SMALL=1 ./scripts/fetch-models.sh)
// and the model option, which is behind the discreet unlock control.
//
//   E2E_URL=http://localhost:8099/ node tests/e2e/model-accuracy.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixture = path.resolve(process.env.E2E_FIXTURE || path.join(root, 'tests/fixtures/shorts-studio-speech-test.mp4'));
const appUrl = process.env.E2E_URL || 'http://localhost:8099/';
const chromiumPath = process.env.CHROMIUM_EXECUTABLE_PATH || '/home/hermes/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';

async function transcribeWith(browser, model, { unlock }) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(appUrl, { waitUntil: 'load' });

  if (unlock) {
    const unlocked = await page.evaluate(() => {
      const trigger = document.querySelector('#modelUnlock');
      if (trigger) { trigger.click(); return true; }
      localStorage.setItem('shorts-studio:unlock-small', '1');
      return false;
    });
    if (!unlocked) { await page.reload({ waitUntil: 'load' }); }
  }

  const options = await page.$$eval('#modelSelect option', nodes => nodes.map(n => n.value));
  if (!options.includes(model)) throw new Error(`model ${model} is not selectable; options were ${JSON.stringify(options)}`);
  await page.selectOption('#modelSelect', model);

  await page.setInputFiles('#fileInput', fixture);
  await page.waitForFunction(() => !document.querySelector('#startButton').disabled, null, { timeout: 20_000 });

  const startedAt = Date.now();
  await page.click('#startButton');
  await page.waitForFunction(() => !document.querySelector('#workspace').hidden, null, { timeout: 420_000 });
  const seconds = (Date.now() - startedAt) / 1000;

  // The caption rows carry timestamps and per-row buttons alongside the words, so
  // reading row textContent compares UI chrome, not speech. The transcript editor
  // holds exactly the transcribed text.
  const text = await page.$eval('#transcriptEditor', node => node.value.trim());
  const rows = await page.$$eval('#captionList .caption-row', nodes => nodes.length);
  const notice = await page.$eval('.notice, #errorNotice', n => n.textContent.trim()).catch(() => null);
  await context.close();
  return { model, seconds: Math.round(seconds * 10) / 10, rowCount: rows, rowText: undefined, text, notice, errors };
}

const norm = text => text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);

let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const base = await transcribeWith(browser, 'base.en', { unlock: false });
  const small = await transcribeWith(browser, 'small.en', { unlock: true });

  const baseWords = norm(base.text);
  const smallWords = norm(small.text);
  const differences = [];
  for (let i = 0; i < Math.max(baseWords.length, smallWords.length); i += 1) {
    if (baseWords[i] !== smallWords[i]) differences.push({ position: i, base: baseWords[i] ?? null, small: smallWords[i] ?? null });
  }

  console.log(JSON.stringify({
    appUrl,
    transcriptions: [base, small],
    comparison: {
      baseWords: baseWords.length,
      smallWords: smallWords.length,
      differingPositions: differences.length,
      differences: differences.slice(0, 40),
      baseSeconds: base.seconds,
      smallSeconds: small.seconds,
      slowdown: Math.round((small.seconds / base.seconds) * 10) / 10,
    },
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ appUrl, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
