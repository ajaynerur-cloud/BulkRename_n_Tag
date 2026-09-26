// Audio tag editor view: load files, multi-select editing with mixed values, tools, online lookups,
// save with a JSON backup of the previous tags, and restore from that backup.
import { h, icon, btn, clear, toast, openDialog, confirmDialog, progress, tick, menu, VirtualList, download, saveBlob, pickFiles, readFileText, renderFields } from '../core/ui.js';
import { dirname, basename, naturalCompare, debounce, formatBytes, formatDuration, formatDate, bytesToBase64, base64ToBytes, changeCase, escapeRegex } from '../core/utils.js';
import { DirRoot, MemRoot, FilesRoot, ZipRoot, support, filesFromDataTransfer } from '../core/sources.js';
import { detectRemap, mapPath, isIdentity } from '../core/remap.js';
import { remapPanel } from '../core/remap-ui.js';
import { createTagManifest, manifestFileName, parseManifest } from '../core/manifest.js';
import { addHistory, updateHistory } from '../core/history.js';
import { readTags, writeTags, AUDIO_EXT } from './index.js';
import { FIELDS, PICTURE_TYPES, GENRES, cloneModel, fieldsEqual, customEqual, picturesEqual } from './model.js';
import { compileFilenamePattern, parseFilename, suggestFilenamePatterns, autoNumber, exportCSV, importCSV, buildM3U8, COVER_NAMES, resizeImage } from './tools.js';
import { searchReleases, getRelease, matchTracks, fetchCover, fetchLyrics } from './online.js';
import { makeRule } from '../renamer/rules.js';

const OPTS_KEY = 'nametag.tagger.options';
const T = {
  el: null, mode: 'edit', root: null, rows: [], view: [], sel: new Set(), anchor: -1, filter: 'all', search: '', list: null, tab: 'main',
  opts: { id3Version: 3, id3v1: 'update', coverMax: 0 }, snapshot: null, restore: null, onSendToRenamer: null, images: [], pending: null, pendingShown: null,
};
try { Object.assign(T.opts, JSON.parse(localStorage.getItem(OPTS_KEY) || '{}')); } catch { /* ignore */ }
const saveOpts = () => { try { localStorage.setItem(OPTS_KEY, JSON.stringify(T.opts)); } catch { /* ignore */ } };

const MAIN = FIELDS.filter((f) => f.main && f.key !== 'comment');
const MORE = FIELDS.filter((f) => !f.main && f.key !== 'lyrics').concat(FIELDS.filter((f) => f.key === 'comment'));

/* ------------------------------------------------------------------ mount */
export function mountTagger(el, { onSendToRenamer } = {}) {
  T.el = el; T.onSendToRenamer = onSendToRenamer;
  el.append(
    h('div', { class: 'toolbar' },
      segmented([['edit', 'Edit'], ['restore', 'Restore']], () => T.mode, (v) => { T.mode = v; render(); }),
      h('div', { class: 'toolbar-group', id: 'tg-source' })),
    h('div', { class: 'source-line', id: 'tg-source-line' }),
    h('div', { id: 'tg-body' }),
  );
  render();
}

function segmented(options, get, set) {
  const wrap = h('div', { class: 'segment', role: 'radiogroup', 'aria-label': 'Mode' });
  const paint = () => wrap.querySelectorAll('.seg').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === get())));
  for (const [v, l] of options) wrap.append(h('button', { type: 'button', class: 'seg', role: 'radio', dataset: { v }, onclick: () => { set(v); paint(); } }, l));
  paint();
  return wrap;
}
const anchor = (b) => { b.dataset.menuAnchor = ''; return b; };

function renderSource() {
  const bar = T.el.querySelector('#tg-source');
  clear(bar);
  if (support.filePicker) bar.append(btn('Open files', () => openFiles(), { cls: 'btn-primary', ic: 'file-music' }));
  if (support.dirPicker) bar.append(btn('Open folder', () => openFolder(), { ic: 'folder-open' }));
  if (!support.filePicker) bar.append(btn('Import files', () => importFiles(false), { cls: 'btn-primary', ic: 'upload' }));
  bar.append(anchor(btn('', (e) => menu(e.currentTarget, [
    { label: 'Import files (copy)…', icon: 'upload', onClick: () => importFiles(false) },
    { label: 'Import a folder (copy)…', icon: 'folder', onClick: () => importFiles(true) },
    { label: 'Open a ZIP…', icon: 'file-archive', hint: 'Edit audio inside a ZIP and save it back', onClick: () => openZip() },
    { separator: true },
    { label: 'Reload tags from disk', icon: 'refresh-cw', disabled: !T.root, onClick: () => load() },
  ]), { ic: 'ellipsis-vertical', title: 'More sources' })));
  const line = T.el.querySelector('#tg-source-line');
  clear(line);
  if (!T.root) {
    line.append(h('span', { class: 'muted' }, support.filePicker
      ? 'Open audio files or a folder. MP3, FLAC, M4A/AAC/ALAC, OGG, Opus, WAV and AIFF are supported.'
      : 'Import audio files. Edited files come back as a ZIP download together with the tag backup.'));
    return;
  }
  const dirty = T.rows.filter((r) => r.dirty).length;
  line.append(icon(T.root.kind === 'dir' ? 'folder' : 'file-music'), h('strong', null, T.root.name),
    h('span', { class: 'pill' }, { dir: 'Folder', files: T.root.writable ? 'Files' : 'Files (copy)', mem: 'Imported copy', zip: 'ZIP archive' }[T.root.kind] || T.root.kind),
    h('span', { class: 'muted' }, `${T.rows.length} audio files`), dirty ? h('span', { class: 'pill pill-accent' }, `${dirty} unsaved`) : '');
}

/* ------------------------------------------------------------------ sources */
async function openFiles() { try { await setRoot(await FilesRoot.pick()); } catch (e) { if (e.name !== 'AbortError') toast(e.message, { type: 'error' }); } }
async function openFolder() {
  try { const r = await DirRoot.pick(); if (!(await r.verifyPermission(true))) return; await setRoot(r); } catch (e) { if (e.name !== 'AbortError') toast(e.message, { type: 'error' }); }
}
async function openZip() {
  try {
    let file; let handle = null;
    if (window.showOpenFilePicker) {
      [handle] = await window.showOpenFilePicker({ id: 'nametag-zip', types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }] });
      file = await handle.getFile();
    } else {
      [file] = await pickFiles({ accept: '.zip,application/zip', multiple: false });
      if (!file) return;
    }
    await setRoot(await ZipRoot.load(file, handle));
  } catch (e) { if (e.name !== 'AbortError') toast(`Could not open ZIP: ${e.message}`, { type: 'error' }); }
}
async function importFiles(directory) {
  const files = await pickFiles({ directory, accept: directory ? '' : 'audio/*,.mp3,.flac,.m4a,.m4b,.ogg,.oga,.opus,.wav,.aif,.aiff,.json' });
  if (files.length) await setRoot(new MemRoot(files, directory ? 'Imported folder' : 'Imported files'));
}
export async function openDropped(dt) {
  const items = [...(dt.items || [])];
  if (items.length && items[0].getAsFileSystemHandle) {
    try {
      const handles = (await Promise.all(items.map((i) => i.getAsFileSystemHandle()))).filter(Boolean);
      if (handles.length === 1 && handles[0].kind === 'directory') { await setRoot(new DirRoot(handles[0])); return; }
      if (handles.every((x) => x.kind === 'file')) {
        const list = []; for (const hd of handles) if (AUDIO_EXT.test(hd.name)) list.push({ file: await hd.getFile(), handle: hd });
        if (list.length) { await setRoot(new FilesRoot(list, 'Dropped files')); return; }
      }
    } catch { /* fall back */ }
  }
  const files = await filesFromDataTransfer(dt);
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) { await setRoot(await ZipRoot.load(files[0])); return; }
  if (files.length) await setRoot(new MemRoot(files, 'Dropped files'));
}
export async function openRestore(root, manifest) { T.mode = 'restore'; await setRoot(root, true); await loadRestore(manifest); }
export const hasUnsaved = () => T.rows.some((r) => r.dirty);

