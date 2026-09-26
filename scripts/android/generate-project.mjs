// Regenerates the Android (Trusted Web Activity) project in ./android from the web manifest and icons,
// using Bubblewrap's generator. Run after changing icons, colours or the manifest:
//   npm i -D @bubblewrap/core && node scripts/android/generate-project.mjs
// The host, package id, version and signing are NOT baked in: android/app/build.gradle reads them from
// environment variables at build time (see .github/workflows/android.yml), with twa-config.json as defaults.
import { readFileSync, writeFileSync, rmSync, existsSync, cpSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, dirname } from 'node:path';
import { TwaManifest, TwaGenerator, ConsoleLog } from '@bubblewrap/core';
import { renderAdaptive } from '../icons/build-icons.mjs';

const root = new URL('../../', import.meta.url).pathname;
const cfg = JSON.parse(readFileSync(join(root, 'scripts/android/twa-config.json'), 'utf8'));
const out = join(root, 'android');
const webManifest = JSON.parse(readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8'));

// Serve ./public locally so the generator can download the icons.
const types = { '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  const p = join(root, 'public', decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream', connection: 'close' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const local = `http://127.0.0.1:${server.address().port}/`;

try {
  const base = TwaManifest.fromWebManifestJson(new URL(`https://${cfg.host}/manifest.webmanifest`), webManifest).toJson();
  // Rebuild through the constructor so colours are parsed into the generator's colour objects.
  const twa = new TwaManifest({
    ...base,
    packageId: cfg.packageId, host: cfg.host, name: cfg.name, launcherName: cfg.launcherName,
    appVersionName: cfg.versionName, appVersion: cfg.versionName, appVersionCode: 1, minSdkVersion: cfg.minSdkVersion,
    fallbackType: cfg.fallbackType, orientation: cfg.orientation, generatorApp: 'NameTag scripts/android',
    signingKey: { path: './nametag.keystore', alias: 'nametag' },
    enableNotifications: false, enableSiteSettingsShortcut: true,
    themeColor: cfg.themeColor, themeColorDark: cfg.themeColorDark, navigationColor: cfg.navigationColor,
    navigationColorDark: cfg.navigationColorDark, backgroundColor: cfg.backgroundColor,
    navigationDividerColor: cfg.navigationColor, navigationDividerColorDark: cfg.navigationColorDark,
  });
  // Download icons from the local copy instead of the (not yet deployed) site.
  const toLocal = (u) => (u ? String(u).replace(`https://${cfg.host}/`, local) : u);
  twa.webManifestUrl = toLocal(twa.webManifestUrl);
  twa.iconUrl = toLocal(twa.iconUrl); twa.maskableIconUrl = toLocal(twa.maskableIconUrl); twa.monochromeIconUrl = toLocal(twa.monochromeIconUrl);
  for (const s of twa.shortcuts || []) { if (s.chosenIconUrl) s.chosenIconUrl = toLocal(s.chosenIconUrl); if (s.chosenMaskableIconUrl) s.chosenMaskableIconUrl = toLocal(s.chosenMaskableIconUrl); if (s.chosenMonochromeIconUrl) s.chosenMonochromeIconUrl = toLocal(s.chosenMonochromeIconUrl); }
  const errs = twa.validate?.(); if (errs) throw new Error(errs);

  // Keep hand-written files across regeneration.
  const tmp = join(root, '.android-keep');
  rmSync(tmp, { recursive: true, force: true });
  for (const f of ['README.md', 'store']) if (existsSync(join(out, f))) cpSync(join(out, f), join(tmp, f), { recursive: true });
  rmSync(out, { recursive: true, force: true });
  await new TwaGenerator().createTwaProject(out, twa, new ConsoleLog('generate'));
  if (existsSync(tmp)) { cpSync(tmp, out, { recursive: true }); rmSync(tmp, { recursive: true, force: true }); }

  // Store the manifest with public URLs (not the temporary local ones) for future `bubblewrap update`.
  const toPublic = (u) => (u ? String(u).replace(local, `https://${cfg.host}/`) : u);
  twa.webManifestUrl = toPublic(twa.webManifestUrl);
  twa.iconUrl = toPublic(twa.iconUrl); twa.maskableIconUrl = toPublic(twa.maskableIconUrl); twa.monochromeIconUrl = toPublic(twa.monochromeIconUrl);
  for (const s of twa.shortcuts || []) for (const k of ['chosenIconUrl', 'chosenMaskableIconUrl', 'chosenMonochromeIconUrl']) if (s[k]) s[k] = toPublic(s[k]);
  await twa.saveToFile(join(out, 'twa-manifest.json'));

  patchGradle(join(out, 'app/build.gradle'), local);
  renderAdaptive(join(out, 'app/src/main/res')); // proper adaptive + themed (monochrome) launcher icon
  console.log('Android project written to ./android');
} finally {
  server.closeAllConnections?.();
  server.close();
}

/** Make host, package id, version and signing configurable from the environment (CI) instead of hard-coded. */
function patchGradle(file, local) {
  let g = readFileSync(file, 'utf8');
  const H = cfg.host;
  g = g.split(`${local}manifest.webmanifest`).join(`https://${H}/manifest.webmanifest`);
  const need = (a, b) => { if (!g.includes(a)) throw new Error(`build.gradle patch point missing: ${a.slice(0, 60)}`); g = g.replace(a, b); };
  need(`hostName: '${H}',`, 'hostName: pwaHost,');
  // Every other string literal that embeds the host follows PWA_HOST as well.
  g = g.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, (lit) => {
    if (!lit.includes(H)) return lit;
    const q = lit[0];
    return lit.split(H).join(`${q} + pwaHost + ${q}`);
  });
  need('def twaManifest = [', `// NameTag: host, package id, version and signing can be overridden at build time
// (see .github/workflows/android.yml). Defaults come from scripts/android/twa-config.json.
def envOr = { String key, def fallback -> def v = System.getenv(key); (v != null && !v.trim().isEmpty()) ? v.trim() : fallback }
def pwaHost = envOr('PWA_HOST', '${H}')

def twaManifest = [`);
  // Launcher shortcuts point at the Java class, which lives in the fixed namespace even if the id changes.
  g = g.split("twaManifest.applicationId + '.LauncherActivity'").join(`'${cfg.packageId}.LauncherActivity'`);
  need(`applicationId: '${cfg.packageId}',`, `applicationId: envOr('ANDROID_PACKAGE_ID', '${cfg.packageId}'),`);
  need(`applicationId "${cfg.packageId}"`, 'applicationId twaManifest.applicationId');
  g = g.replace(/versionCode \d+/, "versionCode Integer.parseInt(envOr('ANDROID_VERSION_CODE', '1'))");
  g = g.replace(/versionName "[^"]*"/, `versionName envOr('ANDROID_VERSION_NAME', '${cfg.versionName}')`);
  // Digital Asset Links statement for the verified host (moved here from strings.xml so it follows PWA_HOST).
  need('        resValue "string", "hostName", twaManifest.hostName', `        resValue "string", "hostName", twaManifest.hostName

        resValue "string", "assetStatements", '[{ \\\\"relation\\\\": [\\\\"delegate_permission/common.handle_all_urls\\\\"], \\\\"target\\\\": { \\\\"namespace\\\\": \\\\"web\\\\", \\\\"site\\\\": \\\\"https://' + pwaHost + '\\\\" } }]'`);
  // Signing from environment: a keystore file path plus passwords (release builds only).
  need('    buildTypes {', `    signingConfigs {
        release {
            def ks = envOr('ANDROID_KEYSTORE_FILE', '')
            if (ks) {
                storeFile file(ks)
                storePassword envOr('ANDROID_KEYSTORE_PASSWORD', '')
                keyAlias envOr('ANDROID_KEY_ALIAS', 'nametag')
                keyPassword envOr('ANDROID_KEY_PASSWORD', '')
            }
        }
    }

    buildTypes {`);
  g = g.replace(/(release \{\s*\n\s*minifyEnabled)/, "release {\n            if (envOr('ANDROID_KEYSTORE_FILE', '')) signingConfig signingConfigs.release\n            minifyEnabled");
  writeFileSync(file, g);
  // Remove the hard-coded statement from strings.xml (now generated in build.gradle).
  const sx = join(dirname(file), 'src/main/res/values/strings.xml');
  const x = readFileSync(sx, 'utf8').replace(/\s*<!--(?:(?!-->)[^])*-->\s*<string name="assetStatements">[^]*?<\/string>\s*/, '\n');
  writeFileSync(sx, x);
}
