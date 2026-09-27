// App shell: routing, theme, service worker updates, install prompt, drag and drop, and the History view.
import { h, icon, btn, clear, toast, confirmDialog, download, isNativeApp } from './core/ui.js';
import { formatDate } from './core/utils.js';
import { DirRoot, SafRoot, support } from './core/sources.js';
import { summarizeManifest } from './core/manifest.js';
import { listHistory, deleteHistory, clearHistory } from './core/history.js';
import * as renamer from './renamer/renamer-ui.js';
import * as tagger from './tagger/tagger-ui.js';
import { AUDIO_EXT } from './tagger/index.js';

const VIEWS = ['renamer', 'tagger', 'history', 'guide'];
const $ = (s) => document.querySelector(s);
let current = null;

/* ------------------------------------------------------------------ routing */
function route() {
  if (location.hash === '#share') { receiveShared(); return; }
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'renamer';
  if (v === current) return;
  current = v;
  for (const name of VIEWS) $(`#view-${name}`).hidden = name !== v;
  document.querySelectorAll('.tabs-main a').forEach((a) => (a.dataset.view === v ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  if (v === 'history') renderHistory();
  document.title = `${{ renamer: 'Renamer', tagger: 'Tag editor', history: 'History', guide: 'Guide' }[v]} · NameTag`;
}
const go = (v) => { if (location.hash !== `#${v}`) location.hash = v; else route(); };

/* ------------------------------------------------------------------ theme */
const THEMES = ['system', 'light', 'dark'];
function applyTheme(t) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  const b = $('#theme-btn');
  b.replaceChildren(icon({ system: 'monitor', light: 'sun', dark: 'moon' }[t]));
  b.setAttribute('aria-label', `Theme: ${t}. Change theme`);
  b.title = `Theme: ${t}`;
}
function initTheme() {
  let t = 'system';
  try { t = localStorage.getItem('nametag.theme') || 'system'; } catch { /* ignore */ }
  applyTheme(t);
  $('#theme-btn').addEventListener('click', () => {
    t = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
    try { localStorage.setItem('nametag.theme', t); } catch { /* ignore */ }
    applyTheme(t);
  });
}

/* ------------------------------------------------------------------ PWA */
function initSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  // The Android app ships every file inside the APK, so no offline cache is needed (and it could serve stale files after an update).
  if (isNativeApp()) { navigator.serviceWorker.getRegistrations?.().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {}); return; }
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (w) => toast('A new version of NameTag is ready.', { timeout: 0, action: { label: 'Update', onClick: () => w.postMessage({ type: 'SKIP_WAITING' }) } });
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch((e) => console.warn('SW registration failed', e));
}
function initInstall() {
  let deferred = null;
  const b = $('#install-btn');
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; b.hidden = false; });
  b.addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; b.hidden = true; });
  window.addEventListener('appinstalled', () => { b.hidden = true; toast('NameTag is installed and works offline.', { type: 'success' }); });
}

/* ------------------------------------------------------------------ drag and drop */
function initDrop() {
  const overlay = $('#drop-overlay');
  let depth = 0;
  const active = () => current === 'renamer' || current === 'tagger';
  document.addEventListener('dragenter', (e) => { if (!active() || !e.dataTransfer?.types?.includes('Files')) return; depth++; overlay.hidden = false; });
  document.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; overlay.hidden = true; } });
  document.addEventListener('dragover', (e) => { if (active() && e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', async (e) => {
    depth = 0; overlay.hidden = true;
    if (!active() || e.defaultPrevented) return;
    e.preventDefault();
    try { if (current === 'renamer') await renamer.openDropped(e.dataTransfer); else await tagger.openDropped(e.dataTransfer); } catch (err) { toast(`Could not open: ${err.message}`, { type: 'error' }); }
  });
}

/* ------------------------------------------------------------------ Android / OS share sheet */
// Files shared to NameTag (Web Share Target) are parked by the service worker in a cache, then opened here:
// audio goes to the Tag editor, anything else (or a ZIP) to the Renamer.
async function receiveShared() {
  let files = [];
  try {
    const cache = await caches.open('nametag-share');
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('x-name') || 'shared-file');
      files.push(new File([blob], name, { type: blob.type, lastModified: Number(res.headers.get('x-modified')) || Date.now() }));
    }
    await caches.delete('nametag-share');
  } catch { /* no cache API */ }
  const audio = files.length && files.every((f) => AUDIO_EXT.test(f.name));
  const target = audio ? 'tagger' : 'renamer';
  history.replaceState(null, '', `#${target}`);
  current = null;
  route();
  if (!files.length) { toast('Nothing was received. Share one or more files to NameTag.', { type: 'warn' }); return; }
  const dt = { items: [], files };
  try { await (audio ? tagger : renamer).openDropped(dt); toast(`Opened ${files.length} shared file${files.length === 1 ? '' : 's'}.`, { type: 'success' }); } catch (e) { toast(`Could not open the shared files: ${e.message}`, { type: 'error' }); }
}

