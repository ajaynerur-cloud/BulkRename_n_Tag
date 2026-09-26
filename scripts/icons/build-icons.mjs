// Renders all app and Android icons from icon-src.mjs.  Usage: npm i -D @resvg/resvg-js && node scripts/icons/build-icons.mjs
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { iconAny, iconMaskable, iconMono, iconFavicon, adaptiveBackground, adaptiveForeground, adaptiveMonochrome } from './icon-src.mjs';

/** Writes adaptive launcher layers into an Android res/ folder (used by scripts/android/generate-project.mjs). */
export function renderAdaptive(resDir) {
  const dens = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
  for (const [d, px] of Object.entries(dens)) {
    const dir = `${resDir}/mipmap-${d}/`; mkdirSync(dir, { recursive: true });
    png(adaptiveBackground(), px, dir + 'ic_launcher_background.png');
    png(adaptiveForeground(), px, dir + 'ic_launcher_foreground.png');
    png(adaptiveMonochrome(), px, dir + 'ic_launcher_monochrome.png');
  }
  mkdirSync(`${resDir}/mipmap-anydpi-v26`, { recursive: true });
  writeFileSync(`${resDir}/mipmap-anydpi-v26/ic_launcher.xml`, `<?xml version="1.0" encoding="utf-8"?>
<!-- NameTag adaptive icon: layers rendered by scripts/icons/build-icons.mjs. Monochrome is used for Android 13+ themed icons. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />
</adaptive-icon>
`);
}
function png(svg, size, file) { writeFileSync(file, new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()); }

const isMain = import.meta.url === `file://${process.argv[1]}`;
const out = new URL('../../public/icons/', import.meta.url).pathname;
const store = new URL('../../android/store/', import.meta.url).pathname;
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
if (existsSync(res)) renderAdaptive(res);
console.log('icons written to public/icons, android/store and the Android launcher layers');
}
