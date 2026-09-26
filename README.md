# NameTag

An offline-first PWA with two tools:

1. **Bulk renamer** for files, folders and the contents of ZIP archives. It reads the current naming pattern, proposes a cleaner one, and writes a JSON undo file next to your files, so one click puts every original name back.
2. **Audio tag editor** for MP3, FLAC, M4A/M4B, OGG Vorbis, Opus, WAV and AIFF. It saves a JSON backup of the previous tags before each save, so tags can be restored too.

Everything runs in the browser. Files never leave the device. The only network calls are the optional MusicBrainz, Cover Art Archive and LRCLIB lookups, and they only run when you ask for them.

No framework, no bundler: plain ES modules, JSZip, and self-hosted fonts.

## Deploy to Render

1. Push this folder to a GitHub or GitLab repository:
   ```bash
   git init && git add . && git commit -m "NameTag"
   git branch -M main
   git remote add origin https://github.com/<you>/nametag.git
   git push -u origin main
   ```
2. In the Render dashboard, choose **New**, then **Blueprint**, and pick the repository. Render reads `render.yaml` and creates a static site named `nametag`.
   - Or choose **New**, then **Static Site**: build command `node scripts/stamp-version.mjs`, publish directory `public`.
3. Every push redeploys. The build step stamps the service-worker cache with the commit hash (`RENDER_GIT_COMMIT`). Open tabs then show "A new version of NameTag is ready" with an Update button.

`render.yaml` also sets security headers: CSP (only MusicBrainz, CAA/archive.org and LRCLIB are allowed as remote hosts), nosniff, referrer policy, no-cache for `sw.js`, and a rewrite of every path to `index.html`.

## Run locally

```bash
npm start          # serves ./public on http://localhost:5173 (service workers need http(s), not file://)
npm test           # renamer engine, portable restore + extension renamer, tag round-trips on real audio fixtures
npm run check      # syntax check + service-worker precache list check
```

## Renamer

**Sources**
- **Open folder**: renames in place, including subfolders. Needs the File System Access API.
- **Open ZIP**: renames entries inside the archive. The result is saved back over the ZIP, or downloaded as a new one.
- **Import files or a folder**: works in every browser. You get a renamed ZIP back.

**Rules** run top to bottom with a live preview. Removed characters are struck through and added ones are highlighted.

| Rule | What it does |
| --- | --- |
| Clean up | Underscores, dots, dashes (keep, space out or remove), camelCase splitting, `%20` decoding, bracketed junk, "(1)" / "- Copy" markers, accents and transliteration, emoji, Windows-invalid characters, spacing |
| Replace | Plain text or regex with `$1`; match case; whole word; first, last or all matches; name, extension or full name |
| Replace list | Many find/replace pairs at once |
| Remove | First or last N characters, a range, text, characters, digits, text before or after a marker, symbols |
| Change case | Title (small words, acronyms), sentence, lower, upper, camel, Pascal, snake, kebab, CONSTANT, dot.case, with exceptions and extension case |
| Add text | Prefix, suffix, or insert at a position (from start or end) |
| Numbering | Prefix, suffix, insert or replace; start, step, padding; decimal, letters, Roman or hex; reset per folder |
| Template | Build the name from variables (see below) |
| Extension | Lower or upper case, replace, remove, add, fix double extensions, detect the real type from file bytes |
| Swap | Split by a separator and reorder the parts ("Artist - Title" to "Title - Artist") |
| Trim | Keep text before, after or between markers; maximum length |
| Clear pattern | Strip leading track numbers (also "CD1-", "Track 03"), trailing numbers, dates, common prefix or suffix, quality tags (1080p, x264, 320kbps), URLs |
| Date | Insert modified date or today; reformat dates found in names |
| List | New names from a pasted list |
| Script | Your own JavaScript: `return name.toUpperCase();` |

**Template variables:** `{name} {original} {ext} {n} {n:3} {dn} {total} {parent} {parent:2} {root} {path:-} {mdate:YYYY-MM-DD} {now:HH.mm} {w:1} {w:-1} {c:1-4} {size} {bytes} {rand:6} {uuid}`, plus audio tags `{artist} {title} {album} {albumartist} {track:2} {disc} {year} {genre} {composer} {bitrate} {duration}`. Fallbacks use `|`, for example `{artist|Unknown}`.