async function setRoot(root, keepMode = false) {
  if (hasUnsaved() && !(await confirmDialog('Discard unsaved tag changes?', 'You have edits that are not saved yet.', { okText: 'Discard', danger: true }))) return;
  if (root.kind === 'dir' && !(await root.verifyPermission(true))) return;
  T.root = root; T.sel.clear(); T.restore = null;
  if (!keepMode && !T.pending) T.mode = 'edit';
  await load();
  if (T.pending) {
    const pend = T.pending; T.pending = null;
    const here = (root.manifests || []).find((m) => m.name === pend.fileName);
    await loadRestore(pend.manifest, here ? here.path : null, pend.fileName);
  }
}
function pickTargetFor(manifest, fileName, how) {
  T.pending = { manifest, fileName };
  const go = { folder: openFolder, files: openFiles, zip: openZip, import: () => importFiles(true) }[how];
  Promise.resolve(go()).finally(() => { if (T.pending?.manifest === manifest) { T.pending = null; render(); } });
}

async function load() {
  const entries = await T.root.list({ recursive: true, withFiles: false });
  T.images = entries.filter((e) => !e.isDir && COVER_NAMES.test(e.name));
  const audio = entries.filter((e) => !e.isDir && AUDIO_EXT.test(e.name)).sort((a, b) => naturalCompare(dirname(a.path), dirname(b.path)) || naturalCompare(a.name, b.name));
  T.rows = audio.map((e) => ({ path: e.path, name: e.name, dir: dirname(e.path), getFile: e.getFile || (() => T.root.getFile(e.path)), model: null, orig: null, dirty: false, error: null, size: e.size }));
  T.sel.clear();
  render();
  const p = T.rows.length > 20 ? progress('Reading tags') : null;
  let done = 0;
  const worker = async () => {
    while (done < T.rows.length) {
      if (p?.cancelled) return;
      const r = T.rows[done++];
      try { const f = await r.getFile(); r.size = f.size; r.model = await readTags(f); r.orig = cloneModel(r.model); } catch (e) { r.error = e.message; }
      p?.set(done, T.rows.length, r.name);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  p?.close();
  render();
}

/* ------------------------------------------------------------------ render */
function render() {
  if (!T.el) return;
  renderSource();
  T.el.querySelectorAll('.toolbar .segment .seg').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === T.mode)));
  const body = T.el.querySelector('#tg-body');
  clear(body);
  T.list = null;
  if (T.mode === 'restore') { renderRestore(body); return; }
  body.append(
    h('div', { class: 'tagbench' },
      h('section', { class: 'tag-table', 'aria-label': 'Files' },
        h('div', { class: 'col-head' },
          h('div', { class: 'col-actions' },
            h('label', { class: 'search' }, icon('search'), h('input', { class: 'input', type: 'search', placeholder: 'Filter', value: T.search, 'aria-label': 'Filter files', oninput: (e) => { T.search = e.target.value; refreshView(); } })),
            h('select', { class: 'input input-auto', 'aria-label': 'Show', onchange: (e) => { T.filter = e.target.value; refreshView(); } },
              [['all', 'All files'], ['modified', 'Unsaved changes'], ['notitle', 'Missing title'], ['nocover', 'Missing cover'], ['notrack', 'Missing track'], ['error', 'Unreadable']].map(([v, l]) => h('option', { value: v, selected: T.filter === v }, l)))),
          h('div', { class: 'col-actions' },
            anchor(btn('Tools', (e) => toolsMenu(e.currentTarget), { ic: 'wand-sparkles', cls: 'btn-sm', disabled: !T.rows.length })),
            anchor(btn('', (e) => optionsMenu(e.currentTarget), { ic: 'settings', cls: 'btn-sm btn-ghost', title: 'Save options' })))),
        h('div', { class: 'tag-head', role: 'row' },
          h('input', { type: 'checkbox', class: 'check', id: 'tg-all', 'aria-label': 'Select all', onchange: (e) => { if (e.target.checked) T.view.forEach((i) => T.sel.add(i)); else T.sel.clear(); selectionChanged(); } }),
          h('span', null, 'File'), h('span', null, 'Title'), h('span', null, 'Artist'), h('span', null, 'Album'), h('span', null, '#'), h('span', null, 'Year')),
        h('div', { class: 'tag-list', id: 'tg-list', role: 'grid', 'aria-multiselectable': 'true' }),
        h('div', { class: 'empty', id: 'tg-empty' })),
      h('aside', { class: 'editor', id: 'tg-editor', 'aria-label': 'Tag editor' })),
    h('div', { class: 'actionbar', id: 'tg-bar' }),
  );
  T.list = new VirtualList(body.querySelector('#tg-list'), { rowHeight: () => (matchMedia('(max-width: 640px)').matches ? 58 : 40), renderRow });
  refreshView();
}

function refreshView() {
  const q = T.search.trim().toLowerCase();
  const test = {
    all: () => true, modified: (r) => r.dirty, error: (r) => !!r.error,
    notitle: (r) => r.model && !r.model.fields.title, nocover: (r) => r.model && !r.model.pictures.length, notrack: (r) => r.model && !r.model.fields.track,
  }[T.filter] || (() => true);
  T.view = [];
  T.rows.forEach((r, i) => {
    if (!test(r)) return;
    if (q) { const f = r.model?.fields || {}; if (![r.path, f.title, f.artist, f.album].some((v) => v && v.toLowerCase().includes(q))) return; }
    T.view.push(i);
  });
  T.list?.setCount(T.view.length);
  const empty = T.el.querySelector('#tg-empty');
  if (empty) {
    clear(empty); empty.hidden = !!T.view.length;
    if (!T.root) empty.append(h('div', { class: 'empty-art', 'aria-hidden': 'true' }, h('span', { class: 'tape tape-sm' }, 'drop audio here')), h('p', null, 'Open files to edit their tags. Every save writes a backup file first, so you can restore the old tags.'));
    else if (!T.rows.length) empty.append(h('p', null, 'No supported audio files were found here.'));
    else empty.append(h('p', null, 'No files match the filter.'));
  }
  selectionChanged(false);
}