/* ------------------------------------------------------------------ history */
async function renderHistory() {
  const el = $('#view-history');
  clear(el);
  const list = await listHistory();
  el.append(h('div', { class: 'doc-head' }, h('h1', null, 'History'),
    h('p', { class: 'muted' }, 'Every rename and tag save is recorded in this browser. The same undo data is also saved as a JSON file next to your files.'),
    list.length ? btn('Clear history', async () => { if (await confirmDialog('Clear history?', 'Your undo files next to the renamed files are not deleted.', { okText: 'Clear', danger: true })) { await clearHistory(); renderHistory(); } }, { cls: 'btn-sm btn-ghost', ic: 'trash-2' }) : null));
  if (!list.length) { el.append(h('div', { class: 'empty' }, h('p', null, 'Nothing here yet. Renames and tag saves will show up here.'))); return; }
  const ul = h('ul', { class: 'history-list' });
  for (const rec of list) {
    const m = rec.manifest;
    const status = { complete: 'Done', partial: 'Partly done', restored: 'Restored', 'restore-partial': 'Partly restored', 'in-progress': 'Interrupted' }[rec.status] || rec.status;
    ul.append(h('li', { class: 'history-item' },
      h('div', { class: 'hi-icon', 'aria-hidden': 'true' }, icon(rec.type === 'tags' ? 'tag' : 'text-cursor-input')),
      h('div', { class: 'hi-main' },
        h('p', { class: 'hi-title' }, h('strong', null, rec.type === 'tags' ? 'Tag save' : 'Rename'), ` in "${rec.rootName}"`),
        h('p', { class: 'muted' }, `${formatDate(new Date(rec.createdAt), 'D MMM YYYY, HH:mm')}. ${summarizeManifest(m)}. `, h('span', { class: `pill ${/restor/.test(rec.status) ? '' : 'pill-accent'}` }, status)),
        h('p', { class: 'mono small muted' }, rec.manifestName)),
      h('div', { class: 'btn-row' },
        btn('Restore', () => restoreFromHistory(rec), { cls: 'btn-sm', ic: 'rotate-ccw' }),
        btn('', () => download(new Blob([JSON.stringify(m, null, 2)], { type: 'application/json' }), rec.manifestName), { cls: 'btn-icon', ic: 'download', title: 'Download undo file' }),
        btn('', async () => { if (await confirmDialog('Remove this entry?', 'Only the history entry is removed.', { okText: 'Remove' })) { await deleteHistory(rec.id); renderHistory(); } }, { cls: 'btn-icon', ic: 'trash-2', title: 'Remove entry' }))));
  }
  el.append(ul);
}

async function restoreFromHistory(rec) {
  const canReopen = rec.handle && rec.source === 'dir' && (rec.handle.saf ? support.safPicker : support.dirPicker);
  if (canReopen) {
    const root = rec.handle.saf ? new SafRoot(rec.handle) : new DirRoot(rec.handle);
    let ok = false;
    try { ok = await root.verifyPermission(true); } catch { ok = false; }
    if (ok) {
      if (rec.type === 'rename') { go('renamer'); await renamer.openRestore(root, rec.manifest); } else { go('tagger'); await tagger.openRestore(root, rec.manifest); }
      return;
    }
  }
  const where = rec.source === 'dir' ? 'Open the same folder' : rec.source === 'zip' ? 'Open the renamed ZIP' : 'Import the same files (or the ZIP you downloaded)';
  toast(`${where} in ${rec.type === 'tags' ? 'the Tag editor' : 'the Renamer'}, switch to Restore, and choose this undo file. It has been downloaded for you.`, { timeout: 12000 });
  download(new Blob([JSON.stringify(rec.manifest, null, 2)], { type: 'application/json' }), rec.manifestName);
  go(rec.type === 'tags' ? 'tagger' : 'renamer');
}

/* ------------------------------------------------------------------ boot */
function boot() {
  initTheme();
  renamer.mountRenamer($('#view-renamer'));
  tagger.mountTagger($('#view-tagger'), { onSendToRenamer: (root, rules) => { go('renamer'); renamer.openWithRules(root, rules); } });
  window.addEventListener('hashchange', route);
  route();
  initDrop();
  initSW();
  initInstall();
  window.addEventListener('beforeunload', (e) => { if (tagger.hasUnsaved()) { e.preventDefault(); e.returnValue = ''; } });
  if (isNativeApp()) document.documentElement.classList.add('is-native-app');
  window.__nametag = { renamer, tagger, support, go };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
