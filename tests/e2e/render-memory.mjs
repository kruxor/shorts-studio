// Reproduces / verifies the 4K render path: measures wall-clock time, peak
// browser RSS, and whether progress actually moves.
//
// Fixtures are gitignored, so generate them first from a short 1080p clip:
//   ffmpeg -i tests/fixtures/shorts-studio-speech-test.mp4 \
//     -vf scale=2160:3840:flags=bicubic -c:v libx264 -preset ultrafast -crf 30 \
//     -c:a copy tests/fixtures/shorts-studio-4k-test.mp4
//   ffmpeg -i tests/fixtures/shorts-studio-speech-test.mp4 -vf fps=24 \
//     -c:v libx264 -preset ultrafast -crf 26 -c:a copy \
//     tests/fixtures/shorts-studio-24fps-test.mp4
//
//   python3 -m http.server 8099 -d public
//   E2E_URL=http://localhost:8099/ node tests/e2e/render-memory.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixture = process.env.E2E_FIXTURE || path.join(root, 'tests/fixtures/shorts-studio-4k-test.mp4');
const appUrl = process.env.E2E_URL || 'http://localhost:8099/';
const exe = process.env.CHROMIUM_EXECUTABLE_PATH || '/home/hermes/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';
const out = { appUrl, fixture: path.basename(fixture), samples: [], labels: [], consoleErrors: [], pageErrors: [] };

const rssMbOfProfile = (marker) => {
  // Sum RSS of every chromium process whose cmdline mentions our unique
  // user-data-dir: browser, renderer, GPU process and utility processes.
  let total = 0;
  let found = 0;
  for (const pid of fs.readdirSync('/proc').filter(entry => /^\d+$/.test(entry))) {
    let cmdline = '';
    try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    if (!cmdline.includes(marker)) continue;
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const rss = status.match(/VmRSS:\s+(\d+) kB/u);
      if (!rss) continue;
      total += Number(rss[1]);
      found += 1;
    } catch { /* process exited between reads */ }
  }
  return found ? Math.round(total / 1024) : null;
};

const profileDir = path.join(root, 'tests/fixtures/.render-memory-profile');
const browser = await chromium.launchPersistentContext(profileDir, {
  executablePath: exe, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
let peakRss = 0;
let timer = null;
try {
  const page = browser.pages()[0] || await browser.newPage();
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
  const stage = (await page.locator('#workflowStatus').innerText()).trim();
  if (stage !== 'Review your captions') throw new Error(`transcription failed: ${stage}`);

  // sample RSS + the visible progress label while the render runs
  timer = setInterval(async () => {
    const rss = rssMbOfProfile(profileDir);
    if (rss && rss > peakRss) peakRss = rss;
    try {
      const label = (await page.locator('#progressLabel').innerText()).trim();
      const pct = (await page.locator('#progressBar').getAttribute('value')) || '0';
      const last = out.labels[out.labels.length - 1];
      if (!last || last.label !== label) out.labels.push({ t: Date.now(), rssMb: rss, label, pct });
      out.samples.push({ rssMb: rss });
    } catch {}
  }, 2000);

  const started = Date.now();
  await page.locator('#renderButton').click();
  await page.waitForFunction(() => {
    const l = document.querySelector('#downloadLink');
    const s = document.querySelector('#workflowStatus')?.textContent || '';
    return (l && !l.hidden) || /failed|Cannot|error/i.test(s);
  }, null, { timeout: Number(process.env.RENDER_TIMEOUT_MS || 900_000), polling: 500 });
  out.renderSeconds = Math.round((Date.now() - started) / 100) / 10;
  clearInterval(timer); timer = null;

  out.status = (await page.locator('#workflowStatus').innerText()).trim();
  out.downloadAvailable = await page.locator('#downloadLink').isVisible();
  out.progressSteps = out.labels.length;
  out.uniqueLabels = out.labels.map(l => l.label).filter((v, i, a) => a.indexOf(v) === i).slice(0, 12);
  out.peakRssMb = peakRss;
  out.rssFirstMb = out.samples[0]?.rssMb ?? null;
  out.rssLastMb = out.samples[out.samples.length - 1]?.rssMb ?? null;
  out.verdict = out.downloadAvailable && out.progressSteps > 2 ? 'PASS' : 'FAIL';
} catch (error) {
  out.error = error.message;
  out.peakRssMb = peakRss;
  out.status = 'FAIL';
} finally {
  if (timer) clearInterval(timer);
  await browser.close();
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = out.verdict === 'PASS' ? 0 : 1;
}
