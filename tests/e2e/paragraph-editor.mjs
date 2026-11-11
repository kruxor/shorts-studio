// Focused E2E check for the whole-transcript (paragraph) editor.
// Requires the app to be served on a secure context, e.g.
//   python3 -m http.server 8099 -d public
//   E2E_URL=http://localhost:8099/ node tests/e2e/paragraph-editor.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixture = process.env.E2E_FIXTURE || path.join(root, 'tests/fixtures/shorts-studio-speech-test.mp4');
const appUrl = process.env.E2E_URL || 'http://localhost:8099/';
const exe = process.env.CHROMIUM_EXECUTABLE_PATH || '/home/hermes/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';
const result = { appUrl, steps: {}, consoleErrors: [], pageErrors: [] };

const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  page.setDefaultTimeout(30_000);
  page.on('console', m => { if (m.type() === 'error') result.consoleErrors.push(m.text()); });
  page.on('pageerror', e => result.pageErrors.push(e.message));

  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#fileInput').setInputFiles(fixture);
  await page.waitForFunction(() => document.querySelector('#startButton')?.disabled === false);
  await page.locator('#startButton').click();
  await page.waitForFunction(() => {
    const s = document.querySelector('#workflowStatus')?.textContent?.trim();
    return s === 'Review your captions' || s === 'Could not process this video';
  }, null, { timeout: Number(process.env.TRANSCRIPTION_TIMEOUT_MS || 1_200_000), polling: 1000 });

  const status = (await page.locator('#workflowStatus').innerText()).trim();
  if (status !== 'Review your captions') {
    result.steps.transcription = { ok: false, status };
    throw new Error(`Transcription did not reach review: ${status}`);
  }

  // 1. Prefilled from the transcript?
  const prefilled = await page.locator('#transcriptEditor').inputValue();
  const groupsBefore = await page.locator('#captionList .caption-row').count();
  result.steps.prefill = {
    ok: prefilled.trim().split(/\s+/).length > 5,
    words: prefilled.trim().split(/\s+/).filter(Boolean).length,
    captionGroups: groupsBefore,
    preview: prefilled.slice(0, 90),
  };

  // 2. Edit as one paragraph (the whole point: correct words without per-word UI).
  const edited = prefilled.replace(/\bback\b/iu, 'back again');
  await page.locator('#transcriptEditor').fill(edited);
  const dirtyStatus = (await page.locator('#transcriptEditStatus').innerText()).trim();
  await page.locator('#applyTranscriptText').click();
  await page.waitForFunction(() => /changed|up to date|Could not apply/u.test(document.querySelector('#transcriptEditStatus')?.textContent || ''), null, { timeout: 60_000 });
  const afterStatus = (await page.locator('#transcriptEditStatus').innerText()).trim();
  const afterValue = await page.locator('#transcriptEditor').inputValue();
  const groupsAfter = await page.locator('#captionList .caption-row').count();
  result.steps.apply = {
    ok: edited.trim() !== prefilled.trim() && afterStatus !== dirtyStatus && afterValue.includes('back again'),
    status: afterStatus,
    groupsBefore,
    groupsAfter,
    keptInsertedWord: afterValue.includes('back again'),
  };

  // 3. Invalid edit must show an inline error and keep the typed text.
  // A single 130-character token is genuinely invalid (>120 chars/word) while
  // still being text the user would not want to lose.
  const invalidText = 'x'.repeat(130);
  await page.locator('#transcriptEditor').fill(invalidText);
  await page.locator('#applyTranscriptText').click();
  const errorVisible = await page.locator('#transcriptEditError').isVisible();
  const errorText = errorVisible ? (await page.locator('#transcriptEditError').innerText()).trim() : null;
  result.steps.invalidEdit = {
    ok: errorVisible && errorText.length > 0 && (await page.locator('#transcriptEditor').inputValue()) === invalidText,
    error: errorText,
    textKept: (await page.locator('#transcriptEditor').inputValue()) === invalidText,
    captionGroupsStillRendered: await page.locator('#captionList .caption-row').count() === groupsAfter,
  };

  // 4. Revert restores the timed transcript.
  await page.locator('#revertTranscriptText').click();
  const reverted = await page.locator('#transcriptEditor').inputValue();
  result.steps.revert = {
    ok: reverted.includes('back again') && !(await page.locator('#transcriptEditError').isVisible()),
    status: (await page.locator('#transcriptEditStatus').innerText()).trim(),
  };

  result.status = Object.values(result.steps).every(step => step.ok) && !result.pageErrors.length ? 'PASS' : 'FAIL';
} catch (error) {
  result.error = error.message;
  result.status = result.status || 'FAIL';
} finally {
  await browser.close();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