function renderRow(el, vi) {
  const i = T.view[vi]; const r = T.rows[i];
  if (!r) return;
  const f = r.model?.fields || {};
  const sel = T.sel.has(i);
  el.className = `vrow trow ${sel ? 'is-sel' : ''} ${r.dirty ? 'is-dirty' : ''} ${r.error ? 'is-error' : ''}`;
  el.setAttribute('aria-selected', String(sel));
  el.onclick = (e) => { if (e.target.closest('input')) return; clickRow(vi, e); };
  el.append(
    h('input', { type: 'checkbox', class: 'check', checked: sel, 'aria-label': `Select ${r.name}`, onchange: (e) => { if (e.target.checked) T.sel.add(i); else T.sel.delete(i); T.anchor = vi; selectionChanged(); } }),
    h('span', { class: 'tcell tfile mono', title: r.error ? `Cannot read: ${r.error}` : r.path }, r.dirty ? h('span', { class: 'dot', title: 'Unsaved changes' }) : null, r.error ? icon('triangle-alert') : null, r.name,
      h('span', { class: 'tsub' }, [f.artist, f.title].filter(Boolean).join(' – '))),
    h('span', { class: 'tcell' }, f.title || ''), h('span', { class: 'tcell' }, f.artist || ''), h('span', { class: 'tcell' }, f.album || ''),
    h('span', { class: 'tcell num' }, f.track || ''), h('span', { class: 'tcell num' }, (f.year || '').slice(0, 4)),
  );
}

function clickRow(vi, e) {
  const i = T.view[vi];
  if (e.shiftKey && T.anchor >= 0) {
    const [a, b] = [Math.min(T.anchor, vi), Math.max(T.anchor, vi)];
    if (!e.ctrlKey && !e.metaKey) T.sel.clear();
    for (let k = a; k <= b; k++) T.sel.add(T.view[k]);
  } else if (e.ctrlKey || e.metaKey) { if (T.sel.has(i)) T.sel.delete(i); else T.sel.add(i); T.anchor = vi; }
  else { T.sel.clear(); T.sel.add(i); T.anchor = vi; }
  selectionChanged();
}

function selectionChanged(rerender = true) {
  if (rerender) T.list?.repaint();
  const all = T.el.querySelector('#tg-all');
  if (all) { all.checked = T.view.length > 0 && T.view.every((i) => T.sel.has(i)); all.indeterminate = !all.checked && T.sel.size > 0; }
  renderEditor();
  paintBar();
}

const selected = () => [...T.sel].sort((a, b) => a - b).map((i) => T.rows[i]).filter((r) => r.model);
const targets = () => (T.sel.size ? selected() : T.rows.filter((r) => r.model));

function markDirty(rows) {
  for (const r of rows) r.dirty = !(fieldsEqual(r.model.fields, r.orig.fields) && customEqual(r.model.custom, r.orig.custom) && picturesEqual(r.model.pictures, r.orig.pictures));
  T.list?.repaint();
  paintBar();
  renderSource();
}

/* ------------------------------------------------------------------ editor */
function renderEditor() {
  const ed = T.el.querySelector('#tg-editor');
  if (!ed) return;
  clear(ed);
  const rows = selected();
  if (!rows.length) {
    ed.append(h('div', { class: 'panel-head' }, icon('tag'), h('h2', null, 'Tags')),
      h('p', { class: 'muted' }, T.rows.length ? 'Select one or more files. With several selected, fields that differ show ‹keep›: leave them and each file keeps its own value.' : 'Open some audio files first.'));
    return;
  }
  T.snapshot = new Map(rows.map((r) => [r, { ...r.model.fields }]));
  const tabs = [['main', 'Main'], ['more', 'More'], ['cover', 'Cover'], ['lyrics', 'Lyrics'], ['custom', 'Custom'], ['info', 'Info']];
  ed.append(
    h('div', { class: 'panel-head' }, icon('tag'), h('h2', null, rows.length === 1 ? rows[0].name : `${rows.length} files selected`)),
    h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, l]) => h('button', { type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(T.tab === k), onclick: () => { T.tab = k; renderEditor(); } }, l))),
  );
  const pane = h('div', { class: 'tab-pane', role: 'tabpanel' });
  ed.append(pane);
  if (T.tab === 'main') pane.append(fieldGrid(rows, MAIN));
  else if (T.tab === 'more') pane.append(fieldGrid(rows, MORE));
  else if (T.tab === 'cover') coverPane(pane, rows);
  else if (T.tab === 'lyrics') lyricsPane(pane, rows);
  else if (T.tab === 'custom') customPane(pane, rows);
  else infoPane(pane, rows);
  ed.append(h('div', { class: 'btn-row editor-foot' },
    btn('Revert selected', () => { for (const r of rows) r.model = cloneModel(r.orig); markDirty(rows); renderEditor(); }, { cls: 'btn-sm btn-ghost', ic: 'undo-2', disabled: !rows.some((r) => r.dirty) })));
}

function fieldGrid(rows, fields) {
  const grid = h('div', { class: 'tag-grid' });
  for (const f of fields) {
    const vals = new Set(rows.map((r) => r.model.fields[f.key] ?? ''));
    const mixed = vals.size > 1;
    const id = `tf-${f.key}`;
    const input = f.multiline
      ? h('textarea', { id, class: 'input', rows: 3, placeholder: mixed ? '‹keep›' : '' })
      : h('input', { id, class: `input ${f.numeric ? 'input-num' : ''}`, placeholder: mixed ? '‹keep›' : '', inputmode: f.numeric ? 'numeric' : null, list: f.key === 'genre' ? 'genre-list' : null, autocomplete: 'off' });
    input.value = mixed ? '' : [...vals][0];
    if (mixed) input.classList.add('is-mixed');
    const apply = () => {
      const v = input.value;
      for (const r of rows) {
        if (mixed && v === '') { const old = T.snapshot.get(r)?.[f.key]; if (old == null) delete r.model.fields[f.key]; else r.model.fields[f.key] = old; } else if (v === '') delete r.model.fields[f.key]; else r.model.fields[f.key] = v;
      }
      markDirty(rows);
    };
    input.addEventListener('input', debounce(apply, 200));
    grid.append(h('label', { class: `field ${f.short ? 'field-short' : ''} ${f.multiline ? 'field-wide' : ''}`, for: id }, h('span', { class: 'field-label' }, f.label), input));
  }
  if (!document.getElementById('genre-list')) document.body.append(h('datalist', { id: 'genre-list' }, GENRES.map((g) => h('option', { value: g }))));
  return grid;
}

