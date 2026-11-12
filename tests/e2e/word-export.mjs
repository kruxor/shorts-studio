// End-to-end check of the word-timing export: transcribe, click Export, capture
// the download, and validate the JSON against the consumer's schema.
//
//   E2E_URL=http://localhost:8099/ node tests/e2e/word-export.mjs
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixture = path.resolve(process.env.E2E_FIXTURE || path.join(root, 'tests/fixtures/shorts-studio-speech-test.mp4'));
const appUrl = process.env.E2E_URL || 'http://localhost:8099/';
const chromiumPath = process.env.CHROMIUM_EXECUTABLE_PATH || '/home/hermes/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';

const result = { appUrl, status: 'FAIL', consoleErrors: [] };
let browser;

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

  const groupWords = await page.evaluate(() => {
    const groups = [...document.querySelectorAll('#captionList [data-group]')];
    return groups.length;
  });
  result.captionGroups = groupWords;

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.click('#exportWords'),
  ]);

  result.suggestedFileName = download.suggestedFilename();
  const savedTo = path.join(root, 'tests/e2e/output', 'word-timings.json');
  await download.saveAs(savedTo);
  const doc = JSON.parse(await readFile(savedTo, 'utf8'));

  result.document = {
    version: doc.version,
    app: doc.app,
    source_video: doc.source_video,
    language: doc.language,
    language_probability: doc.language_probability,
    wordCount: doc.words?.length,
    firstWord: doc.words?.[0],
    lastWord: doc.words?.at(-1),
  };

  if (doc.version !== 1) throw new Error(`version should be 1, got ${doc.version}`);
  if (doc.app !== 'Video Caption Popover') throw new Error(`unexpected app field: ${doc.app}`);
  if (!Array.isArray(doc.words) || doc.words.length < 10) throw new Error(`too few words: ${doc.words?.length}`);
  if (!/mp4$/.test(doc.source_video)) throw new Error(`source_video should carry the file name: ${doc.source_video}`);

  let previousStart = -1;
  for (const [index, word] of doc.words.entries()) {
    if (typeof word.text !== 'string' || !word.text.trim()) throw new Error(`word ${index} has no text`);
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end)) throw new Error(`word ${index} has non-finite timing`);
    if (word.end < word.start) throw new Error(`word ${index} ends before it starts`);
    if (word.start < previousStart) throw new Error(`word ${index} starts before the previous word`);
    if (word.start < 0) throw new Error(`word ${index} starts before the video`);
    if (word.end > 30) throw new Error(`word ${index} ends past the fixture duration: ${word.end}`);
    if (typeof word.probability !== 'number') throw new Error(`word ${index} has no probability field`);
    previousStart = word.start;
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
