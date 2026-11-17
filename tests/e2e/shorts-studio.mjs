import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdir, access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixture = path.resolve(process.env.E2E_FIXTURE || path.join(root, 'tests/fixtures/shorts-studio-speech-test.mp4'));
const outputDir = path.resolve(process.env.E2E_OUTPUT_DIR || path.join(here, 'output'));
const appUrl = process.env.E2E_URL || 'http://shorts-studio.local/';
const chromiumPath = process.env.CHROMIUM_EXECUTABLE_PATH || '/home/hermes/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome';
const transcriptionTimeoutMs = Number(process.env.TRANSCRIPTION_TIMEOUT_MS || 1_200_000);
const renderTimeoutMs = Number(process.env.RENDER_TIMEOUT_MS || 900_000);
const result = {
  appUrl,
  fixture,
  screenshots: {},
  console: [],
  pageErrors: [],
  requestFailures: [],
  webCodecs: {},
  transcription: null,
  editor: null,
  render: { attempted: false, producedDownload: false },
};
let browser;

async function main() {
  await Promise.all([access(fixture), access(chromiumPath)]);
  await mkdir(outputDir, { recursive: true });
  result.screenshots.initial = path.join(outputDir, 'initial-ui.png');
  result.screenshots.captionEditor = path.join(outputDir, 'caption-editor.png');
  result.render.output = path.join(outputDir, 'rendered.mp4');

  browser = await chromium.launch({
    headless: true,
    executablePath: chromiumPath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('console', message => result.console.push({ type: message.type(), text: message.text() }));
  page.on('pageerror', error => result.pageErrors.push({ name: error.name, message: error.message, stack: error.stack }));
  page.on('requestfailed', request => result.requestFailures.push({ url: request.url(), error: request.failure()?.errorText || 'unknown request failure' }));

  // No page.route() here. Enabling request interception makes Playwright bypass
  // Chromium's HTTP cache for the whole context, which defeats the worker asset
  // prewarm the app relies on against the CDN edge: the harness would then fail
  // with 'the transcription engine could not load' on a build that works in a
  // real browser. Word-level assertions live in word-export.mjs, which reads the
  // exported JSON instead of patching app code on the wire.
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('#page-title').waitFor({ state: 'visible' });
  await page.screenshot({ path: result.screenshots.initial, fullPage: true });
  result.initialUi = {
    title: await page.title(),
    heading: await page.locator('#page-title').innerText(),
    fileInputPresent: await page.locator('#fileInput').count() === 1,
  };
  result.webCodecs = await page.evaluate(async () => {
    const encoder = typeof VideoEncoder === 'undefined'
      ? { available: false }
      : { available: true, ...(await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: 1080, height: 1920, bitrate: 1_000_000, framerate: 30 })) };
    const decoder = typeof VideoDecoder === 'undefined'
      ? { available: false }
      : { available: true, ...(await VideoDecoder.isConfigSupported({ codec: 'avc1.640028', width: 1080, height: 1920 })) };
    return { userAgent: navigator.userAgent, isSecureContext, VideoEncoder: typeof VideoEncoder, VideoDecoder: typeof VideoDecoder, encoder, decoder };
  });

  await page.locator('#fileInput').setInputFiles(fixture);
  await page.waitForFunction(() => document.querySelector('#startButton')?.disabled === false);
  result.input = {
    selectedName: await page.locator('#fileSummary').innerText(),
    startEnabled: !(await page.locator('#startButton').isDisabled()),
  };
  result.input.ffprobe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=format_name,duration,size:stream=codec_name,codec_type,width,height,r_frame_rate,sample_rate,channels',
    '-of', 'json', fixture,
  ], { encoding: 'utf8', timeout: 60_000 }));
  await page.locator('#startButton').click();
  await page.waitForFunction(() => {
    const status = document.querySelector('#workflowStatus')?.textContent?.trim();
    return status === 'Review your captions' || status === 'Could not process this video';
  }, null, { timeout: transcriptionTimeoutMs, polling: 1000 });

  const workflowStatus = (await page.locator('#workflowStatus').innerText()).trim();
  const visibleError = await page.locator('#errorNotice').isVisible()
    ? (await page.locator('#errorNotice').innerText()).trim()
    : null;
  result.transcription = { status: workflowStatus, wordCount: null, error: visibleError };

  if (workflowStatus === 'Review your captions') {
    await page.locator('#workspace').waitFor({ state: 'visible' });
    const rows = await page.locator('#captionList .caption-row').evaluateAll(items => items.map(row => ({
      timing: row.querySelector('.caption-row-head span:last-child')?.textContent?.trim() || '',
      text: row.querySelector('textarea')?.value || '',
    })));
    result.editor = {
      visible: true,
      captionGroupCount: rows.length,
      displayedGroupCount: (await page.locator('#groupCount').innerText()).trim(),
      wordsInCaptionUi: rows.reduce((sum, row) => sum + row.text.trim().split(/\s+/u).filter(Boolean).length, 0),
      groups: rows,
    };

    result.transcription.wordCount = result.editor.wordsInCaptionUi;
    // Seek into the first caption group so the preview has something to draw.
    const firstGroupStart = Number((rows[0]?.timing.match(/([\d.]+)s/) || [])[1]);
    if (Number.isFinite(firstGroupStart)) {
      await page.locator('#timeSlider').evaluate((slider, time) => {
        slider.value = String(Math.max(0, Math.min(Number(slider.max), time + 0.05)));
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }, firstGroupStart);
      await page.waitForTimeout(300);
    }
    result.editor.previewCanvas = await page.locator('#previewCanvas').evaluate(canvas => {
      const ctx = canvas.getContext('2d');
      if (!ctx || canvas.width < 1 || canvas.height < 1) return { width: canvas.width, height: canvas.height, nonUniformSamples: 0 };
      const samples = [
        [0.12, 0.12], [0.5, 0.12], [0.88, 0.12],
        [0.12, 0.5], [0.5, 0.5], [0.88, 0.5],
        [0.12, 0.88], [0.5, 0.88], [0.88, 0.88],
      ].map(([x, y]) => [...ctx.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data]);
      return { width: canvas.width, height: canvas.height, nonUniformSamples: new Set(samples.map(pixel => pixel.join(','))).size, samples };
    });
    await page.screenshot({ path: result.screenshots.captionEditor, fullPage: true });

    result.render.attempted = true;
    await page.locator('#renderButton').click();
    await page.waitForFunction(() => {
      const status = document.querySelector('#workflowStatus')?.textContent?.trim();
      return status === 'Render complete' || status === 'Render failed' || status === 'Render cancelled';
    }, null, { timeout: renderTimeoutMs, polling: 1000 });
    result.render.status = (await page.locator('#workflowStatus').innerText()).trim();
    result.render.error = await page.locator('#errorNotice').isVisible()
      ? (await page.locator('#errorNotice').innerText()).trim()
      : null;
    if (result.render.status === 'Render complete' && await page.locator('#downloadLink').isVisible()) {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 60_000 }),
        page.locator('#downloadLink').click(),
      ]);
      await download.saveAs(result.render.output);
      result.render.producedDownload = true;
      result.render.suggestedFilename = download.suggestedFilename();
      try {
        const raw = execFileSync('ffprobe', [
          '-v', 'error', '-show_entries', 'format=format_name,duration,size:stream=codec_name,codec_type,width,height,r_frame_rate,sample_rate,channels',
          '-of', 'json', result.render.output,
        ], { encoding: 'utf8', timeout: 60_000 });
        result.render.ffprobe = JSON.parse(raw);
        const streams = result.render.ffprobe.streams || [];
        const video = streams.find(stream => stream.codec_type === 'video');
        const audio = streams.find(stream => stream.codec_type === 'audio');
        result.render.validMp4 = Boolean(
          (result.render.ffprobe.format?.format_name || '').split(',').includes('mp4') &&
          video?.codec_name === 'h264' && video.width === 1080 && video.height === 1920 && audio &&
          Math.abs(Number(result.render.ffprobe.format?.duration) - 24) <= 1,
        );
      } catch (error) {
        result.render.ffprobeError = `${error.name}: ${error.message}`;
      }
    }
  } else {
    result.editor = { visible: false };
    result.render.error = 'Render was not attempted because transcription did not reach the caption editor.';
  }

  result.consoleErrorCount = result.console.filter(message => message.type === 'error').length;
  // Word-level timestamp assertions live in word-export.mjs, which reads the
  // exported JSON; this harness checks that transcription produced captions.
  result.status = result.transcription?.status !== 'Review your captions'
    ? 'FAIL'
    : !(result.transcription.wordCount > 0) || result.editor?.captionGroupCount < 1
      ? 'FAIL'
      : result.render.validMp4
        ? 'PASS'
        : 'PARTIAL';
  await writeFile(path.join(outputDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'FAIL') process.exitCode = 1;
}

main().catch(async error => {
  result.fatalError = { name: error.name, message: error.message, stack: error.stack };
  result.status = 'FAIL';
  try {
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  } catch {}
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}).finally(async () => {
  await browser?.close();
});
