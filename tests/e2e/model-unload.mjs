// Measures Whisper memory retention: what the tab holds while a transcription
// runs, what it still holds after the model is unloaded, and how much of that
// only a page reload returns. Uses a second, different file for the reload test
// because the start button stays disabled while the review UI is open.
//   python3 -m http.server 8099 -d public
//   E2E_URL=http://localhost:8099/ node tests/e2e/model-unload.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixture = process.env.E2E_FIXTURE || path.join(root, 'tests/fixtures/shorts-studio-speech-test.mp4');
const secondFixture = process.env.E2E_FIXTURE_2 || path.join(root, 'tests/fixtures/shorts-studio-24fps-test.mp4');
const appUrl = process.env.E2E_URL || 'http://localhost:8099/';
const exe = process.env.CHROMIUM_EXECUTABLE_PATH || '/home/hermes/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';
const out = { appUrl, timeline: [], consoleErrors: [], pageErrors: [] };

const rssMb = (marker) => {
  let total = 0;
  let found = 0;
  for (const pid of fs.readdirSync('/proc').filter(entry => /^\d+$/.test(entry))) {
    let cmdline = '';
    try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    if (!cmdline.includes(marker)) continue;
    try {
      const rss = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+) kB/u);
      if (!rss) continue;
      total += Number(rss[1]);
      found += 1;
    } catch { /* exited mid-scan */ }
  }
  return found ? Math.round(total / 1024) : null;
};

const profileDir = path.join(root, 'tests/fixtures/.model-unload-profile');
const context = await chromium.launchPersistentContext(profileDir, {
  executablePath: exe, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
let peak = 0;
let timer = null;
try {
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(120_000);
  page.on('console', m => { if (m.type() === 'error') out.consoleErrors.push(m.text()); });
  page.on('pageerror', e => out.pageErrors.push(e.message));

  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  out.baselineMb = rssMb(profileDir);

  const transcribe = async (file, label) => {
    const started = Date.now();
    await page.locator('#fileInput').setInputFiles(file);
    await page.waitForFunction(() => document.querySelector('#startButton')?.disabled === false);
    await page.locator('#startButton').click();
    await page.waitForFunction(() => {
      const s = document.querySelector('#workflowStatus')?.textContent?.trim();
      return s === 'Review your captions' || s === 'Could not process this video';
    }, null, { timeout: Number(process.env.TRANSCRIPTION_TIMEOUT_MS || 1_800_000), polling: 1000 });
    const status = (await page.locator('#workflowStatus').innerText()).trim();
    out[label] = { status, seconds: Math.round((Date.now() - started) / 100) / 10 };
    return status === 'Review your captions';
  };

  timer = setInterval(() => {
    const rss = rssMb(profileDir);
    if (rss) {
      if (rss > peak) peak = rss;
      out.timeline.push(rss);
    }
  }, 1500);

  if (!await transcribe(fixture, 'firstRun')) throw new Error('first transcription failed');
  await page.waitForTimeout(10000);
  out.afterUnloadMb = rssMb(profileDir);
  // Is the cached pipeline actually gone, or is it still held?
  out.cacheAfterRun = await page.evaluate(async () => {
    const module = await import('/js/transcribe.js');
    const cached = module.transcribeAudio._recognizers?.size ?? null;
    const released = await module.unloadModels();
    return { cachedPipelines: cached, releasedNow: released };
  });

  // Unloading means the next run has to rebuild the model from local files.
  if (!await transcribe(secondFixture, 'secondRun')) throw new Error('second transcription failed after unload');
  await page.waitForTimeout(10000);
  out.afterSecondRunMb = rssMb(profileDir);

  // How much of this is only recoverable by closing the tab?
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  out.afterReloadMb = rssMb(profileDir);

  out.peakMb = peak;
  out.heldAfterUnloadMb = out.afterUnloadMb === null ? null : out.afterUnloadMb - out.baselineMb;
  out.secondRunStartupOverheadMb = out.afterSecondRunMb === null || out.afterUnloadMb === null ? null : out.afterSecondRunMb - out.afterUnloadMb;
  out.verdict = out.firstRun.status === 'Review your captions' && out.secondRun.status === 'Review your captions' ? 'PASS' : 'FAIL';
} catch (error) {
  out.error = error.message;
  out.verdict = 'FAIL';
} finally {
  if (timer) clearInterval(timer);
  await context.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = out.verdict === 'PASS' ? 0 : 1;
}
