// Measures whether the page stays responsive while Whisper transcribes.
//
// The reason transcription moved into a worker: ONNX Runtime's WASM loop used to
// block the main thread in multi-second blocks, which is what makes Chromium
// show "Page unresponsive". A pass here means timers and animation frames keep
// firing during inference, not merely that the text appeared afterwards.
//
//   E2E_URL=http://localhost:8099/ node tests/e2e/main-thread.mjs
//
// Set E2E_LABEL=baseline to name a run in the output when comparing versions.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixture = path.resolve(process.env.E2E_FIXTURE || path.join(root, 'tests/fixtures/shorts-studio-speech-test.mp4'));
const appUrl = process.env.E2E_URL || 'http://localhost:8099/';
const chromiumPath = process.env.CHROMIUM_EXECUTABLE_PATH || '/home/hermes/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';
const MAX_GAP_MS = Number(process.env.E2E_MAX_GAP_MS || 250);

const result = { label: process.env.E2E_LABEL || 'current', appUrl, status: 'FAIL', consoleErrors: [] };
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

  // Instrument the main thread before the work starts: interval ticks for
  // scheduling, rAF for paint, PerformanceObserver for Chrome's long tasks.
  await page.evaluate(() => {
    window.__probe = { ticks: [], frames: [], longTasks: [], started: performance.now() };
    window.__probe.interval = setInterval(() => window.__probe.ticks.push(performance.now()), 50);
    const frame = () => {
      window.__probe.frames.push(performance.now());
      window.__probe.raf = requestAnimationFrame(frame);
    };
    window.__probe.raf = requestAnimationFrame(frame);
    try {
      window.__probe.observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) window.__probe.longTasks.push(Math.round(entry.duration));
      });
      window.__probe.observer.observe({ entryTypes: ['longtask'] });
    } catch { /* longtask unsupported: the tick gaps still tell the story */ }
  });

  const startedAt = Date.now();
  await page.click('#startButton');
  await page.waitForFunction(() => !document.querySelector('#workspace').hidden, null, { timeout: 180_000 });
  const wallSeconds = (Date.now() - startedAt) / 1000;

  const measured = await page.evaluate(() => {
    const probe = window.__probe;
    clearInterval(probe.interval);
    cancelAnimationFrame(probe.raf);
    probe.observer?.disconnect();
    const gap = (stamps) => {
      let max = 0;
      for (let i = 1; i < stamps.length; i += 1) max = Math.max(max, stamps[i] - stamps[i - 1]);
      return Math.round(max);
    };
    return {
      tickCount: probe.ticks.length,
      maxTickGapMs: gap(probe.ticks),
      frameCount: probe.frames.length,
      maxFrameGapMs: gap(probe.frames),
      longTaskCount: probe.longTasks.length,
      longestTaskMs: probe.longTasks.length ? Math.max(...probe.longTasks) : 0,
      words: document.querySelectorAll('#captionList .caption-row').length,
    };
  });

  result.measurement = { ...measured, wallSeconds: Math.round(wallSeconds * 10) / 10, maxAllowedGapMs: MAX_GAP_MS };

  if (measured.words < 1) throw new Error('transcription produced no caption rows, so the timing means nothing');
  if (measured.maxTickGapMs > MAX_GAP_MS) {
    throw new Error(`main thread was blocked for ${measured.maxTickGapMs}ms (limit ${MAX_GAP_MS}ms, ${measured.longTaskCount} long tasks). The work is still on the main thread.`);
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