const urls = [];
function coverPane(pane, rows) {
  urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const first = rows[0].model.pictures;
  const same = rows.every((r) => picturesEqual(r.model.pictures, first));
  const gallery = h('div', { class: 'covers' });
  if (!same) gallery.append(h('p', { class: 'muted' }, 'The selected files have different covers. Adding a cover replaces the front cover in all of them.'));
  else if (!first.length) gallery.append(h('div', { class: 'cover-empty' }, icon('image'), h('span', null, 'No cover')));
  else for (const [pi, p] of first.entries()) {
    const u = URL.createObjectURL(new Blob([p.data], { type: p.mime })); urls.push(u);
    gallery.append(h('figure', { class: 'cover' }, h('img', { src: u, alt: PICTURE_TYPES[p.type] || 'Picture' }),
      h('figcaption', null, `${PICTURE_TYPES[p.type] || 'Picture'}, ${formatBytes(p.data.length)}`,
        h('button', { type: 'button', class: 'btn-icon', title: 'Save image', 'aria-label': 'Save image', onclick: () => download(new Blob([p.data], { type: p.mime }), `cover.${p.mime.includes('png') ? 'png' : 'jpg'}`) }, icon('download')),
        h('button', { type: 'button', class: 'btn-icon', title: 'Remove image', 'aria-label': 'Remove image', onclick: () => { for (const r of rows) r.model.pictures = r.model.pictures.filter((_, k) => k !== pi); markDirty(rows); renderEditor(); } }, icon('trash-2')))));
  }
  pane.append(gallery, h('div', { class: 'btn-row' },
    btn('Choose image…', async () => {
      const [f] = await pickFiles({ accept: 'image/jpeg,image/png,image/webp', multiple: false });
      if (f) await setCover(rows, new Uint8Array(await f.arrayBuffer()), f.type || 'image/jpeg');
    }, { ic: 'image-plus', cls: 'btn-sm' }),
    T.images.length ? btn('Use folder image', () => coverFromFolder(rows), { ic: 'folder', cls: 'btn-sm' }) : null,
    btn('Remove all', () => { for (const r of rows) r.model.pictures = []; markDirty(rows); renderEditor(); }, { ic: 'trash-2', cls: 'btn-sm btn-ghost', disabled: !rows.some((r) => r.model.pictures.length) })),
  h('p', { class: 'field-help' }, 'Tip: drop an image onto this panel. Online covers (Cover Art Archive) can be added from Tools, then MusicBrainz.'));
  pane.ondragover = (e) => e.preventDefault();
  pane.ondrop = async (e) => { e.preventDefault(); e.stopPropagation(); const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/')); if (f) await setCover(rows, new Uint8Array(await f.arrayBuffer()), f.type); };
}

async function setCover(rows, data, mime) {
  if (T.opts.coverMax && typeof createImageBitmap !== 'undefined') {
    try { const r = await resizeImage(data, mime, T.opts.coverMax); if (r.data.length < data.length) { data = r.data; mime = r.mime; } } catch { /* keep original */ }
  }
  if (!/^image\/(jpeg|png)$/.test(mime)) {
    try { const r = await resizeImage(data, mime, 4096); data = r.data; mime = r.mime; } catch { toast('Use a JPEG or PNG image.', { type: 'error' }); return; }
  }
  for (const r of rows) r.model.pictures = [{ type: 3, mime, desc: '', data }, ...r.model.pictures.filter((p) => p.type !== 3)];
  markDirty(rows); renderEditor();
  toast(`Cover set on ${rows.length} file${rows.length === 1 ? '' : 's'}.`, { type: 'success' });
}

async function coverFromFolder(rows) {
  let n = 0;
  const byDir = new Map(); for (const img of T.images) if (!byDir.has(dirname(img.path))) byDir.set(dirname(img.path), img);
  for (const r of rows) {
    const img = byDir.get(r.dir); if (!img) continue;
    const f = await (img.getFile ? img.getFile() : T.root.getFile(img.path));
    let data = new Uint8Array(await f.arrayBuffer()); let mime = /png$/i.test(img.name) ? 'image/png' : 'image/jpeg';
    if (T.opts.coverMax) { try { const x = await resizeImage(data, mime, T.opts.coverMax); if (x.data.length < data.length) { data = x.data; mime = x.mime; } } catch { /* ignore */ } }
    r.model.pictures = [{ type: 3, mime, desc: '', data }, ...r.model.pictures.filter((p) => p.type !== 3)]; n++;
  }
  markDirty(rows); renderEditor();
  toast(n ? `Added folder covers to ${n} file${n === 1 ? '' : 's'}.` : 'No cover.jpg / folder.jpg next to these files.', { type: n ? 'success' : 'warn' });
}

function lyricsPane(pane, rows) {
  pane.append(fieldGrid(rows, FIELDS.filter((f) => f.key === 'lyrics')));
  const ta = pane.querySelector('textarea'); if (ta) ta.rows = 14;
  if (rows.length === 1) {
    const r = rows[0];
    pane.append(h('div', { class: 'btn-row' }, btn('Find lyrics online', async () => {
      const f = r.model.fields;
      try {
        const res = await fetchLyrics({ artist: f.artist, title: f.title, album: f.album, duration: r.model.props.duration });
        if (!res || (!res.plain && !res.synced)) { toast(res?.instrumental ? 'LRCLIB lists this track as instrumental.' : 'No lyrics found on LRCLIB.', { type: 'warn' }); return; }
        const choice = res.synced && res.plain ? await openDialog({ title: 'Lyrics found', body: 'LRCLIB has plain and time-synced lyrics. Which should be saved?', actions: [{ label: 'Cancel', value: null }, { label: 'Synced (LRC)', value: 'synced' }, { label: 'Plain', value: 'plain', primary: true }] }) : (res.plain ? 'plain' : 'synced');
        if (!choice) return;
        r.model.fields.lyrics = res[choice]; markDirty([r]); renderEditor();
      } catch (e) { toast(e.message, { type: 'error' }); }
    }, { ic: 'mic-vocal', cls: 'btn-sm' })), h('p', { class: 'field-help' }, 'Lyrics come from LRCLIB (lrclib.net), a free community database. Artist and title must be filled in.'));
  }
}

function customPane(pane, rows) {
  if (rows.length !== 1) { pane.append(h('p', { class: 'muted' }, 'Custom fields can be edited one file at a time.')); return; }
  const r = rows[0];
  const list = h('div', { class: 'custom-list' });
  const paint = () => {
    clear(list);
    r.model.custom.forEach((c, i) => {
      const k = h('input', { class: 'input mono', placeholder: 'KEY', 'aria-label': 'Field name' }); k.value = c.key;
      const v = h('input', { class: 'input', placeholder: 'value', 'aria-label': 'Value' }); v.value = c.value;
      k.oninput = () => { c.key = k.value.trim(); markDirty([r]); };
      v.oninput = () => { c.value = v.value; markDirty([r]); };
      list.append(h('div', { class: 'custom-row' }, k, v, h('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Remove field', onclick: () => { r.model.custom.splice(i, 1); markDirty([r]); paint(); } }, icon('trash-2'))));
    });
    if (!r.model.custom.length) list.append(h('p', { class: 'muted' }, 'No custom fields. MusicBrainz IDs, ReplayGain and similar values appear here.'));
  };
  paint();
  pane.append(list, h('div', { class: 'btn-row' }, btn('Add field', () => { r.model.custom.push({ key: 'CUSTOM', value: '' }); paint(); }, { ic: 'plus', cls: 'btn-sm' })));
}

function infoPane(pane, rows) {
  if (rows.length !== 1) {
    const size = rows.reduce((s, r) => s + (r.size || 0), 0); const dur = rows.reduce((s, r) => s + (r.model.props.duration || 0), 0);
    pane.append(h('dl', { class: 'info' }, h('dt', null, 'Files'), h('dd', null, String(rows.length)), h('dt', null, 'Total size'), h('dd', null, formatBytes(size)), h('dt', null, 'Total length'), h('dd', null, formatDuration(dur))));
    return;
  }
  const r = rows[0]; const p = r.model.props;
  const rowsDl = [['Path', r.path], ['Format', `${r.model.format}${p.codec ? `, ${p.codec}` : ''}`], ['Length', formatDuration(p.duration)], ['Bitrate', p.bitrate ? `${p.bitrate} kbps${p.vbr ? ' (VBR)' : ''}` : ''],
    ['Sample rate', p.sampleRate ? `${p.sampleRate} Hz` : ''], ['Channels', p.channels || ''], ['Bits', p.bitsPerSample || ''], ['Tag', p.id3 ? `ID3v${p.id3}${p.id3v1 ? ' + ID3v1' : ''}` : ''], ['Encoder', p.encoder || ''], ['Size', formatBytes(r.size)]];
  pane.append(h('dl', { class: 'info' }, rowsDl.filter(([, v]) => v !== '' && v != null).flatMap(([k, v]) => [h('dt', null, k), h('dd', { class: k === 'Path' ? 'mono' : '' }, String(v))])));
  if (r.model.notes?.length) pane.append(h('ul', { class: 'findings' }, r.model.notes.map((n) => h('li', { class: 'f-info' }, icon('info'), h('span', null, n)))));
}

