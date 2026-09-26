// Render build step:
// 1. stamps the service-worker cache version with the commit, so every deploy refreshes clients;
// 2. writes /.well-known/assetlinks.json (Digital Asset Links) when ANDROID_CERT_SHA256 is set,
//    which lets the Android app open full screen without a browser bar.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

const version = (process.env.RENDER_GIT_COMMIT || '').slice(0, 12) || new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const file = new URL('../public/sw.js', import.meta.url);
const src = readFileSync(file, 'utf8');
const out = src.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`);
if (out === src && !src.includes(`'${version}'`)) throw new Error('VERSION marker not found in sw.js');
writeFileSync(file, out);
console.log(`sw.js cache version: ${version}`);

const cfg = JSON.parse(readFileSync(new URL('./android/twa-config.json', import.meta.url), 'utf8'));
const pkg = (process.env.ANDROID_PACKAGE_ID || '').trim() || cfg.packageId;
const shas = (process.env.ANDROID_CERT_SHA256 || '').split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
const dir = new URL('../public/.well-known/', import.meta.url);
const bad = shas.filter((s) => !/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(s));
if (bad.length) throw new Error(`ANDROID_CERT_SHA256 has an invalid fingerprint: ${bad.join(', ')} (expected 32 hex pairs like AB:CD:...)`);
if (shas.length) {
  mkdirSync(dir, { recursive: true });
  const links = [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: shas } }];
  writeFileSync(new URL('assetlinks.json', dir), `${JSON.stringify(links, null, 2)}\n`);
  console.log(`assetlinks.json: ${pkg} with ${shas.length} fingerprint(s)`);
} else {
  rmSync(new URL('assetlinks.json', dir), { force: true });
  console.log('assetlinks.json skipped (set ANDROID_CERT_SHA256 on Render once you have an Android signing key)');
}
