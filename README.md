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
| Tidy up names | Underscores, dots, dashes (keep, space out or remove), camelCase splitting, `%20` decoding, bracketed junk, "(1)" / "- Copy" markers, accents and transliteration, emoji, Windows-invalid characters, spacing |
| Find and replace | Plain text or regex with `$1`; match case; whole word; first, last or all matches; name, extension or full name |
| Replace many at once | Many find/replace pairs at once |
| Remove characters | First or last N characters, a range, text, characters, digits, text before or after a marker, symbols |
| Change letter case | Title (small words, acronyms), sentence, lower, upper, camel, Pascal, snake, kebab, CONSTANT, dot.case, with exceptions and extension case |
| Add text | Prefix, suffix, or insert at a position (from start or end) |
| Add numbers | Prefix, suffix, insert or replace; start, step, padding; decimal, letters, Roman or hex; reset per folder |
| Build from template | Build the name from variables (see below) |
| Change extension | Lower or upper case, replace, remove, add, fix double extensions, detect the real type from file bytes |
| Swap | Split by a separator and reorder the parts ("Artist - Title" to "Title - Artist") |
| Keep only part | Keep text before, after or between markers; maximum length |
| Strip numbers and tags | Strip leading track numbers (also "CD1-", "Track 03"), trailing numbers, dates, common prefix or suffix, quality tags (1080p, x264, 320kbps), URLs |
| Add or reformat date | Insert modified date or today; reformat dates found in names |
| Rename from a list | New names from a pasted list |
| Custom script (JavaScript) | Your own JavaScript: `return name.toUpperCase();` |

**Template variables** (Build from template, Add text, Find and replace): `{name} {original} {ext} {n} {n:3} {dn} {total} {parent} {parent:2} {root} {path:-} {mdate:YYYY-MM-DD} {now:HH.mm} {w:1} {w:-1} {c:1-4} {size} {bytes} {rand:6} {uuid}`, plus audio tags `{artist} {title} {album} {albumartist} {track:2} {disc} {year} {genre} {composer} {bitrate} {duration}`. Fallbacks use `|`, for example `{artist|Unknown}`.

**Pattern analyser.** It looks at separators and their consistency, field types (number, constant, date, text), common prefixes and suffixes, numbering (gaps, duplicates, padding), case style, junk (brackets, `%20`, copy markers, quality tags, URLs), camera and date names, invalid characters, reserved names, length, extension mix and audio files. It shows the detected pattern (for example `[##]_[text]`), proposes a new one, and offers ranked suggestion cards. Each card shows three before-and-after examples and can be applied in one click.

**Safety**
- **Conflicts are checked before anything moves.** That covers duplicates within a folder (including untouched files), Windows-invalid characters, reserved names such as `CON`, trailing dots or spaces, empty names, and names over 255 bytes. A clash gets " (2)" or is skipped, and the check is case-insensitive by default.
- **Renames run in a safe order.** Files go before their folders. Swaps (a becomes b, b becomes a) and case-only changes go through temporary names.
- **The undo file is written before the first rename.** It is `nametag-rename-YYYY-MM-DD_HH-mm-ss.json`, placed at the top of the folder or inside the ZIP, and updated when renaming finishes. If renaming stops partway, it records exactly what was done.
- **Restore simulates first.** It shows each item as ready, missing or blocked, then reverses the operations in order. It works from the Restore tab, from History, or on another computer.

**Presets:** clean names, music "01 - Title", from tags, photos by date, web slug, snake_case, sequential "Folder 001", remove numbering, lowercase extensions. You can save your own presets and export or import them as JSON.

### Background jobs and parallel work

- **Renames and tag saves are background jobs.** They do not block the screen. A progress card at the top shows each job with Stop; switching between Renamer, Tag editor, History and Guide never interrupts it. Only one job runs per folder or ZIP at a time, a second one on the same source is refused.
- **Parallel but safe.** Every target name is fixed when the plan is built (numbers, tags and clash suffixes included), so running steps at the same time cannot change them. A step waits for any earlier step that touches the same path, a parent folder, or (for folder renames) anything inside the folder. Folders and ZIPs use a limit suited to the source (6 for browser folders, 2 for Android folders, 1 for ZIP and imports). `tests/parallel.test.mjs` checks that parallel results equal sequential ones on random trees, including swaps, failures, Stop and undo.
- **Tag saves** run up to 3 files at once in Web Workers, with a memory budget for large files. Each file is saved from its own snapshot of the edits.
- **Staying alive.** The browser version holds a Web Lock and a screen wake lock while working, warns before the tab is closed, and delays app-update reloads until jobs finish. The Android app also runs a foreground service with a progress notification, so Android does not suspend it in the background.
- **If the app is killed anyway,** the undo file records what was done. Undo restores it; Resume (History tab) renames the rest. An interrupted tag save is recovered with the backup file and Restore.

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

GitHub Actions builds a real, self-contained Android app. The web app in `public/` is bundled inside the APK with Capacitor, so it:
- opens like any installed app, with no address bar and no browser UI;
- works fully offline and does not need the Render site (Render stays useful for the web and PWA version);
- saves results such as renamed ZIPs, tag backups, CSVs and playlists to `Documents/NameTag` on the phone, where the Files app shows them, with a **Share** button for Drive, WhatsApp, email and so on.