/* ------------------------------------------------------------------ bar + options */
function paintBar() {
  const bar = T.el.querySelector('#tg-bar');
  if (!bar) return;
  clear(bar);
  const dirty = T.rows.filter((r) => r.dirty).length;
  const where = !T.root ? '' : T.root.kind === 'dir' ? `in "${T.root.name}"` : T.root.kind === 'files' && T.root.writable ? 'as a download' : 'inside the ZIP';
  bar.append(
    h('div', { class: 'bar-info' },
      h('p', { class: 'bar-count' }, T.root ? h('strong', null, `${dirty} file${dirty === 1 ? '' : 's'}`) : 'No files', T.root ? ' with unsaved changes' : ''),
      h('p', { class: 'bar-sub muted' }, T.sel.size ? `${T.sel.size} selected. ` : '', dirty ? `A backup of the old tags will be saved ${where}.` : '')),
    btn(T.root && (T.root.kind === 'dir' || T.root.writable) ? `Save ${dirty || ''}`.trim() : 'Save as ZIP', () => save(), { cls: 'btn-primary btn-lg', ic: 'save', disabled: !dirty }),
  );
}

function optionsMenu(a) {
  const o = T.opts;
  const set = (k, v) => () => { o[k] = v; saveOpts(); toast('Saved option.'); };
  menu(a, [
    { header: 'MP3, WAV and AIFF tags' },
    { label: `ID3v2.3 (widest support)${o.id3Version === 3 ? '  ✓' : ''}`, onClick: set('id3Version', 3) },
    { label: `ID3v2.4 (UTF-8)${o.id3Version === 4 ? '  ✓' : ''}`, onClick: set('id3Version', 4) },
    { header: 'Old ID3v1 tag' },
    ...[['update', 'Update if present'], ['always', 'Always write'], ['keep', 'Leave as is'], ['remove', 'Remove']].map(([v, l]) => ({ label: `${l}${o.id3v1 === v ? '  ✓' : ''}`, onClick: set('id3v1', v) })),
    { header: 'Covers you add' },
    ...[[0, 'Keep original size'], [600, 'Shrink to 600 px'], [1000, 'Shrink to 1000 px'], [1400, 'Shrink to 1400 px']].map(([v, l]) => ({ label: `${l}${o.coverMax === v ? '  ✓' : ''}`, onClick: set('coverMax', v) })),
  ]);
}

/* ------------------------------------------------------------------ tools */
function toolsMenu(a) {
  const n = T.sel.size;
  const scope = n ? `${n} selected` : 'all files';
  menu(a, [
    { header: `Applies to ${scope}` },
    { label: 'Filename to tags…', icon: 'arrow-left-right', onClick: () => filenameToTags() },
    { label: 'Auto-number tracks…', icon: 'list-ordered', onClick: () => autoNumberDialog() },
    { label: 'Change case…', icon: 'type', onClick: () => caseDialog() },
    { label: 'Find and replace…', icon: 'replace', onClick: () => replaceDialog() },
    { label: 'Clean up spacing', icon: 'sparkles', onClick: () => cleanupTags() },
    { label: 'Remove tags…', icon: 'trash-2', onClick: () => removeDialog() },
    { label: 'Covers from folder images', icon: 'image', disabled: !T.images.length, onClick: () => coverFromFolder(targets()) },
    { separator: true },
    { label: 'Look up album on MusicBrainz…', icon: 'globe', onClick: () => mbDialog() },
    { separator: true },
    { label: 'Rename files from tags', icon: 'text-cursor-input', disabled: !T.root || T.root.kind === 'files', hint: 'Opens the renamer with {track:2} - {title}', onClick: () => sendToRenamer() },
    { label: 'Export CSV', icon: 'file-text', onClick: () => download(new Blob([exportCSV(targets())], { type: 'text/csv' }), 'nametag-tags.csv') },
    { label: 'Import CSV…', icon: 'upload', onClick: () => csvImport() },
    { label: 'Export playlist (M3U8)', icon: 'list-music', onClick: () => download(new Blob([buildM3U8(targets())], { type: 'audio/x-mpegurl' }), `${T.root?.name || 'playlist'}.m3u8`) },
  ]);
}

function applyFields(map) { // Map row -> {field: value}
  const touched = [];
  for (const [r, vals] of map) { for (const [k, v] of Object.entries(vals)) { if (v === '' || v == null) delete r.model.fields[k]; else r.model.fields[k] = String(v); } touched.push(r); }
  markDirty(touched); renderEditor();
  return touched.length;
}

async function filenameToTags() {
  const rows = targets();
  const sugg = suggestFilenamePatterns(rows.map((r) => r.path));
  const values = { pattern: sugg[0] || '%artist% - %title%' };
  const preview = h('div', { class: 'mini-preview mono' });
  const paint = () => {
    clear(preview);
    let c; try { c = compileFilenamePattern(values.pattern); } catch (e) { preview.append(h('p', { class: 'bad' }, e.message)); return; }
    for (const r of rows.slice(0, 6)) { const res = parseFilename(r.path, c); preview.append(h('p', null, h('span', { class: 'ex-old' }, basename(r.path)), h('span', { class: 'ex-new' }, res ? Object.entries(res).map(([k, v]) => `${k}: ${v}`).join(', ') : 'no match'))); }
  };
  const body = h('div', null,
    renderFields([{ key: 'pattern', type: 'text', label: 'Pattern', mono: true, help: 'Use %artist% %title% %album% %track% %disc% %year% %genre% %dummy% (ignored). Include folders with /, e.g. %artist%/%album%/%track% - %title%.' }], values, paint),
    h('div', { class: 'chips' }, sugg.map((s) => h('button', { type: 'button', class: 'chip mono', onclick: () => { values.pattern = s; body.querySelector('input').value = s; paint(); } }, s))),
    preview);
  paint();
  const ok = await openDialog({ title: 'Filename to tags', body, wide: true, actions: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, primary: true }] });
  if (!ok) return;
  const c = compileFilenamePattern(values.pattern); const map = new Map();
  for (const r of rows) { const res = parseFilename(r.path, c); if (res) map.set(r, res); }
  toast(`Filled tags for ${applyFields(map)} of ${rows.length} files.`, { type: 'success' });
}

async function autoNumberDialog() {
  const rows = targets();
  const v = { perFolder: true, start: 1, setTotal: true, discFromFolder: false, sortBy: 'list' };
  const ok = await openDialog({ title: 'Auto-number tracks', body: renderFields([
    { key: 'sortBy', type: 'segment', label: 'Order', options: [['list', 'As listed'], ['name', 'By file name']] },
    { key: 'start', type: 'number', label: 'Start at', min: 0 },
    { key: 'perFolder', type: 'checkbox', label: 'Restart in every folder' },
    { key: 'setTotal', type: 'checkbox', label: 'Also set total tracks' },
    { key: 'discFromFolder', type: 'checkbox', label: 'Set disc number from folders (CD1, Disc 2 …)' },
  ], v, () => {}), actions: [{ label: 'Cancel', value: false }, { label: 'Number', value: true, primary: true }] });
  if (!ok) return;
  const res = autoNumber(rows, { ...v, start: Number(v.start) || 1 });
  applyFields(new Map(rows.map((r) => [r, res.get(r.path) || {}])));
}

