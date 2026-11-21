/*
 * Record one break cycle of an effect to a GIF.
 *   node record.mjs <blackHole|wormhole|supernova|dust> <out.gif>
 * Needs: Chrome or Chromium (set CHROME_PATH, or run `npx playwright install chromium`)
 *        and ffmpeg on PATH.
 * The recorder steps t at a fixed frame rate, so the GIF timing is exact.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const EFFECTS = ['blackHole', 'wormhole', 'supernova', 'dust'];
const effect = EFFECTS.includes(process.argv[2]) ? process.argv[2] : 'blackHole';
const out = path.resolve(process.argv[3] || `preview-${effect}.gif`);
const FPS = 15;
const REST_FRAMES = 22;
const here = path.dirname(fileURLToPath(import.meta.url));
const frames = path.join(here, 'frames');

rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--allow-file-access-from-files']
});
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
await page.goto(pathToFileURL(path.join(here, 'index.html')).href + `?effect=${effect}&ui=0`);
await page.waitForFunction('window.ready === true', null, { timeout: 30000 });
await page.waitForTimeout(500);
const duration = await page.evaluate((e) => window.durationOf(e), effect);

let i = 0;
async function shot(t, msg = null, returning = false) {
  await page.evaluate(([e, tt, m, r]) => window.renderAt(e, tt, m, r), [effect, t, msg, returning]);
  await page.waitForTimeout(15);
  await page.screenshot({ path: path.join(frames, `f${String(i++).padStart(4, '0')}.png`) });
}

const n = Math.round(duration * FPS);
for (let k = 0; k < 10; k++) await shot(0);
for (let k = 0; k <= n; k++) await shot(k / FPS);
for (let k = 0; k < REST_FRAMES; k++) {
  const left = 20 - Math.floor(k / (FPS / 2));
  await shot(duration, `Rest your eyes. Look at something far away.  0:${String(left).padStart(2, '0')}`, true);
}
for (let k = n; k >= 0; k--) await shot(k / FPS, null, true);
for (let k = 0; k < 10; k++) await shot(0);
await browser.close();

execFileSync('ffmpeg', [
  '-loglevel', 'error', '-y', '-framerate', String(FPS), '-i', path.join(frames, 'f%04d.png'),
  '-vf', 'scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
  out
], { stdio: 'inherit' });
rmSync(frames, { recursive: true, force: true });
console.log(`wrote ${out} (${i} frames)`);