It needs Android 7.0 or newer. No Android Studio or computer is needed, so the whole setup works from a phone browser.

**One-time setup**
1. **Create the signing key, once.** In Actions, choose "Android signing key (run once)" and press Run workflow. Download the `nametag-signing-key` artifact from the run.
2. **Add the secrets.** Copy the four values from `SECRETS.txt` into Settings → Secrets and variables → Actions → **Secrets**: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD`, `ANDROID_KEY_ALIAS`.
3. **Keep the key safe.** Store `nametag.keystore` somewhere private, because every future update must be signed with it.

**Build and install**
1. In Actions, choose "Android APK" and press Run workflow. Push a tag such as `v1.2.0` instead for a normal release.
2. Open the run summary and tap the **Install on your phone** link, which opens a GitHub Release.
3. Tap `NameTag-<version>.apk` and allow installing from your browser when Android asks.
4. Later builds install over the previous one, because each build gets a higher version code automatically.

Don't use the Artifacts download to install. It is always a `.zip`, and tapping it gives "problem parsing the package".

**How the build works:** `npx cap add android` generates the Android project, and `scripts/android/prepare.mjs` customises it with icons, splash screens, colours, storage permission, version and signing. Gradle then builds a signed APK and AAB, and the workflow verifies the signature before publishing. Nothing Android-specific is committed except `capacitor.config.json`.

**In the app**
- **Open folder uses Android's own folder picker** (Storage Access Framework), just as desktop Chrome uses its picker. Files are renamed and tags saved **in place**, including subfolders. Undo files and tag backups are written into that folder, and Restore works from them.
- **Android keeps the permission.** After you allow a folder once, reopening it from History needs no second prompt.
- **ZIPs and single files still work.** Their results are saved to `Documents/NameTag` with a Share button.
- **Tags are read from only the part of each file that holds them**, so opening an album is fast.
- **Name clashes are refused, not renamed.** If Android would rename a file to something other than asked (it adds " (1)" on a clash), NameTag undoes that single rename and reports it.
- **Some features need a connection.** MusicBrainz, cover art and lyrics lookups need internet; everything else is offline.

**Layouts:** one interface adapts to three sizes:
- **Phones** get a bottom tab bar. The Renamer has a Rules / Preview switch, so each pane gets the full screen. Tapping a song opens a full-screen tag editor. Lists fill the screen, and menus and dialogs slide up from the bottom.
- **Tablets** keep rules next to the preview, and the song list next to the editor.
- **Desktops** use wide columns.
- **Touch screens** get larger buttons and rows at every size.

The optional "Screenshots" workflow renders the app in real Chrome at phone, tablet and desktop sizes, in light and dark themes.

Upgrading from the earlier test build: that one had a different package name (`app.nametag.twa`), so uninstall it first. Otherwise you'll have two NameTag icons.

## App icon

The icon was drawn for NameTag: a name tag carrying a line of text, a highlighter-yellow edit and a text cursor, in the app's cobalt, highlighter yellow and ink colours. It is rendered from one source, `scripts/icons/icon-src.mjs`, by `npm run icons`, which produces:

- **Web:** `icon-48` to `icon-512`, `maskable-192` and `maskable-512` (full-bleed, artwork inside the 80% safe zone), `monochrome-96` and `monochrome-512`, SVG favicon plus 16 and 32 px PNGs, and the Apple touch icon.
- **Android:** legacy and round launcher icons, adaptive layers (background, foreground and monochrome for Android 13+ themed icons) at every density, and splash screens for all sizes. These are written into the generated project by `scripts/android/prepare.mjs`. There is also a 512 px Play Store icon in `store/`.

## Browser support

| Browser | Rename in place | Save tags in place | Everything else |
| --- | --- | --- | --- |
| Chrome, Edge, Opera, Brave (desktop) | Yes | Yes | Yes |
| Firefox, Safari | No: ZIP in, renamed ZIP out | No: edited files download as a ZIP | Yes |
| Android browser | No: same ZIP workflow | No: ZIP download | Yes, installable, with share-to-NameTag |
| NameTag Android app (APK) | Yes: Android's folder picker, renames in place | Yes, in place | Yes, fully offline |
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
scripts/                     stamp-version.mjs (Render build), check.mjs, icons/ (icon artwork + renderer),
                             android/prepare.mjs (customises the generated Capacitor project),
                             android/java/ (native folder plugin), screenshots.mjs
capacitor.config.json        Android app settings (app id, name, web folder)
store/                       Play Store listing icon
.github/workflows/           android.yml (APK/AAB), android-signing-key.yml (one-time key), test.yml, screenshots.yml
tests/                       renamer, portable restore, Android folders (saf), tags; fixtures/
render.yaml
```

## Licenses

App code: MIT. JSZip: MIT or GPLv3 (dual). Atkinson Hyperlegible fonts: SIL OFL 1.1 (`public/fonts/LICENSE-OFL.txt`). Icons derived from Lucide (ISC).
