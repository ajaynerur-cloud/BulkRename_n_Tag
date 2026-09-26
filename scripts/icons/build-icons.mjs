// Renders all app and Android icons from icon-src.mjs.  Usage: npm i -D @resvg/resvg-js && node scripts/icons/build-icons.mjs
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { iconAny, iconMaskable, iconMono, iconFavicon, adaptiveBackground, adaptiveForeground, adaptiveMonochrome, splash } from './icon-src.mjs';

/**
 * Writes every launcher icon and splash image into an Android res/ folder (used by scripts/android/prepare.mjs):
 * legacy + round icons, adaptive layers (background, foreground, monochrome for themed icons) and splash screens.
 */
export function renderAndroidRes(resDir) {
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  const roundSvg = iconMaskable().replace('<rect width="512" height="512" fill="url(#g)"/>', '<circle cx="256" cy="256" r="256" fill="url(#g)"/>').replace(/<path d="M0 0 H512 V190 Q256 250 0 190 Z"[^>]*\/>/, '');
  for (const [d, k] of Object.entries(dens)) {
    const dir = `${resDir}/mipmap-${d}/`; mkdirSync(dir, { recursive: true });
    png(iconAny(), 48 * k, dir + 'ic_launcher.png');
    png(roundSvg, 48 * k, dir + 'ic_launcher_round.png');
    png(adaptiveBackground(), 108 * k, dir + 'ic_launcher_background.png');
    png(adaptiveForeground(), 108 * k, dir + 'ic_launcher_foreground.png');
    png(adaptiveMonochrome(), 108 * k, dir + 'ic_launcher_monochrome.png');
  }
  const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<!-- NameTag adaptive icon, rendered by scripts/icons/build-icons.mjs. Monochrome is used for Android 13+ themed icons. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />
</adaptive-icon>
`;
  mkdirSync(`${resDir}/mipmap-anydpi-v26`, { recursive: true });
  writeFileSync(`${resDir}/mipmap-anydpi-v26/ic_launcher.xml`, adaptive);
  writeFileSync(`${resDir}/mipmap-anydpi-v26/ic_launcher_round.xml`, adaptive);
  const splashes = { 'drawable': [480, 320], 'drawable-port-mdpi': [320, 480], 'drawable-port-hdpi': [480, 800], 'drawable-port-xhdpi': [720, 1280], 'drawable-port-xxhdpi': [960, 1600], 'drawable-port-xxxhdpi': [1280, 1920], 'drawable-land-mdpi': [480, 320], 'drawable-land-hdpi': [800, 480], 'drawable-land-xhdpi': [1280, 720], 'drawable-land-xxhdpi': [1600, 960], 'drawable-land-xxxhdpi': [1920, 1280] };
  for (const [dir, [w, hgt]] of Object.entries(splashes)) { mkdirSync(`${resDir}/${dir}`, { recursive: true }); png(splash(w, hgt), w, `${resDir}/${dir}/splash.png`); }
}
function png(svg, size, file) { writeFileSync(file, new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()); }

const isMain = import.meta.url === `file://${process.argv[1]}`;
const out = new URL('../../public/icons/', import.meta.url).pathname;
const store = new URL('../../store/', import.meta.url).pathname;
if (isMain) build();

function build() {
mkdirSync(out, { recursive: true }); mkdirSync(store, { recursive: true });

writeFileSync(out + 'icon.svg', iconAny());
writeFileSync(out + 'icon-maskable.svg', iconMaskable());
writeFileSync(out + 'favicon.svg', iconFavicon());
for (const s of [48, 72, 96, 128, 144, 192, 256, 384, 512]) png(iconAny(), s, `${out}icon-${s}.png`);
for (const s of [192, 512]) png(iconMaskable(), s, `${out}maskable-${s}.png`);
for (const s of [96, 512]) png(iconMono(), s, `${out}monochrome-${s}.png`);
png(iconMaskable(), 180, out + 'apple-touch-icon.png'); // iOS masks corners itself, so use the full-bleed art
png(iconFavicon(), 32, out + 'favicon-32.png');
png(iconFavicon(), 16, out + 'favicon-16.png');
png(iconAny(), 512, store + 'play-store-icon-512.png');
const res = new URL('../../android/app/src/main/res', import.meta.url).pathname;
if (existsSync(res)) renderAndroidRes(res);
console.log('icons written to public/icons and store/ (and android/ if it has been generated)');
}
