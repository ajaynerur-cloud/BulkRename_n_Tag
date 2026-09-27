// Screenshots of NameTag at phone, tablet and desktop sizes (run by .github/workflows/screenshots.yml).
// Loads sample files through the app's test hook, so the lists are not empty.
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  let p = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }); res.end(readFileSync(p));
});
await new Promise((r) => server.listen(4173, r));
mkdirSync(join(root, 'screenshots'), { recursive: true });

const sizes = [
  ['phone', { width: 390, height: 844 }, true],
  ['phone-landscape', { width: 844, height: 390 }, true],
  ['tablet', { width: 820, height: 1180 }, true],
  ['tablet-landscape', { width: 1180, height: 820 }, true],
  ['desktop', { width: 1440, height: 900 }, false],
];
const names = ['01_my_first_song%20live.mp3', '02_another-track (1).mp3', '03_THIRD_song [320kbps].mp3', '04_last_one.mp3', 'cover.JPG', 'IMG_20240101_120000.jpg', 'IMG_20240102_130500.jpg', 'notes_final_v2.txt'];
const browser = await chromium.launch();
for (const [label, viewport, touch] of sizes) {
  for (const dark of [false, true]) {
    const page = await browser.newPage({ viewport, hasTouch: touch, isMobile: touch && viewport.width < 900, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' });
    const shot = async (name) => page.screenshot({ path: join(root, 'screenshots', `${label}${dark ? '-dark' : ''}-${name}.png`) });
    await page.goto('http://localhost:4173/public/index.html#renamer');
    await page.waitForFunction(() => window.__nametag);
    await page.evaluate(async (list) => {
      const mp3 = await (await fetch('/tests/fixtures/t.mp3')).arrayBuffer();
      const files = list.map((n) => { const f = new File([mp3], n, { lastModified: Date.UTC(2024, 0, 2) }); Object.defineProperty(f, 'webkitRelativePath', { value: `Album/${n}` }); return f; });
      await window.__nametag.renamer.openDropped({ items: [], files });
    }, names);
    await page.waitForTimeout(600);
    await page.locator('#rn-analyser button', { hasText: 'Use these rules' }).first().click().catch(() => {});
    await page.waitForTimeout(400);
    await shot('renamer');
    if (touch && viewport.width < 768) { await page.locator('.pane-switch [data-pane="rules"]').click(); await page.waitForTimeout(200); await shot('renamer-rules'); }
    await page.goto('http://localhost:4173/public/index.html#tagger');
    await page.evaluate(async () => {
      const names = ['t.mp3', 't.flac', 'fast.m4a', 't.ogg', 't.opus', 't.wav'];
      const files = await Promise.all(names.map(async (n) => { const f = new File([await (await fetch(`/tests/fixtures/${n}`)).arrayBuffer()], n); Object.defineProperty(f, 'webkitRelativePath', { value: `Album/${n}` }); return f; }));
      await window.__nametag.tagger.openDropped({ items: [], files });
    });
    await page.waitForTimeout(800);
    await page.locator('.trow').first().click();
    await page.waitForTimeout(400);
    await shot('tagger');
    await page.goto('http://localhost:4173/public/index.html#guide');
    await page.waitForTimeout(300);
    await shot('guide');
    await page.close();
  }
}
await browser.close();
server.close();
console.log('screenshots/ written');
