// In-app file browser for the Android app: shows storage like a file manager, with a tick box on every folder and
// file, so several folders and files can be chosen at once. Returns one NativeRoot for the whole selection.
import { h, icon, toast } from './ui.js';
import { NativeRoot } from './sources.js';
import { naturalCompare, formatBytes } from './utils.js';

const AUDIO = /\.(mp3|mp2|flac|m4a|m4b|m4p|mp4|aac|ogg|oga|opus|wav|wave|aif|aiff|aifc)$/i;
const plugin = () => window.Capacitor.Plugins.NameTagFolders;
const nf = (n) => Number(n || 0).toLocaleString('en-US');
const dateText = (ms) => { try { return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }); } catch { return ''; } };
const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const parentOf = (p) => p.slice(0, Math.max(0, p.lastIndexOf('/')));

/**
 * Opens the browser and resolves with a NativeRoot, null when closed, or 'saf' when the person asks for Android's own one-folder picker.
 * opts: { title, audioOnly }  audioOnly adds a "Music files only" switch (on by default).
 */
export function pickNativeRoot({ title = 'Choose folders and files', audioOnly = false } = {}) {
  return new Promise((resolve) => {
    const st = { roots: [], volume: null, path: '', entries: [], readable: true, sel: new Map(), onlyAudio: audioOnly, loading: false, gate: false };
    const prevFocus = document.activeElement;
    const list = h('div', { class: 'fb-list', role: 'list' });
    const crumbs = h('div', { class: 'fb-crumbs' });
    const titleEl = h('h2', { class: 'fb-title' });
    const subEl = h('p', { class: 'fb-sub' });
    const tools = h('div', { class: 'fb-tools' });
    const foot = h('div', { class: 'fb-foot' });
    const back = h('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Up one folder', onclick: () => up() }, icon('arrow-left'));
    const closeBtn = h('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Close', onclick: () => finish(null) }, icon('x'));
    const body = h('div', { class: 'fb-body' }, tools, crumbs, list);
    const root = h('div', { class: 'fb', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('header', { class: 'fb-head' }, back, h('div', { class: 'fb-headtext' }, titleEl, subEl), closeBtn), body, foot);
    document.body.append(root);
    document.body.classList.add('fb-open');
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    document.addEventListener('keydown', onKey);

    function finish(result) {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      root.remove(); document.body.classList.remove('fb-open');
      try { prevFocus?.focus?.(); } catch { /* ignore */ }
      resolve(result);
    }

    /* ---- permission gate */
    async function hasAccess() { try { return !!(await plugin().storageAccess()).granted; } catch { return false; } }
    function showGate() {
      st.gate = true;
      titleEl.textContent = title; subEl.textContent = '';
      back.hidden = true; tools.replaceChildren(); crumbs.replaceChildren(); foot.replaceChildren();
      list.replaceChildren(h('div', { class: 'fb-gate' },
        h('span', { class: 'fb-gate-ic' }, icon('folder-open')),
        h('h3', null, 'Allow access to your files'),
        h('p', null, 'To show all your folders and let you tick several at once, NameTag needs "All files access". Android opens a settings screen: switch it on for NameTag, then come back.'),
        h('button', { type: 'button', class: 'btn btn-primary btn-lg', onclick: async () => { try { await plugin().requestStorageAccess(); } catch (e) { toast(e.message, { type: 'error' }); } } }, 'Open settings'),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => finish('saf') }, 'Use Android\'s one-folder picker instead'),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => finish(null) }, 'Not now')));
    }
    async function onVisible() { if (st.gate && document.visibilityState === 'visible' && await hasAccess()) { st.gate = false; start(); } }
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    /* ---- navigation */
    async function start() {
      if (!(await hasAccess())) { showGate(); return; }
      try { st.roots = (await plugin().fsRoots()).roots || []; } catch (e) { toast(e.message, { type: 'error' }); finish(null); return; }
      if (!st.roots.length) { toast('No storage found.', { type: 'error' }); finish(null); return; }
      if (st.roots.length === 1) await open(st.roots[0].path, st.roots[0]); else showVolumes();
    }
    function showVolumes() {
      st.path = ''; st.volume = null; st.entries = [];
      paintHead(); tools.replaceChildren(); crumbs.replaceChildren();
      list.replaceChildren(...st.roots.map((r) => h('div', { class: 'fb-row', role: 'listitem' },
        h('span', { class: 'fb-spacer' }), h('button', { type: 'button', class: 'fb-main', onclick: () => open(r.path, r) }, h('span', { class: 'fb-ic is-dir' }, icon('folder')), h('span', { class: 'fb-text' }, h('span', { class: 'fb-name' }, r.name)), icon('chevron-right', 'fb-go')))));
      paintFoot();
    }
    async function open(path, volume) {
      if (volume) st.volume = volume;
      st.path = path; st.loading = true; paintHead(); list.replaceChildren(h('p', { class: 'fb-empty' }, 'Loading…'));
      try {
        const r = await plugin().fsList({ path });
        st.readable = r.readable !== false;
        st.entries = (r.entries || []).filter((e) => !e.name.startsWith('.')).sort((a, b) => (a.isDir === b.isDir ? naturalCompare(a.name, b.name) : a.isDir ? -1 : 1));
      } catch (e) { toast(e.message, { type: 'error' }); st.entries = []; }
      st.loading = false; paintAll();
    }
    function up() {
      if (st.gate) return;
      if (!st.volume || st.path === st.volume.path) { if (st.roots.length > 1 && st.volume) showVolumes(); else finish(null); return; }
      open(parentOf(st.path));
    }

    /* ---- painting */
    const visible = () => st.entries.filter((e) => e.isDir || !st.onlyAudio || AUDIO.test(e.name));
    const keyOf = (e) => `${st.path}/${e.name}`;
    function paintHead() {
      back.hidden = false;
      titleEl.textContent = !st.volume ? title : st.path === st.volume.path ? st.volume.name : nameOf(st.path);
      subEl.textContent = !st.volume ? 'Choose a storage' : st.loading ? '' : `${nf(visible().length)} item${visible().length === 1 ? '' : 's'}`;
    }
    function paintCrumbs() {
      crumbs.replaceChildren();
      if (!st.volume) return;
      const parts = st.path.slice(st.volume.path.length).split('/').filter(Boolean);
      let acc = st.volume.path;
      const mk = (label, p) => h('button', { type: 'button', class: `fb-crumb ${p === st.path ? 'is-here' : ''}`, onclick: () => open(p) }, label);
      crumbs.append(mk(st.volume.name, st.volume.path));
      for (const part of parts) { acc += `/${part}`; crumbs.append(icon('chevron-right', 'fb-sep'), mk(part, acc)); }
      requestAnimationFrame(() => { crumbs.scrollLeft = crumbs.scrollWidth; });
    }
    function paintTools() {
      tools.replaceChildren();
      if (!st.volume) return;
      const rows = visible();
      const allOn = rows.length > 0 && rows.every((e) => st.sel.has(keyOf(e)));
      tools.append(h('button', { type: 'button', class: 'chip-toggle', 'aria-pressed': String(allOn), disabled: !rows.length, onclick: () => { for (const e of rows) { if (allOn) st.sel.delete(keyOf(e)); else st.sel.set(keyOf(e), { path: keyOf(e), isDir: e.isDir }); } paintAll(); } }, allOn ? 'Clear this folder' : 'Select all here'));
      if (audioOnly) tools.append(h('button', { type: 'button', class: `chip-toggle ${st.onlyAudio ? 'is-on' : ''}`, 'aria-pressed': String(st.onlyAudio), onclick: () => { st.onlyAudio = !st.onlyAudio; paintAll(); } }, 'Music files only'));
    }
    function paintList() {
      const rows = visible();
      if (!st.readable) { list.replaceChildren(h('p', { class: 'fb-empty' }, 'Android does not let apps read this folder.')); return; }
      if (!rows.length) { list.replaceChildren(h('p', { class: 'fb-empty' }, st.entries.length ? 'No music files here. Turn off "Music files only" to see everything.' : 'This folder is empty.')); return; }
      list.replaceChildren(...rows.slice(0, 3000).map((e) => {
        const key = keyOf(e); const on = st.sel.has(key);
        const box = h('input', { type: 'checkbox', class: 'check', checked: on, 'aria-label': `Select ${e.name}`, onchange: (ev) => { if (ev.target.checked) st.sel.set(key, { path: key, isDir: e.isDir }); else st.sel.delete(key); paintAll(); } });
        const meta = [dateText(e.mtime), e.isDir ? '' : formatBytes(e.size)].filter(Boolean).join(' · ');
        const main = h('button', { type: 'button', class: 'fb-main', onclick: () => { if (e.isDir) open(key); else { if (st.sel.has(key)) st.sel.delete(key); else st.sel.set(key, { path: key, isDir: false }); paintAll(); } } },
          h('span', { class: `fb-ic ${e.isDir ? 'is-dir' : AUDIO.test(e.name) ? 'is-audio' : ''}` }, icon(e.isDir ? 'folder' : AUDIO.test(e.name) ? 'file-music' : 'file')),
          h('span', { class: 'fb-text' }, h('span', { class: 'fb-name' }, e.name), h('span', { class: 'fb-meta' }, meta)),
          e.isDir ? icon('chevron-right', 'fb-go') : null);
        return h('div', { class: `fb-row ${on ? 'is-sel' : ''}`, role: 'listitem' }, h('label', { class: 'fb-check' }, box), main);
      }));
    }
    function paintFoot() {
      foot.replaceChildren();
      if (!st.volume && st.roots.length > 1) return;
      const items = [...st.sel.values()]; const d = items.filter((i) => i.isDir).length; const f = items.length - d;
      const label = items.length ? [d ? `${nf(d)} folder${d === 1 ? '' : 's'}` : '', f ? `${nf(f)} file${f === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ') : 'Nothing selected';
      foot.append(h('div', { class: 'fb-count' }, h('strong', null, label), items.length ? h('button', { type: 'button', class: 'link', onclick: () => { st.sel.clear(); paintAll(); } }, 'Clear') : h('span', { class: 'muted' }, 'Tick folders or files, in any folder')),
        h('button', { type: 'button', class: 'btn btn-primary btn-lg', disabled: !items.length, onclick: () => done() }, items.length ? `Open ${nf(items.length)}` : 'Open'));
    }
    function paintAll() { paintHead(); paintCrumbs(); paintTools(); paintList(); paintFoot(); }

    function done() {
      // A folder that is ticked already covers everything inside it.
      const items = [...st.sel.values()].sort((a, b) => a.path.length - b.path.length);
      const kept = [];
      for (const it of items) if (!kept.some((k) => k.isDir && (it.path === k.path || it.path.startsWith(`${k.path}/`)))) kept.push(it);
      kept.sort((a, b) => naturalCompare(a.path, b.path));
      finish(new NativeRoot({ items: kept }));
    }

    start();
  });
}