**Pattern analyser.** It looks at separators and their consistency, field types (number, constant, date, text), common prefixes and suffixes, numbering (gaps, duplicates, padding), case style, junk (brackets, `%20`, copy markers, quality tags, URLs), camera and date names, invalid characters, reserved names, length, extension mix and audio files. It shows the detected pattern (for example `[##]_[text]`), proposes a new one, and offers ranked suggestion cards. Each card shows three before-and-after examples and can be applied in one click.

**Safety**
- **Conflicts are checked before anything moves.** That covers duplicates within a folder (including untouched files), Windows-invalid characters, reserved names such as `CON`, trailing dots or spaces, empty names, and names over 255 bytes. A clash gets " (2)" or is skipped, and the check is case-insensitive by default.
- **Renames run in a safe order.** Files go before their folders. Swaps (a becomes b, b becomes a) and case-only changes go through temporary names.
- **The undo file is written before the first rename.** It is `nametag-rename-YYYY-MM-DD_HH-mm-ss.json`, placed at the top of the folder or inside the ZIP, and updated when renaming finishes. If renaming stops partway, it records exactly what was done.
- **Restore simulates first.** It shows each item as ready, missing or blocked, then reverses the operations in order. It works from the Restore tab, from History, or on another computer.

**Presets:** clean names, music "01 - Title", from tags, photos by date, web slug, snake_case, sequential "Folder 001", remove numbering, lowercase extensions. You can save your own presets and export or import them as JSON.

### Extension renamer

Choose **Extensions** in the Renamer to change extensions in bulk, for a folder (in place), a ZIP, or imported files, with subfolders included.

- **Every extension found is listed** with its file count. Type a new extension next to any group; `-` removes it.
- **Quick options:** letter case (keep, lower, UPPER), unify spelling variants (`jpeg` to `jpg`, `tiff` to `tif`, `htm` to `html`, `mpeg` to `mpg`, `aif` to `aiff`, `yml` to `yaml`), fix extensions that do not match the file contents (reads the first bytes, so a PNG named `.jpg` becomes `.png`), and add missing extensions from content.
- **Mixed spellings are flagged** (for example `.JPEG`, `.jpeg` and `.jpg` in one folder), with a one-click fix.
- **It uses the same safety as renames.** Conflicts are checked first, case-only changes go through temporary names, and an undo file is written first (`"tool": "extension"`). Restore puts the old extensions back.

### Restoring on another computer

Undo and backup files never store absolute paths. Every path is relative to the folder or ZIP that was changed, so the JSON file travels with the files. Restore then lines the saved paths up with whatever was opened on the new computer:

- **The same folder, its parent, or an extracted ZIP with extra wrapper folders:** the offset is detected automatically.
- **Undo files in subfolders** are found as well, and the folder where one was found is used as a hint.
- **Only the JSON file?** Open it first ("Open an undo file first" in the Renamer, "Open a backup file first" in the Tag editor), then choose the folder, ZIP or import.
- **Manual control:** "Choose the folder on this computer" keeps the loaded undo file and switches the target. Two boxes adjust the mapping: skip N leading folders of the saved paths, and the subfolder the files are in here.
- **Moved or renamed subfolders** are detected by unique file names, e.g. `CD1` renamed to `Disc 1`. This is off for undo files where folders themselves were renamed, because those paths change over time.
- **Preview before restoring:** it shows how many items were found and marks each one as ready, missing or blocked (the Tag editor also marks files matched by name). When a mapping is used, it is recorded in the undo file as `lastRemap`.

This applies to all three tools: renamer, extension renamer and tag editor. The Tag editor can also open a ZIP directly, edit the audio inside, and save the ZIP back.

## Tag editor

**Editing**
- **Batch editing.** With several files selected, fields that differ show ‹keep›, so each file keeps its own value.
- **Fields:** title, artist, album, album artist, track and total, disc and total, year, genre, composer, comment, lyrics, BPM, key, ISRC, publisher, copyright, grouping, sort fields, compilation, and more. Custom fields (TXXX, Vorbis comments, iTunes freeform) are supported too.
- **Covers:** add, paste, drop, extract or remove, with optional resizing to JPEG.
- **Audio preview** is built in.
- **Filters:** modified, missing title, artist, album, track or cover.