async function caseDialog() {
  const v = { fields: 'title,artist,album,albumartist', mode: 'title' };
  const ok = await openDialog({ title: 'Change case', body: renderFields([
    { key: 'mode', type: 'select', label: 'Case', options: [['title', 'Title Case'], ['sentence', 'Sentence case'], ['lower', 'lowercase'], ['upper', 'UPPERCASE'], ['capitalize', 'Capitalize first letters']] },
    { key: 'fields', type: 'text', label: 'Fields (comma separated)', mono: true },
  ], v, () => {}), actions: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, primary: true }] });
  if (!ok) return;
  const keys = v.fields.split(/[\s,]+/).filter(Boolean); const map = new Map();
  for (const r of targets()) { const o = {}; for (const k of keys) if (r.model.fields[k]) o[k] = changeCase(r.model.fields[k], v.mode, { exceptions: ['DJ', 'feat.', 'ft.', 'vs.', 'MC'] }); map.set(r, o); }
  applyFields(map);
}

async function replaceDialog() {
  const v = { field: '*', find: '', with: '', regex: false, matchCase: false };
  const ok = await openDialog({ title: 'Find and replace in tags', body: renderFields([
    { key: 'field', type: 'select', label: 'Field', options: [['*', 'All text fields'], ...FIELDS.map((f) => [f.key, f.label])] },
    { key: 'find', type: 'text', label: 'Find', mono: true }, { key: 'with', type: 'text', label: 'Replace with', mono: true },
    { type: 'row', fields: [{ key: 'regex', type: 'checkbox', label: 'Regular expression' }, { key: 'matchCase', type: 'checkbox', label: 'Match case' }] },
  ], v, () => {}), actions: [{ label: 'Cancel', value: false }, { label: 'Replace', value: true, primary: true }] });
  if (!ok || !v.find) return;
  let re; try { re = new RegExp(v.regex ? v.find : escapeRegex(v.find), v.matchCase ? 'g' : 'gi'); } catch (e) { toast(e.message, { type: 'error' }); return; }
  const map = new Map(); let hits = 0;
  for (const r of targets()) {
    const o = {};
    for (const k of v.field === '*' ? Object.keys(r.model.fields) : [v.field]) { const cur = r.model.fields[k]; if (cur == null) continue; const nv = cur.replace(re, v.with); if (nv !== cur) { o[k] = nv; hits++; } }
    map.set(r, o);
  }
  applyFields(map); toast(`${hits} value${hits === 1 ? '' : 's'} changed.`);
}

function cleanupTags() {
  const map = new Map();
  for (const r of targets()) {
    const o = {};
    for (const [k, v] of Object.entries(r.model.fields)) { if (k === 'lyrics' || k === 'comment') continue; const nv = v.replace(/_/g, ' ').replace(/\s{2,}/g, ' ').replace(/\s+([,.)\]])/g, '$1').replace(/([([])\s+/g, '$1').trim(); if (nv !== v) o[k] = nv; }
    map.set(r, o);
  }
  applyFields(map); toast('Spacing cleaned up.');
}

async function removeDialog() {
  const v = { what: 'fields', list: 'comment, encodedby' };
  const ok = await openDialog({ title: 'Remove tags', body: renderFields([
    { key: 'what', type: 'select', label: 'Remove', options: [['fields', 'These fields'], ['all', 'All text fields'], ['covers', 'All pictures'], ['custom', 'All custom fields'], ['everything', 'Everything']] },
    { key: 'list', type: 'text', label: 'Fields', mono: true, showIf: (x) => x.what === 'fields' },
  ], v, () => {}), actions: [{ label: 'Cancel', value: false }, { label: 'Remove', value: true, primary: true, cls: 'btn-danger' }] });
  if (!ok) return;
  const rows = targets(); const keys = v.list.split(/[\s,]+/).filter(Boolean);
  for (const r of rows) {
    if (v.what === 'fields') for (const k of keys) delete r.model.fields[k];
    if (v.what === 'all' || v.what === 'everything') r.model.fields = {};
    if (v.what === 'covers' || v.what === 'everything') r.model.pictures = [];
    if (v.what === 'custom' || v.what === 'everything') r.model.custom = [];
  }
  markDirty(rows); renderEditor();
}

async function csvImport() {
  const [f] = await pickFiles({ accept: '.csv,text/csv', multiple: false });
  if (!f) return;
  try {
    const data = importCSV(await readFileText(f)); const map = new Map();
    for (const r of T.rows) if (r.model) { const v = data.get(r.path) || data.get(r.name); if (v) map.set(r, v); }
    toast(`Updated ${applyFields(map)} files from CSV.`, { type: 'success' });
  } catch (e) { toast(e.message, { type: 'error' }); }
}

function sendToRenamer() {
  if (hasUnsaved()) { toast('Save your tag changes first, so the renamer reads the new values.', { type: 'warn' }); return; }
  T.onSendToRenamer?.(T.root, [makeRule('template', { tpl: '{track:2} - {title}' }), makeRule('cleanup', { underscores: false })]);
}

async function mbDialog() {
  const rows = targets();
  const f0 = rows[0]?.model.fields || {};
  const v = { artist: f0.albumartist || f0.artist || '', album: f0.album || '' };
  const results = h('div', { class: 'mb-results' });
  let chosen = null;
  const search = async () => {
    clear(results).append(h('p', { class: 'muted' }, 'Searching MusicBrainz…'));
    try {
      const list = await searchReleases({ artist: v.artist, album: v.album });
      clear(results);
      if (!list.length) results.append(h('p', null, 'No releases found.'));
      for (const r of list) {
        results.append(h('label', { class: 'mb-item' }, h('input', { type: 'radio', name: 'mb', onchange: () => { chosen = r; } }),
          h('span', null, h('strong', null, r.title), ` by ${r.artist}`, h('small', { class: 'muted' }, [r.date, r.country, r.format, r.label, `${r.tracks} tracks`].filter(Boolean).join(', ')))));
      }
    } catch (e) { clear(results).append(h('p', { class: 'bad' }, e.message)); }
  };
  const opts = { cover: true };
  const body = h('div', null, renderFields([{ type: 'row', fields: [{ key: 'artist', type: 'text', label: 'Artist' }, { key: 'album', type: 'text', label: 'Album' }] }], v, () => {}),
    h('div', { class: 'btn-row' }, btn('Search', search, { ic: 'search', cls: 'btn-sm' })), results,
    renderFields([{ key: 'cover', type: 'checkbox', label: 'Also try to add the front cover from Cover Art Archive' }], opts, () => {}),
    h('p', { class: 'field-help' }, `Tracks are matched to the ${rows.length} file(s) by track number, then by title and length. Data from MusicBrainz (CC0).`));
  const ok = await openDialog({ title: 'Look up on MusicBrainz', body, wide: true, onOpen: () => { if (v.artist || v.album) search(); }, actions: [{ label: 'Cancel', value: false }, { label: 'Apply release', value: true, primary: true }], validate: () => !!chosen || (toast('Pick a release first.', { type: 'warn' }), false) });
  if (!ok || !chosen) return;
  const p = progress('Fetching release', { cancellable: false });
  try {
    const rel = await getRelease(chosen.id);
    const match = matchTracks(rows.map((r) => ({ path: r.path, name: r.name, fields: r.model.fields, duration: r.model.props.duration })), rel.tracks);
    const map = new Map();
    for (const r of rows) {
      const t = match.get(r.path); if (!t) continue;
      map.set(r, { album: rel.album, albumartist: rel.albumartist, year: rel.year, publisher: rel.publisher, genre: rel.genre || r.model.fields.genre, title: t.title, artist: t.artist, track: t.track, tracktotal: t.tracktotal, disc: t.disc, disctotal: t.disctotal, isrc: t.isrc || r.model.fields.isrc });
      const custom = r.model.custom.filter((c) => c.key !== 'MUSICBRAINZ_ALBUMID'); custom.push({ key: 'MUSICBRAINZ_ALBUMID', value: rel.id }); r.model.custom = custom;
    }
    applyFields(map);
    if (opts.cover && rel.coverFront) {
      p.set(0, 0, 'Downloading cover…');
      try { const c = await fetchCover(rel.coverFront.replace('front-1200', 'front-500')); await setCover(rows.filter((r) => map.has(r)), c.data, c.mime); } catch {
        toast('The cover could not be downloaded automatically (the image host blocks it). Open it, save it, then drop it on the Cover tab.', { type: 'warn', timeout: 12000, action: { label: 'Open cover', onClick: () => window.open(rel.coverFront, '_blank', 'noopener') } });
      }
    }
    toast(`Applied "${rel.album}" to ${map.size} file${map.size === 1 ? '' : 's'}. Review, then save.`, { type: 'success' });
  } catch (e) { toast(e.message, { type: 'error' }); }
  p.close();
}

