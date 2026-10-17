// Stamps public/js/version.js with the release version, CI build number and commit, so the running app
// (header badge and Guide) tells you exactly which build it is.
// Used by scripts/android/prepare.mjs (APK) and the Render build; safe to run locally.
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../public/js/version.js', import.meta.url);

export function stampAppVersion({ version, build, commit } = {}) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const v = version || process.env.ANDROID_VERSION_NAME || pkg.version;
  const b = String(build ?? process.env.ANDROID_VERSION_CODE ?? process.env.GITHUB_RUN_NUMBER ?? '').replace(/[^\w.-]/g, '');
  const c = String(commit ?? process.env.GITHUB_SHA ?? process.env.RENDER_GIT_COMMIT ?? '').slice(0, 7).replace(/[^\w]/g, '');
  const src = readFileSync(file, 'utf8');
  const out = src
    .replace(/export const APP_VERSION = '[^']*';/, `export const APP_VERSION = '${String(v).replace(/[^\w.+-]/g, '')}';`)
    .replace(/export const APP_BUILD = '[^']*';/, `export const APP_BUILD = '${b}';`)
    .replace(/export const APP_COMMIT = '[^']*';/, `export const APP_COMMIT = '${c}';`);
  if (!out.includes('APP_BUILD') || out === src && !src.includes(`'${v}'`)) throw new Error('Version markers not found in public/js/version.js');
  writeFileSync(file, out);
  console.log(`App version stamped: ${v}${b ? ` build ${b}` : ''}${c ? ` (${c})` : ''}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) stampAppVersion();