**Tools**
- Filename to tags, using `%artist% - %title%` patterns and folders with `/`; the analyser suggests patterns.
- Tags to filename, using the renamer's template engine and writing a rename undo file.
- Auto-numbering per folder, with totals and padding.
- Case changes, find and replace, copying or formatting one field into another, removing fields, or stripping all tags.
- Covers from `cover.jpg`, `folder.jpg` or `front.*` in the same folder.
- MusicBrainz album lookup. Tracks are matched by number, then by title and length. Covers come from the Cover Art Archive.
- Lyrics from LRCLIB, plain and synced.
- CSV export and import (UTF-8 with BOM, opens in Excel), and M3U8 playlists.

**Backups.** Each save writes `nametag-tags-DATE.json` first. It holds the previous values, and the previous covers when they changed. Restore writes those values back and makes a new backup, so a restore can be undone too.

**Format details**
- **MP3:** ID3v2.2, 2.3 and 2.4 are read, including unsynchronisation, extended headers and non-syncsafe v2.4 frames. Tags are written as v2.3 (default) or v2.4. ID3v1 can be kept, updated, removed or always written. Frames NameTag does not edit are passed through untouched.
- **FLAC:** VORBIS_COMMENT and PICTURE blocks are rebuilt with 4 KB padding. STREAMINFO, seek tables and other blocks are kept.
- **OGG Vorbis and Opus:** header packets are repaginated with correct granules and CRCs. Later pages are renumbered only when the page count changes. Large lyrics and covers are fine.
- **M4A:** the `ilst` atom is edited, and `udta/meta/ilst` is created when missing. `stco`/`co64` chunk offsets are shifted, so files with the index at the start and files with it at the end both stay playable. Fragmented MP4 is refused.
- **WAV and AIFF:** an ID3 chunk is written, and WAV LIST-INFO is updated.

All eight formats are covered by `tests/tags.test.mjs`. Outputs were checked with ffmpeg (clean decode) and mutagen (tags readable).

## Android app (APK) from Git

The repository builds a real Android app with GitHub Actions: no Android Studio and no computer needed, so the whole process works from a phone browser. The app is a Trusted Web Activity. It opens your Render site full screen with its own icon, splash screen, launcher shortcuts (Renamer, Tag editor, History), and an entry in the Android **share sheet**: share audio, photos or a ZIP from any app and it opens in NameTag.

**One-time setup**
1. **Deploy to Render first** (see above) and note the domain, e.g. `nametag-abcd.onrender.com`.
2. **Set the site address.** On GitHub, open Settings, then Secrets and variables, Actions, then the Variables tab. Add `PWA_HOST` with that domain: no `https://`, no slash. Optionally add `ANDROID_PACKAGE_ID` (default `app.nametag.twa`).
3. **Create the signing key, once.** Go to Actions, choose "Android signing key (run once)", and press Run workflow. Download the `nametag-signing-key` artifact from the run. Add the four values from `SECRETS.txt` as repository **Secrets**. Keep `nametag.keystore` safe, because every future update must be signed with the same key.
4. **Build.** Go to Actions, choose "Android APK", and press Run workflow. Or push a tag such as `v1.2.0` to also get a GitHub Release. Download `NameTag-<version>.apk` from the run's artifacts and install it. Android asks you to allow installing from your browser or file manager.
5. **Remove the browser bar.** The build summary shows the certificate SHA-256 fingerprint. In Render, add the environment variable `ANDROID_CERT_SHA256` with that value and redeploy. The build step then publishes `/.well-known/assetlinks.json`, which proves the app and the site belong together, and the app opens without the address bar. Open `https://<your-domain>/.well-known/assetlinks.json` to check. For Google Play, also add Play's app-signing fingerprint (comma-separated).

**Build outputs**
- **APK:** installs directly on a phone.
- **AAB:** for Google Play upload.
- **`assetlinks.json`:** ready to use.

Every build gets an increasing version code automatically, so updates install over the previous version when they are signed with the same key.

Without the signing secrets, the workflow still builds, using a throwaway key. That is good for a quick test, but the browser bar stays and later builds cannot update that install.