/* ------------------------------------------------------------------ save */
const picsToJSON = (pics) => pics.map((p) => ({ type: p.type, mime: p.mime, desc: p.desc || '', data: bytesToBase64(p.data) }));
const picsFromJSON = (pics) => pics.map((p) => ({ type: p.type, mime: p.mime, desc: p.desc || '', data: base64ToBytes(p.data) }));

async function save() {
  const rows = T.rows.filter((r) => r.dirty);
  if (!rows.length) return;
  const root = T.root;
  if (root.kind === 'dir' && !(await root.verifyPermission(true))) return;
  const files = rows.map((r) => {
    const picsChanged = !picturesEqual(r.model.pictures, r.orig.pictures);
    return { path: r.path, format: r.model.format, before: { fields: r.orig.fields, custom: r.orig.custom, pictures: picsChanged ? picsToJSON(r.orig.pictures) : null }, after: { fields: r.model.fields, custom: r.model.custom, pictures: picsChanged ? `${r.model.pictures.length} picture(s)` : null } };
  });
  const manifest = createTagManifest({ root: root.name, source: root.kind, files, options: { ...T.opts } });
  const mName = manifestFileName('tags');
  const inZip = root.kind === 'mem' || (root.kind === 'files' && !root.writable);
  const zip = inZip ? new globalThis.JSZip() : null;
  const writeManifest = async () => {
    const text = JSON.stringify(manifest, null, 2);
    if (root.kind === 'dir' || root.kind === 'zip') await root.writeText(mName, text);
    else if (zip) zip.file(mName, text);
  };
  try { await writeManifest(); } catch (e) { if (!(await confirmDialog('Could not write the backup file', `${e.message}. Continue? The backup stays in History and is offered as a download.`))) return; }
  if (root.kind === 'files' && root.writable) await saveBlob(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }), mName, { description: 'NameTag backup', accept: { 'application/json': ['.json'] } });
  const p = progress('Saving tags');
  let done = 0; const errors = [];
  for (const r of rows) {
    if (p.cancelled) break;
    try {
      const file = await r.getFile();
      const { blob } = await writeTags(file, r.model, { id3Version: T.opts.id3Version, id3v1: T.opts.id3v1 });
      if (zip) zip.file(r.path, blob); else await root.writeFile(r.path, blob);
      if (root.kind === 'mem') await root.writeFile(r.path, blob);
      r.orig = cloneModel(r.model); r.dirty = false; done++;
    } catch (e) { errors.push(`${r.name}: ${e.message}`); }
    p.set(done + errors.length, rows.length, r.name);
    await tick();
  }
  manifest.status = errors.length || done < rows.length ? 'partial' : 'complete';
  manifest.completed = done;
  if (errors.length) manifest.errors = errors;
  try { await writeManifest(); } catch { /* ignore */ }
  if (root.kind === 'zip') { p.set(0, 100, 'Building ZIP…'); try { await root.finalize({ onProgress: (pc) => p.set(Math.round(pc), 100, 'Building ZIP…'), download }); } catch (e) { errors.push(`ZIP: ${e.message}`); } }
  if (zip) { p.set(0, 100, 'Building ZIP…'); await download(await zip.generateAsync({ type: 'blob' }, (m) => p.set(Math.round(m.percent), 100, 'Building ZIP…')), `${root.name}-tagged.zip`); }
  p.close();
  await addHistory({ id: manifest.id, type: 'tags', createdAt: manifest.createdAt, rootName: root.name, source: root.kind, manifestName: mName, manifest, handle: root.handle || null, status: manifest.status });
  if (errors.length) openDialog({ title: `${errors.length} file(s) could not be saved`, body: h('ul', { class: 'mono small' }, errors.map((e) => h('li', null, e))) });
  else toast(`Saved tags in ${done} file${done === 1 ? '' : 's'}.${zip ? ' Downloaded as ZIP.' : root.kind === 'zip' ? ' The ZIP was updated.' : ''}`, { type: 'success' });
  refreshView(); renderSource();
}

/* ------------------------------------------------------------------ restore */
function renderRestore(body) {
  const wrap = h('div', { class: 'restore' });
  body.append(wrap);
  const openBackup = async () => {
    const [f] = await pickFiles({ accept: '.json,application/json', multiple: false });
    if (!f) return null;
    try { const m = parseManifest(await readFileText(f)); if (m.type !== 'tags') throw new Error('This is a rename undo file. Open it in the Renamer.'); return { manifest: m, fileName: f.name }; } catch (e) { toast(e.message, { type: 'error' }); return null; }
  };
  const targets = (manifest, fileName) => [
    support.dirPicker ? btn('Open folder', () => pickTargetFor(manifest, fileName, 'folder'), { ic: 'folder-open', cls: 'btn-primary' }) : null,
    support.filePicker ? btn('Open files', () => pickTargetFor(manifest, fileName, 'files'), { ic: 'file-music' }) : null,
    btn('Open ZIP', () => pickTargetFor(manifest, fileName, 'zip'), { ic: 'file-archive' }),
    btn('Import a folder', () => pickTargetFor(manifest, fileName, 'import'), { ic: 'upload' }),
  ];
  if (!T.root) {
    const pend = T.pendingShown;
    wrap.append(h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, icon('undo-2'), h('h2', null, 'Restore previous tags')),
      pend
        ? h('p', null, 'Backup loaded: ', h('strong', { class: 'mono' }, pend.fileName), `. It was made for "${pend.manifest.root}". Now choose where those audio files are on this computer.`)
        : h('p', null, 'Open the folder, files or ZIP that were edited; backups inside are found automatically. Got only the backup file, for example on another computer? Open it first, then choose the folder.'),
      h('div', { class: 'btn-row' },
        ...(pend ? targets(pend.manifest, pend.fileName) : [
          support.dirPicker ? btn('Open folder', () => openFolder(), { ic: 'folder-open', cls: 'btn-primary' }) : null,
          support.filePicker ? btn('Open files', () => openFiles(), { ic: 'file-music' }) : null,
          btn('Open ZIP', () => openZip(), { ic: 'file-archive' }),
        ]),
        btn(pend ? 'Use a different backup…' : 'Open a backup file first…', async () => { const r = await openBackup(); if (r) { T.pendingShown = r; render(); } }, { ic: 'file-json', cls: 'btn-ghost' }))),
    h('div', { class: 'panel', id: 'tg-restore-detail' }));
    paintRestore();
    return;
  }
  T.pendingShown = null;
  const found = (T.root?.manifests || []).filter((m) => /^nametag-tags-/i.test(m.name));
  wrap.append(h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, icon('undo-2'), h('h2', null, 'Restore previous tags')),
    h('p', null, 'Pick a tag backup. Files are matched by their path inside the location you opened; the paths can be adjusted if it was made on another computer.'),
    found.length ? h('ul', { class: 'manifest-list' }, found.map((m) => h('li', null, h('button', { type: 'button', class: `manifest-item ${T.restore?.name === m.path ? 'is-active' : ''}`, onclick: async () => { try { await loadRestore(parseManifest(await (await m.getFile()).text()), m.path); } catch (e) { toast(e.message, { type: 'error' }); } } }, icon('file-json'), h('span', { class: 'mono' }, m.path))))) : h('p', { class: 'muted' }, 'No backups found here.'),
    h('div', { class: 'btn-row' },
      btn('Open a backup file…', async () => { const r = await openBackup(); if (r) await loadRestore(r.manifest, null, r.fileName); }, { ic: 'upload' }))),
  h('div', { class: 'panel', id: 'tg-restore-detail' }));
  paintRestore();
}

