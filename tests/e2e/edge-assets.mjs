// What does the edge actually return for a cold request to a worker asset?
// A worker that dies with no message is consistent with an HTML challenge page
// arriving where a JavaScript module was expected, so this reports status,
// content type and the first bytes of the body for each asset, repeatedly, in a
// fresh browser profile each time (so nothing is served from cache).

import { chromium } from 'playwright';

const APP_URL = process.env.E2E_URL || 'https://shorts.kruxor.com/';
const ROUNDS = Number(process.env.E2E_ROUNDS || 5);
const ASSETS = [
  '/js/transcribe.worker.js',
  '/js/transcribe-shared.js',
  '/vendor/transformers/transformers.web.js',
  '/vendor/common/esm/index.js',
  '/vendor/ort/ort.bundle.min.mjs',
];

const browser = await chromium.launch();
const rounds = [];
try {
  for (let round = 0; round < ROUNDS; round += 1) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(APP_URL, { waitUntil: 'load' });
    const results = await page.evaluate(async (assets) => {
      const out = [];
      for (const path of assets) {
        try {
          // no-store forces every request onto the network with an empty cache,
          // which is the state the worker sees on a first visit.
          const response = await fetch(new URL(path, location.href), { cache: 'no-store' });
          const body = await response.text();
          out.push({
            path,
            status: response.status,
            contentType: response.headers.get('content-type'),
            bytes: body.length,
            head: body.slice(0, 40).replace(/\s+/g, ' '),
            looksLikeHtml: /^\s*<(!doctype|html|meta)/i.test(body.slice(0, 200)),
          });
        } catch (error) {
          out.push({ path, error: String(error?.message || error) });
        }
      }
      return out;
    }, ASSETS);
    rounds.push({ round: round + 1, results });
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ appUrl: APP_URL, rounds }, null, 2));
const bad = rounds.flatMap(r => r.results.filter(x => x.error || !x.status || x.status !== 200 || x.looksLikeHtml));
console.log(bad.length ? `VERDICT: ${bad.length} bad asset response(s) across ${ROUNDS} cold rounds` : `VERDICT: all assets 200 JavaScript across ${ROUNDS} cold rounds`);
process.exit(0);
