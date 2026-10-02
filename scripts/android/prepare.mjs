// Customises the Android project that `npx cap add android` generates (Capacitor), so the APK is a normal,
// self-contained app: NameTag icons and splash, colours, storage permission for saving to Documents on
// old Android versions, version numbers and release signing read from environment variables.
// Usage (CI does this):  npx cap add android && node scripts/android/prepare.mjs && npx cap sync android
import { readFileSync, writeFileSync, existsSync, rmSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderAndroidRes } from '../icons/build-icons.mjs';

const root = new URL('../../', import.meta.url).pathname;
const app = join(root, 'android/app');
if (!existsSync(app)) throw new Error('android/ not found. Run `npx cap add android` first.');
const cfg = JSON.parse(readFileSync(join(root, 'capacitor.config.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;
const edit = (file, fn) => { const p = join(app, file); const before = readFileSync(p, 'utf8'); const after = fn(before); if (after === before) console.warn(`(no change) ${file}`); writeFileSync(p, after); };
const need = (s, a, b) => { if (!s.includes(a)) throw new Error(`Patch point not found: ${a.slice(0, 70)}`); return s.replace(a, b); };

// 1. Icons and splash screens.
const res = join(app, 'src/main/res');
rmSync(join(res, 'drawable-v24/ic_launcher_foreground.xml'), { force: true }); // template vector replaced by our PNG layers
renderAndroidRes(res);

// 2. Colours: splash background (Android 12+ system splash) matches the app.
writeFileSync(join(res, 'values/nametag_colors.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="nametag_background">#EEF0F2</color>
    <color name="nametag_primary">#2248C8</color>
</resources>
`);
edit('src/main/res/values/styles.xml', (s) => need(s, '<item name="android:background">@drawable/splash</item>',
  '<item name="android:background">@drawable/splash</item>\n        <item name="windowSplashScreenBackground">@color/nametag_background</item>\n        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>'));
edit('src/main/res/values/strings.xml', (s) => s
  .replace(/<string name="app_name">[^<]*<\/string>/, `<string name="app_name">${cfg.appName}</string>`)
  .replace(/<string name="title_activity_main">[^<]*<\/string>/, `<string name="title_activity_main">${cfg.appName}</string>`));

// 3. Saving to Documents/NameTag needs the legacy storage permission on Android 10 and older only.
edit('src/main/AndroidManifest.xml', (s) => {
  let x = s;
  if (!x.includes('WRITE_EXTERNAL_STORAGE')) x = need(x, '<uses-permission android:name="android.permission.INTERNET" />',
    '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />\n    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />');
  if (!x.includes('FOREGROUND_SERVICE')) x = need(x, '<uses-permission android:name="android.permission.INTERNET" />',
    '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />\n    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />\n    <uses-permission android:name="android.permission.WAKE_LOCK" />\n    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />');
  if (!x.includes('KeepAliveService')) x = need(x, '</application>', '    <service android:name=".KeepAliveService" android:exported="false" android:foregroundServiceType="dataSync" />\n    </application>');
  if (!x.includes('requestLegacyExternalStorage')) x = need(x, 'android:supportsRtl="true"', 'android:supportsRtl="true"\n        android:requestLegacyExternalStorage="true"');
  return x;
});

// 4. Version and signing from the environment (GitHub Actions); defaults for local builds.
const versionName = env('ANDROID_VERSION_NAME', pkg.version);
edit('build.gradle', (s) => {
  let g = s;
  g = g.replace(/versionCode \d+/, "versionCode Integer.parseInt(System.getenv('ANDROID_VERSION_CODE') ?: '1')");
  g = g.replace(/versionName "[^"]*"/, `versionName "${versionName}"`);
  if (!g.includes('signingConfigs')) {
    g = need(g, '    buildTypes {', `    signingConfigs {
        release {
            def ks = System.getenv('ANDROID_KEYSTORE_FILE')
            if (ks) {
                storeFile file(ks)
                storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD')
                keyAlias System.getenv('ANDROID_KEY_ALIAS') ?: 'nametag'
                keyPassword System.getenv('ANDROID_KEY_PASSWORD') ?: System.getenv('ANDROID_KEYSTORE_PASSWORD')
            }
        }
    }
    buildTypes {`);
    g = need(g, '        release {\n            minifyEnabled false', "        release {\n            if (System.getenv('ANDROID_KEYSTORE_FILE')) signingConfig signingConfigs.release\n            minifyEnabled false");
  }
  return g;
});

// 5. Native folder access (Storage Access Framework): the NameTagFolders plugin, registered in MainActivity.
const javaDir = join(app, 'src/main/java', ...cfg.appId.split('.'));
mkdirSync(javaDir, { recursive: true });
for (const f of ['FoldersPlugin.java', 'KeepAliveService.java', 'MainActivity.java']) {
  const src = readFileSync(join(root, 'scripts/android/java', f), 'utf8').replace(/^package [\w.]+;/m, `package ${cfg.appId};`);
  writeFileSync(join(javaDir, f), src);
}

console.log(`Android project prepared: ${cfg.appId} ${versionName}`);