async function loadRestore(manifest, name = null, fileName = null, remap = null) {
  const saved = manifest.files.map((f) => f.path);
  const present = T.rows.map((r) => r.path);
  if (!remap) remap = detectRemap(saved, present, { allowDirs: true, hint: name ? dirname(name) : '' });
  T.restore = { manifest, name, fileName: fileName || (name ? basename(name) : null), remap, saved, present };
  matchRestore();
  T.mode = 'restore';
  render();
}

function matchRestore() {
  const R = T.restore;
  const key = (p) => p.toLowerCase();
  const byPath = new Map(T.rows.map((r) => [key(r.path), r]));
  const nameCount = new Map(); for (const r of T.rows) nameCount.set(key(r.name), (nameCount.get(key(r.name)) || 0) + 1);
  const savedCount = new Map(); for (const p of R.saved) savedCount.set(key(basename(p)), (savedCount.get(key(basename(p))) || 0) + 1);
  const byName = new Map(T.rows.filter((r) => nameCount.get(key(r.name)) === 1).map((r) => [key(r.name), r]));
  R.items = R.manifest.files.map((f) => {
    const mapped = mapPath(f.path, R.remap);
    let row = mapped != null ? byPath.get(key(mapped)) : null;
    let how = 'path';
    if (!row && R.remap.byName && savedCount.get(key(basename(f.path))) === 1) { row = byName.get(key(basename(f.path))) || null; how = 'name'; }
    return { f, row: row || null, how, mapped };
  });
  R.matched = R.items.filter((x) => x.row).length;
}

function paintRestore() {
  const box = T.el.querySelector('#tg-restore-detail');
  if (!box) return;
  clear(box);
  if (!T.restore) { box.append(h('p', { class: 'muted' }, T.root ? 'Choose a backup to see which files it covers.' : 'The preview appears once the files are open.')); return; }
  const R = T.restore;
  const { manifest: m, items } = R;
  const ok = items.filter((x) => x.row?.model).length;
  const all = R.matched === items.length;
  const panel = remapPanel({
    manifest: m, rootName: T.root.name, remap: R.remap, matched: R.matched, total: items.length,
    samples: items.filter((x) => x.row && x.row.path !== x.f.path).slice(0, 3).map((x) => [x.f.path, x.row.path]),
    onChange: (rm) => { R.remap = { ...R.remap, ...rm }; matchRestore(); paintRestore(); },
    onDetect: () => { R.remap = detectRemap(R.saved, R.present, { allowDirs: true, hint: R.name ? dirname(R.name) : '' }); matchRestore(); paintRestore(); },
    onPickFolder: (e) => menu(e.currentTarget, [
      support.dirPicker ? { label: 'Open folder…', icon: 'folder-open', onClick: () => pickTargetFor(m, R.fileName, 'folder') } : null,
      support.filePicker ? { label: 'Open files…', icon: 'file-music', onClick: () => pickTargetFor(m, R.fileName, 'files') } : null,
      { label: 'Open ZIP…', icon: 'file-archive', onClick: () => pickTargetFor(m, R.fileName, 'zip') },
      { label: 'Import a folder (copy)…', icon: 'upload', onClick: () => pickTargetFor(m, R.fileName, 'import') },
    ]),
  });
  box.append(h('div', { class: 'panel-head' }, icon('rotate-ccw'), h('h2', null, 'Restore preview')),
    h('p', null, `Backup from ${formatDate(new Date(m.createdAt), 'D MMM YYYY, HH:mm')} of "${m.root}", ${m.files.length} file(s).`, m.restoredAt ? ` Already restored on ${formatDate(new Date(m.restoredAt), 'D MMM YYYY, HH:mm')}.` : ''),
    h('details', { class: 'remap-wrap', open: !all || !isIdentity(R.remap) ? '' : null },
      h('summary', null, icon(all ? 'circle-check' : 'triangle-alert'), all ? `All ${items.length} files found here. Paths and folder` : 'Paths need attention'), panel),
    h('ul', { class: 'restore-list mono' }, items.slice(0, 400).map(({ f, row, how }) => h('li', { class: row?.model ? 'st-ok' : 'st-missing' },
      h('span', { class: 'ex-old' }, row && row.path !== f.path ? `${f.path}  (here: ${row.path})` : f.path),
      h('span', { class: 'ex-new' }, [f.before.fields.artist, f.before.fields.title].filter(Boolean).join(' – ') || '(no title)'),
      h('span', { class: 'pill' }, row?.model ? (how === 'name' ? 'ready, by name' : 'ready') : row ? 'unreadable' : 'not found')))),
    items.length > 400 ? h('p', { class: 'muted' }, `…and ${items.length - 400} more.`) : null,
    h('div', { class: 'btn-row' }, btn(`Restore ${ok} file${ok === 1 ? '' : 's'}`, () => runRestore(), { cls: 'btn-primary', ic: 'rotate-ccw', disabled: !ok })));
}

async function runRestore() {
  const { manifest, name, items } = T.restore;
  for (const { f, row } of items) {
    if (!row?.model) continue;
    row.model.fields = { ...f.before.fields };
    row.model.custom = (f.before.custom || []).map((c) => ({ ...c }));
    if (Array.isArray(f.before.pictures)) row.model.pictures = picsFromJSON(f.before.pictures);
    row.dirty = true;
  }
  T.mode = 'edit';
  render();
  await save();
  manifest.restoredAt = new Date().toISOString();
  if (name && (T.root.kind === 'dir')) { try { await T.root.writeText(name, JSON.stringify(manifest, null, 2)); } catch { /* ignore */ } }
  await updateHistory(manifest.id, { manifest, status: 'restored' });
  T.restore = null;
}