**On Android**
- **Renaming and tag saving use the ZIP workflow.** Android's browser engine cannot write to folders, so open or share files and get a ZIP back.
- **Everything works offline** after the first launch.
- **Undo files travel with the files.** Restore works across phone and computer in both directions (see "Restoring on another computer").

**Files involved**
- **`android/`** is the generated Gradle project. Host, package id, version and signing come from environment variables, so it never needs editing for your domain.
- **`scripts/android/twa-config.json`** holds the defaults: package id, colours, version.
- **`scripts/android/generate-project.mjs`** regenerates `android/` with Bubblewrap after icon or manifest changes (`npm install && npm run android:generate`).
- **`.github/workflows/android.yml`** runs the build, and `android-signing-key.yml` creates the one-time key.

## App icon

The icon was drawn for NameTag: a name tag carrying a line of text, a highlighter-yellow edit and a text cursor, in the app's cobalt, highlighter yellow and ink colours. It is rendered from one source, `scripts/icons/icon-src.mjs`, by `npm run icons`, which produces:

- **Web:** `icon-48` to `icon-512`, `maskable-192` and `maskable-512` (full-bleed, artwork inside the 80% safe zone), `monochrome-96` and `monochrome-512`, SVG favicon plus 16 and 32 px PNGs, and the Apple touch icon.
- **Android:** adaptive launcher layers (background, foreground and monochrome for Android 13+ themed icons) at every density, the legacy launcher icon, the splash image, shortcut icons, and a 512 px Play Store icon (`android/store/`).

## Browser support

| Browser | Rename in place | Save tags in place | Everything else |
| --- | --- | --- | --- |
| Chrome, Edge, Opera, Brave (desktop) | Yes | Yes | Yes |
| Firefox, Safari | No: ZIP in, renamed ZIP out | No: edited files download as a ZIP | Yes |
| Android (browser or the APK) | No: same ZIP workflow | No: ZIP download | Yes, plus share-to-NameTag in the APK |
| iOS | No: same ZIP workflow | No: ZIP download | Yes, installable |

## Known limitations

- **Renaming changes the modified date on some systems.** Chromium implements in-place renames as a move.
- **Folders may need the copy fallback.** Chromium does not support renaming a directory handle in some versions. Turn on "Rename folders by copying" in Filters and options to copy and then delete instead. It is slower but safe, because the undo file is written first.
- **Cover Art Archive downloads can be blocked.** Images redirect to archive.org, which sometimes sends no CORS headers. When a download is blocked, NameTag shows the image link: save it, then drop it onto the cover box.
- **MusicBrainz allows one request per second.** NameTag spaces its requests to match.
- **Very large folders:** the preview is virtualised and handles tens of thousands of items. Renaming speed depends on the disk.

## Project layout

```
public/
  index.html, manifest.webmanifest, sw.js, css/app.css
  js/app.js                  routing, theme, install, drag and drop, service-worker updates
  js/core/                   utils, ui (dialogs, menus, virtual list), sources (folder/ZIP/import), remap (portable restore),
                             planner (conflicts, ordering, execute, restore), manifest, history (IndexedDB)
  js/renamer/                rules, analyzer, presets, extensions, renamer-ui
  js/tagger/                 bytes, model, id3, mpeg, flac, vorbis, ogg, mp4, riff, index, tools, online, tagger-ui
  vendor/jszip.min.js, fonts/ (Atkinson Hyperlegible Next and Mono, OFL), icons/
scripts/                     stamp-version.mjs (Render build: SW version + assetlinks.json), check.mjs,
                             icons/ (icon artwork + renderer), android/ (TWA config + project generator)
android/                     Android (Trusted Web Activity) Gradle project, built by GitHub Actions
.github/workflows/           android.yml (APK/AAB), android-signing-key.yml (one-time key), test.yml
tests/                       renamer.test.mjs, portable.test.mjs, tags.test.mjs, fixtures/
render.yaml
```

## Licenses

App code: MIT. JSZip: MIT or GPLv3 (dual). Atkinson Hyperlegible fonts: SIL OFL 1.1 (`public/fonts/LICENSE-OFL.txt`). Icons derived from Lucide (ISC).
