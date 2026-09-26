// Bulk renamer view: sources, rule pipeline, pattern analyser, live preview, execution with an undo file, and restore.
import { h, icon, btn, clear, toast, openDialog, confirmDialog, promptDialog, progress, tick, menu, VirtualList, download, pickFiles, readFileText, renderFields } from '../core/ui.js';
import { dirname, basename, splitName, naturalCompare, diffChars, debounce, formatBytes, formatDate } from '../core/utils.js';
import { DirRoot, ZipRoot, MemRoot, support, filesFromDataTransfer } from '../core/sources.js';
import { buildPlan, executeOps, reverseOps, simulateOps } from '../core/planner.js';
import { createRenameManifest, manifestFileName, parseManifest, summarizeManifest } from '../core/manifest.js';
import { addHistory, updateHistory } from '../core/history.js';
import { RULES, makeRule, runPipeline, TAG_VARS } from './rules.js';
import { analyze } from './analyzer.js';
import { BUILTIN_PRESETS, loadUserPresets, addUserPreset, saveUserPresets, exportPresets, importPresets } from './presets.js';
import { readTags, AUDIO_EXT } from '../tagger/index.js';
import { DEFAULT_EXT_OPTS, extGroups, extensionProposals, newNameFor, needsContent, UNIFY, cleanTarget } from './extensions.js';
import { detectRemap, countMatches, remapOps, mapPath, currentPathsAfter, isIdentity } from '../core/remap.js';
import { remapPanel } from '../core/remap-ui.js';

const OPTS_KEY = 'nametag.renamer.options';
const RULES_KEY = 'nametag.renamer.rules';
const EXT_KEY = 'nametag.renamer.extensions';
const DEFAULT_OPTS = {
  scope: 'files', recursive: true, includeHidden: false, ext: '', filter: '', filterMode: 'glob', sort: 'name',
  conflict: 'suffix', windows: true, caseSensitive: false, copyFallback: false, changedOnly: false,
};

const S = {
  el: null, mode: 'rename', root: null, entries: [], candidates: [], rules: [], opts: { ...DEFAULT_OPTS },
  excluded: new Set(), plan: null, rows: [], visible: [], search: '', tags: new Map(), magic: new Map(),
  analysis: null, restore: null, list: null, busy: false, ext: { ...DEFAULT_EXT_OPTS, map: {} }, pending: null,
};
try { const e = JSON.parse(localStorage.getItem(EXT_KEY) || 'null'); if (e) Object.assign(S.ext, e, { map: {} }); } catch { /* ignore */ }

try { Object.assign(S.opts, JSON.parse(localStorage.getItem(OPTS_KEY) || '{}')); } catch { /* ignore */ }
try { const r = JSON.parse(localStorage.getItem(RULES_KEY) || 'null'); if (Array.isArray(r)) S.rules = r.filter((x) => RULES[x.type]).map((x) => ({ ...makeRule(x.type, x.opts), enabled: x.enabled !== false })); } catch { /* ignore */ }
if (!S.rules.length) S.rules = [makeRule('cleanup')];

const saveState = debounce(() => {
  try {
    localStorage.setItem(OPTS_KEY, JSON.stringify(S.opts));
    localStorage.setItem(RULES_KEY, JSON.stringify(S.rules.map(({ type, enabled, opts }) => ({ type, enabled, opts }))));
    const { map, ...extRest } = S.ext; localStorage.setItem(EXT_KEY, JSON.stringify(extRest));
  } catch { /* quota */ }
}, 400);

/* ------------------------------------------------------------------ mount */
export function mountRenamer(el) {
  S.el = el;
  el.append(
    h('div', { class: 'toolbar' },
      segmented([['rename', 'Rename'], ['ext', 'Extensions'], ['restore', 'Restore']], () => S.mode, (v) => { S.mode = v; render(); }, 'Mode'),
      h('div', { class: 'toolbar-group', id: 'rn-source' }),
    ),
    h('div', { class: 'source-line', id: 'rn-source-line' }),
    h('div', { id: 'rn-body' }),
  );
  render();
}

function segmented(options, get, set, label) {
  const wrap = h('div', { class: 'segment', role: 'radiogroup', 'aria-label': label });
  const paint = () => wrap.querySelectorAll('.seg').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === get())));
  for (const [v, l] of options) wrap.append(h('button', { type: 'button', class: 'seg', role: 'radio', dataset: { v }, onclick: () => { set(v); paint(); } }, l));
  paint();
  return wrap;
}

function renderSource() {
  const bar = S.el.querySelector('#rn-source');
  clear(bar);
  if (support.dirPicker) bar.append(btn('Open folder', () => openFolder(), { cls: 'btn-primary', ic: 'folder-open' }));
  bar.append(btn('Open ZIP', () => openZip(), { ic: 'file-archive' }));
  const more = btn('', (e) => menu(e.currentTarget, [
    { label: 'Import files…', icon: 'upload', onClick: () => importFiles(false) },
    { label: 'Import a folder (copy)…', icon: 'folder', onClick: () => importFiles(true) },
    { separator: true },
    { label: 'Rescan', icon: 'refresh-cw', disabled: !S.root, onClick: () => scan() },
  ]), { title: 'More sources', ic: 'ellipsis-vertical' });
  more.dataset.menuAnchor = '';
  bar.append(more);
  const line = S.el.querySelector('#rn-source-line');
  clear(line);
  if (!S.root) {
    line.append(h('span', { class: 'muted' }, support.dirPicker
      ? 'Open a folder to rename in place, or open a ZIP. You can also drop files here.'
      : 'This browser cannot rename files on disk. Import files or open a ZIP: you get a renamed ZIP back, with the undo file inside.'));
    return;
  }
  const kind = { dir: 'Folder', zip: 'ZIP archive', mem: 'Imported copy' }[S.root.kind] || S.root.kind;
  line.append(icon(S.root.kind === 'zip' ? 'file-archive' : 'folder'), h('strong', null, S.root.name), h('span', { class: 'pill' }, kind),
    h('span', { class: 'muted' }, `${S.entries.filter((e) => !e.isDir).length.toLocaleString('en-US')} files, ${S.entries.filter((e) => e.isDir).length.toLocaleString('en-US')} folders`));
  if (S.root.manifests.length) line.append(h('button', { class: 'link', type: 'button', onclick: () => { S.mode = 'restore'; render(); } }, `${S.root.manifests.length} undo file${S.root.manifests.length > 1 ? 's' : ''} found`));
}

/* ------------------------------------------------------------------ sources */
async function openFolder() {
  try { await setRoot(await DirRoot.pick()); } catch (e) { if (e.name !== 'AbortError') toast(e.message, { type: 'error' }); }
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
  const files = await pickFiles({ directory });
  if (files.length) await setRoot(new MemRoot(files, directory ? 'Imported folder' : 'Imported files'));
}

/** Called by the app shell for drag & drop and by History. */
export async function openDropped(dt) {
  const items = [...(dt.items || [])];
  if (items.length === 1 && items[0].getAsFileSystemHandle) {
    try {
      const hnd = await items[0].getAsFileSystemHandle();
      if (hnd?.kind === 'directory') { await setRoot(new DirRoot(hnd)); return; }
      if (hnd?.kind === 'file' && /\.zip$/i.test(hnd.name)) { await setRoot(await ZipRoot.load(await hnd.getFile(), hnd)); return; }
    } catch { /* fall back */ }
  }
  const files = await filesFromDataTransfer(dt);
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) { await setRoot(await ZipRoot.load(files[0])); return; }
  if (files.length) await setRoot(new MemRoot(files, 'Dropped files'));
}

export async function openRestore(root, manifest) {
  S.mode = 'restore';
  await setRoot(root, { keepMode: true });
  await loadRestore(manifest);
}

export async function openWithRules(root, rules) {
  S.mode = 'rename';
  S.rules = rules;
  await setRoot(root, { keepMode: true });
}

export const getRoot = () => S.root;

async function setRoot(root, { keepMode = false } = {}) {
  if (root.kind === 'dir' && !(await root.verifyPermission(true))) { toast('Write permission is needed to rename files in this folder.', { type: 'warn' }); return; }
  S.root = root; S.excluded.clear(); S.tags.clear(); S.magic.clear(); S.restore = null;
  if (!keepMode && S.mode === 'restore' && !S.pending) S.mode = 'rename';
  await scan();
  if (S.pending) {
    const pend = S.pending; S.pending = null;
    const here = root.manifests.find((m) => m.name === pend.fileName);
    S.mode = 'restore';
    await loadRestore(pend.manifest, here ? here.path : null, !here);
  }
}

/** Keep the loaded undo file and open another folder, ZIP or import to apply it to. */
function pickTargetFor(manifest, fileName, how) {
  S.pending = { manifest, fileName };
  const go = { folder: openFolder, zip: openZip, import: () => importFiles(true) }[how];
  Promise.resolve(go()).finally(() => { if (S.pending?.manifest === manifest) { S.pending = null; render(); } });
}

async function scan() {
  if (!S.root) return;
  const p = progress('Reading files', { cancellable: false });
  try {
    S.root.allowCopyFallback = S.opts.copyFallback;
    S.entries = await S.root.list({ recursive: S.opts.recursive, includeHidden: S.opts.includeHidden, onProgress: (n) => p.set(0, 0, `${n.toLocaleString('en-US')} items found…`) });
  } catch (e) { toast(`Could not read: ${e.message}`, { type: 'error' }); S.entries = []; }
  p.close();
  render();
}

/* ------------------------------------------------------------------ render */
function render() {
  if (!S.el) return;
  renderSource();
  S.el.querySelectorAll('.toolbar .segment .seg').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === S.mode)));
  const body = S.el.querySelector('#rn-body');
  clear(body);
  S.list = null;
  if (S.mode === 'restore') { renderRestore(body); return; }
  body.append(
    h('div', { class: 'workbench' },
      S.mode === 'ext' ? h('aside', { class: 'rules-col', 'aria-label': 'Extensions' },
        h('section', { class: 'panel ext-panel', id: 'rn-ext', 'aria-label': 'Extension changes' }),
        h('details', { class: 'panel filters', id: 'rn-filters' }, h('summary', null, icon('filter'), 'Filters and options'), h('div', { id: 'rn-filter-body' }))) :
      h('aside', { class: 'rules-col', 'aria-label': 'Rules' },
        h('div', { class: 'col-head' }, h('h2', null, 'Rules'),
          h('div', { class: 'col-actions' },
            withAnchor(btn('Add rule', (e) => addRuleMenu(e.currentTarget), { ic: 'plus', cls: 'btn-sm' })),
            withAnchor(btn('Presets', (e) => presetsMenu(e.currentTarget), { ic: 'layers', cls: 'btn-sm btn-ghost' })))),
        h('ol', { class: 'rule-list', id: 'rn-rules' }),
        h('details', { class: 'panel filters', id: 'rn-filters' }, h('summary', null, icon('filter'), 'Filters and options'), h('div', { id: 'rn-filter-body' })),
        h('section', { class: 'panel analyser', id: 'rn-analyser', 'aria-label': 'Pattern analyser' })),
      h('section', { class: 'preview-col', 'aria-label': 'Preview' },
        h('div', { class: 'col-head' }, h('h2', null, 'Preview'),
          h('div', { class: 'col-actions' },
            h('label', { class: 'search' }, icon('search'), h('input', { class: 'input', type: 'search', placeholder: 'Find in names', value: S.search, 'aria-label': 'Find in names', oninput: (e) => { S.search = e.target.value; filterRows(); } })),
            h('label', { class: 'field-check compact' }, h('input', { type: 'checkbox', class: 'check', checked: S.opts.changedOnly, onchange: (e) => { S.opts.changedOnly = e.target.checked; saveState(); filterRows(); } }), h('span', null, 'Changed only')))),
        h('div', { class: 'preview-head', role: 'row' },
          h('input', { type: 'checkbox', class: 'check', title: 'Include all', 'aria-label': 'Include all', id: 'rn-all', onchange: (e) => toggleAll(e.target.checked) }),
          h('span', null, 'Current name'), h('span', null, 'New name'), h('span', { class: 'sr-only' }, 'Status')),
        h('div', { class: 'preview-list', id: 'rn-list', role: 'grid', 'aria-label': 'Rename preview' }),
        h('div', { class: 'empty', id: 'rn-empty' })),
    ),
    h('div', { class: 'actionbar', id: 'rn-bar' }),
  );
  if (S.mode === 'ext') renderExtPanel(); else renderRules();
  renderFilters();
  const vp = body.querySelector('#rn-list');
  S.list = new VirtualList(vp, { rowHeight: () => (matchMedia('(max-width: 640px)').matches ? 64 : 48), renderRow: renderRow });
  recompute();
}

const withAnchor = (b) => { b.dataset.menuAnchor = ''; return b; };

/* ------------------------------------------------------------------ rules column */
function ruleFields(def) {
  return def.fields.map((f) => ({
    key: f.key, label: f.label, placeholder: f.placeholder, min: f.min, max: f.max, options: f.options, showIf: f.show,
    type: { bool: 'checkbox', template: 'text', code: 'textarea' }[f.type] || f.type,
    mono: ['template', 'code'].includes(f.type) || ['find', 'with', 'pairs', 'names', 'prefix', 'suffix', 'insert', 'marker', 'text'].includes(f.key),
    rows: f.type === 'code' ? 7 : 4,
    help: f.type === 'template' ? 'Variables such as {name}, {n:3}, {parent}, {mdate:YYYY-MM-DD}, {artist}, {track:2}. Full list in the Guide.' : undefined,
  }));
}

function ruleSummary(r) {
  const def = RULES[r.type];
  const parts = [];
  for (const f of def.fields) {
    if (f.show && !f.show(r.opts)) continue;
    const v = r.opts[f.key];
    if (v === f.default || v === '' || v == null) continue;
    if (f.type === 'bool') { if (v) parts.push(f.label.replace(/\s*\(.*\)$/, '')); continue; }
    const shown = f.type === 'select' ? (f.options.find((o) => o[0] === v) || [v, v])[1] : String(v);
    parts.push(`${f.label.replace(/\s*\(.*\)$/, '')}: ${shown.length > 28 ? `${shown.slice(0, 27)}…` : shown}`);
    if (parts.length >= 3) break;
  }
  return parts.join(', ') || def.desc;
}

function renderRules() {
  const ol = S.el.querySelector('#rn-rules');
  if (!ol) return;
  clear(ol);
  if (!S.rules.length) ol.append(h('li', { class: 'rule-empty' }, 'No rules yet. Add one, pick a preset, or use a suggestion from the analyser below.'));
  S.rules.forEach((r, i) => {
    const def = RULES[r.type];
    const summary = h('span', { class: 'rule-summary' }, ruleSummary(r));
    const bodyId = `rule-body-${r.id}`;
    const li = h('li', { class: `rule ${r.enabled ? '' : 'is-off'} ${r.open ? 'is-open' : ''}` },
      h('div', { class: 'rule-head' },
        h('span', { class: 'rule-num', 'aria-hidden': 'true' }, String(i + 1)),
        h('button', { type: 'button', class: 'rule-toggle', 'aria-expanded': String(!!r.open), 'aria-controls': bodyId, onclick: () => { r.open = !r.open; renderRules(); } },
          icon(def.icon || 'wand-sparkles'), h('span', { class: 'rule-title' }, def.label), summary),
        h('input', { type: 'checkbox', class: 'switch', checked: r.enabled, title: r.enabled ? 'Rule is on' : 'Rule is off', 'aria-label': `Enable ${def.label}`, onchange: (e) => { r.enabled = e.target.checked; li.classList.toggle('is-off', !r.enabled); changed(); } }),
        withAnchor(btn('', (e) => menu(e.currentTarget, [
          { label: 'Move up', icon: 'chevron-up', disabled: i === 0, onClick: () => moveRule(i, -1) },
          { label: 'Move down', icon: 'chevron-down', disabled: i === S.rules.length - 1, onClick: () => moveRule(i, 1) },
          { label: 'Duplicate', icon: 'copy', onClick: () => { S.rules.splice(i + 1, 0, makeRule(r.type, JSON.parse(JSON.stringify(r.opts)))); renderRules(); changed(); } },
          { separator: true },
          { label: 'Remove', icon: 'trash-2', danger: true, onClick: () => { S.rules.splice(i, 1); renderRules(); changed(); } },
        ]), { cls: 'btn-icon', title: 'Rule actions', ic: 'ellipsis-vertical' }))),
    );
    if (r.open) {
      const form = renderFields(ruleFields(def), r.opts, () => { summary.textContent = ruleSummary(r); changed(); });
      li.append(h('div', { class: 'rule-body', id: bodyId }, h('p', { class: 'rule-desc' }, def.desc), form));
    }
    ol.append(li);
  });
}

function moveRule(i, d) { const [r] = S.rules.splice(i, 1); S.rules.splice(i + d, 0, r); renderRules(); changed(); }

function addRuleMenu(anchor) {
  menu(anchor, [{ header: 'Add a rule' }, ...Object.entries(RULES).map(([type, def]) => ({
    label: def.label, icon: def.icon, hint: def.desc,
    onClick: () => { const r = makeRule(type); r.open = true; S.rules.push(r); renderRules(); changed(); },
  }))]);
}

function presetsMenu(anchor) {
  const user = loadUserPresets();
  const use = (rules, name) => { S.rules = rules; renderRules(); changed(); toast(`Preset "${name}" loaded.`); };
  menu(anchor, [
    { header: 'Built-in presets' },
    ...BUILTIN_PRESETS.map((p) => ({ label: p.name, hint: p.desc, onClick: () => use(p.rules(), p.name) })),
    ...(user.length ? [{ header: 'Your presets' }, ...user.map((p) => ({ label: p.name, onClick: () => use(p.rules.map((r) => ({ ...makeRule(r.type, r.opts), enabled: r.enabled !== false })), p.name) }))] : []),
    { separator: true },
    { label: 'Save current rules as preset…', icon: 'save', disabled: !S.rules.length, onClick: async () => {
      const name = await promptDialog('Save preset', 'Preset name', '');
      if (name) { addUserPreset(name.trim(), S.rules); toast('Preset saved.', { type: 'success' }); }
    } },
    { label: 'Delete a preset…', icon: 'trash-2', disabled: !user.length, onClick: async () => {
      const sel = h('select', { class: 'input' }, user.map((p) => h('option', { value: p.id }, p.name)));
      const ok = await openDialog({ title: 'Delete preset', body: h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Preset'), sel), actions: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, primary: true, cls: 'btn-danger' }] });
      if (ok) saveUserPresets(user.filter((p) => p.id !== sel.value));
    } },
    { label: 'Export presets', icon: 'download', disabled: !user.length, onClick: () => download(new Blob([exportPresets(user)], { type: 'application/json' }), 'nametag-presets.json') },
    { label: 'Import presets…', icon: 'upload', onClick: async () => {
      const [f] = await pickFiles({ accept: '.json,application/json', multiple: false });
      if (!f) return;
      try { const n = importPresets(await readFileText(f)); toast(`Imported ${Array.isArray(n) ? n.length : ''} presets.`, { type: 'success' }); } catch (e) { toast(e.message, { type: 'error' }); }
    } },
  ]);
}

function renderFilters() {
  const body = S.el.querySelector('#rn-filter-body');
  if (!body) return;
  const o = S.opts;
  const fields = [
    { key: 'scope', type: 'segment', label: 'Rename', options: [['files', 'Files'], ['dirs', 'Folders'], ['both', 'Both']] },
    { type: 'row', fields: [
      { key: 'recursive', type: 'checkbox', label: 'Include subfolders' },
      { key: 'includeHidden', type: 'checkbox', label: 'Include hidden files' },
    ] },
    { type: 'row', fields: [
      { key: 'ext', type: 'text', label: 'Only extensions', placeholder: 'mp3, flac', mono: true },
      { key: 'sort', type: 'select', label: 'Order for numbering', options: [['name', 'Name (natural)'], ['mtime', 'Date modified'], ['size', 'Size'], ['ext', 'Extension'], ['namedesc', 'Name, reversed']] },
    ] },
    { type: 'row', fields: [
      { key: 'filter', type: 'text', label: 'Only names matching', placeholder: '*.jpg or IMG_*', mono: true },
      { key: 'filterMode', type: 'select', label: 'Match as', options: [['glob', 'Wildcards'], ['regex', 'Regular expression'], ['text', 'Contains text']] },
    ] },
    { key: 'conflict', type: 'select', label: 'When two items would get the same name', options: [['suffix', 'Add " (2)", " (3)" …'], ['skip', 'Skip the later item']] },
    { key: 'windows', type: 'checkbox', label: 'Check names are valid on Windows', help: 'Flags < > : " \\ | ? * and reserved names like CON.' },
    { key: 'caseSensitive', type: 'checkbox', label: 'Treat "a.txt" and "A.txt" as different', help: 'Leave off for Windows and macOS drives.' },
    { key: 'copyFallback', type: 'checkbox', label: 'Rename folders by copying when the browser cannot move them', help: 'Slower and resets dates, so it is off by default.' },
  ];
  const rescanKeys = ['recursive', 'includeHidden'];
  let prev = { ...o };
  body.append(renderFields(fields, o, () => {
    const needScan = rescanKeys.some((k) => prev[k] !== o[k]);
    prev = { ...o };
    saveState();
    if (needScan) scan(); else changed();
  }));
}

/* ------------------------------------------------------------------ compute */
const changed = debounce(() => { saveState(); recompute(); }, 120);

function globRe(g) {
  const src = g.split('').map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(`^${src}$`, 'i');
}

function selectCandidates() {
  const o = S.opts;
  const extMode = S.mode === 'ext';
  let list = S.entries.filter((e) => (extMode ? !e.isDir : o.scope === 'both' ? true : o.scope === 'dirs' ? e.isDir : !e.isDir));
  const exts = extMode ? [] : o.ext.split(/[\s,;]+/).map((x) => x.replace(/^\./, '').toLowerCase()).filter(Boolean);
  if (exts.length) list = list.filter((e) => e.isDir || exts.includes(splitName(e.name).ext.toLowerCase()));
  if (o.filter.trim()) {
    let test;
    try {
      if (o.filterMode === 'regex') { const re = new RegExp(o.filter, 'i'); test = (n) => re.test(n); }
      else if (o.filterMode === 'text') { const t = o.filter.toLowerCase(); test = (n) => n.toLowerCase().includes(t); }
      else { const res = o.filter.split(/[,;]\s*/).filter(Boolean).map(globRe); test = (n) => res.some((re) => re.test(n)); }
      list = list.filter((e) => test(e.name));
    } catch { /* invalid regex: ignore filter */ }
  }
  const key = {
    name: (a, b) => naturalCompare(a.name, b.name),
    namedesc: (a, b) => naturalCompare(b.name, a.name),
    mtime: (a, b) => (a.mtime || 0) - (b.mtime || 0) || naturalCompare(a.name, b.name),
    size: (a, b) => (a.size || 0) - (b.size || 0) || naturalCompare(a.name, b.name),
    ext: (a, b) => naturalCompare(splitName(a.name, a.isDir).ext, splitName(b.name, b.isDir).ext) || naturalCompare(a.name, b.name),
  }[o.sort] || ((a, b) => naturalCompare(a.name, b.name));
  return list.sort((a, b) => {
    const da = dirname(a.path); const db = dirname(b.path);
    if (da !== db) return naturalCompare(da, db);
    return key(a, b);
  });
}

const usesTags = () => S.rules.some((r) => r.enabled && Object.values(r.opts).some((v) => typeof v === 'string' && new RegExp(`\\{(${TAG_VARS.join('|')})(?=[:|}])`).test(v)));
const usesMagic = () => (S.mode === 'ext' ? needsContent(S.ext) : S.rules.some((r) => r.enabled && RULES[r.type].needsMagic?.(r.opts)));

async function ensureExtras(cands) {
  const needTags = S.mode !== 'ext' && usesTags() ? cands.filter((e) => !e.isDir && AUDIO_EXT.test(e.name) && !S.tags.has(e.path)) : [];
  const needMagic = usesMagic() ? cands.filter((e) => !e.isDir && !S.magic.has(e.path)) : [];
  if (!needTags.length && !needMagic.length) return;
  const total = needTags.length + needMagic.length;
  const p = total > 30 ? progress('Reading file details') : null;
  let done = 0;
  for (const e of needTags) {
    if (p?.cancelled) break;
    try {
      const f = await (e.getFile ? e.getFile() : S.root.getFile(e.path));
      const m = await readTags(f);
      S.tags.set(e.path, { ...m.fields, bitrate: m.props.bitrate, duration: m.props.duration, sampleRate: m.props.sampleRate, codec: m.props.codec });
    } catch { S.tags.set(e.path, null); }
    p?.set(++done, total, e.name);
    if (done % 20 === 0) await tick();
  }
  for (const e of needMagic) {
    if (p?.cancelled) break;
    try { const f = await (e.getFile ? e.getFile() : S.root.getFile(e.path)); S.magic.set(e.path, sniffExt(new Uint8Array(await f.slice(0, 32).arrayBuffer()))); } catch { S.magic.set(e.path, null); }
    p?.set(++done, total, e.name);
  }
  p?.close();
}

function sniffExt(b) {
  const a = (o, n) => String.fromCharCode(...b.slice(o, o + n));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (a(0, 4) === '\x89PNG') return 'png';
  if (a(0, 4) === 'GIF8') return 'gif';
  if (a(0, 4) === 'RIFF' && a(8, 4) === 'WEBP') return 'webp';
  if (a(0, 4) === 'RIFF' && a(8, 4) === 'WAVE') return 'wav';
  if (a(0, 4) === 'RIFF' && a(8, 4) === 'AVI ') return 'avi';
  if (a(0, 4) === '%PDF') return 'pdf';
  if (a(0, 4) === 'PK\x03\x04') return 'zip';
  if (a(0, 4) === 'Rar!') return 'rar';
  if (a(0, 6) === '7z\xbc\xaf\x27\x1c') return '7z';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gz';
  if (a(0, 4) === 'fLaC') return 'flac';
  if (a(0, 4) === 'OggS') return a(28, 8) === 'OpusHead' ? 'opus' : 'ogg';
  if (a(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  if (a(4, 4) === 'ftyp') {
    const brand = a(8, 4);
    if (/^M4A|^M4B/.test(brand)) return 'm4a';
    if (/^hei|^mif1|^heix/.test(brand)) return 'heic';
    if (/^qt/.test(brand)) return 'mov';
    return 'mp4';
  }
  if (a(0, 4) === 'FORM' && /^AIF/.test(a(8, 4))) return 'aiff';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'mkv';
  return null;
}

let computeToken = 0;
async function recompute() {
  if (!S.root || S.mode === 'restore') { paintEmpty(); paintBar(); renderAnalyser(); return; }
  const token = ++computeToken;
  const cands = selectCandidates();
  await ensureExtras(cands);
  if (token !== computeToken) return;
  S.candidates = cands;
  let names; let errors = [];
  if (S.mode === 'ext') {
    names = extensionProposals(cands, S.ext, S.magic);
  } else {
    const items = cands.map((e) => ({ path: e.path, name: e.name, isDir: e.isDir, mtime: e.mtime, size: e.size, tags: S.tags.get(e.path) || null, detectedExt: S.magic.get(e.path) || null }));
    ({ names, errors } = runPipeline(items, S.rules, { scope: 'both', rootName: S.root.name, now: new Date() }));
  }
  const proposals = new Map();
  for (const [p, n] of names) if (!S.excluded.has(p)) proposals.set(p, n);
  S.plan = buildPlan(S.entries, proposals, { conflict: S.opts.conflict, windows: S.opts.windows, caseSensitive: S.opts.caseSensitive });
  S.rows = cands.map((e) => {
    const r = S.plan.rows.get(e.path);
    const wanted = names.get(e.path) ?? e.name;
    return { e, newName: r ? r.newName : e.name, wanted, status: S.excluded.has(e.path) ? (wanted !== e.name ? 'excluded' : 'unchanged') : (r ? r.status : 'unchanged'), issues: r?.issues || [] };
  });
  showRuleErrors(errors);
  filterRows();
  renderAnalyser();
  if (S.mode === 'ext') paintExtCounts();
}

function showRuleErrors(errors) {
  const ol = S.el.querySelector('#rn-rules');
  if (!ol) return;
  ol.querySelectorAll('.rule-error').forEach((x) => x.remove());
  for (const err of errors) {
    const i = S.rules.findIndex((r) => r.id === err.rule);
    const li = ol.children[i];
    if (li) li.append(h('p', { class: 'rule-error', role: 'alert' }, icon('triangle-alert'), err.msg));
  }
}

function filterRows() {
  const q = S.search.trim().toLowerCase();
  S.visible = S.rows.filter((r) => (!S.opts.changedOnly || r.newName !== r.e.name || r.status === 'invalid' || r.status === 'conflict' || r.status === 'excluded')
    && (!q || r.e.name.toLowerCase().includes(q) || r.newName.toLowerCase().includes(q)));
  S.list?.setCount(S.visible.length);
  paintEmpty();
  paintBar();
  const all = S.el.querySelector('#rn-all');
  if (all) { const ex = S.rows.filter((r) => S.excluded.has(r.e.path)).length; all.checked = ex === 0; all.indeterminate = ex > 0 && ex < S.rows.length; }
}

function paintEmpty() {
  const el = S.el.querySelector('#rn-empty');
  if (!el) return;
  clear(el);
  el.hidden = !!(S.root && S.visible.length);
  if (!S.root) {
    el.append(h('div', { class: 'empty-art', 'aria-hidden': 'true' }, h('span', { class: 'tape tape-sm' }, 'drop files here')),
      h('p', null, 'Open a folder or ZIP to start. Nothing changes until you press Rename, and every rename writes an undo file.'));
  } else if (!S.rows.length) el.append(h('p', null, 'No items match the current filters.'));
  else if (!S.visible.length) el.append(h('p', null, S.opts.changedOnly ? (S.mode === 'ext' ? 'No extensions change yet. Type a new extension next to a group, or turn on a quick option.' : 'No names change with the current rules.') : 'Nothing matches your search.'));
}

const STATUS = {
  ok: ['check', 'Will be renamed'], warn: ['triangle-alert', 'Renamed, with a warning'], 'renamed-suffix': ['hash', 'Numbered to avoid a clash'],
  conflict: ['circle-x', 'Skipped: name already taken'], invalid: ['circle-x', 'Invalid name'], unchanged: [null, 'Unchanged'], excluded: ['x', 'Excluded by you'],
};

function renderRow(el, i) {
  const r = S.visible[i];
  if (!r) return;
  const { e } = r;
  const changedName = r.newName !== e.name;
  const parts = diffChars(e.name, changedName ? r.newName : e.name);
  const oldEl = h('span', { class: 'fname mono' }, parts.filter((p) => p.t !== 'add').map((p) => (p.t === 'del' ? h('del', null, p.s) : p.s)));
  const newEl = h('span', { class: `fname mono ${changedName ? '' : 'muted'}` }, changedName ? parts.filter((p) => p.t !== 'del').map((p) => (p.t === 'add' ? h('mark', null, p.s) : p.s)) : (r.status === 'excluded' ? r.wanted : '—'));
  const dir = dirname(e.path);
  const [ic, label] = STATUS[r.status] || STATUS.unchanged;
  const tip = r.issues.length ? `${label}: ${r.issues.map((x) => x.msg).join('; ')}` : label;
  el.className = `vrow prow st-${r.status}`;
  el.append(
    h('input', { type: 'checkbox', class: 'check', checked: !S.excluded.has(e.path), 'aria-label': `Include ${e.name}`, onchange: (ev) => { if (ev.target.checked) S.excluded.delete(e.path); else S.excluded.add(e.path); recompute(); } }),
    h('span', { class: 'pcell' }, h('span', { class: 'pname' }, e.isDir ? icon('folder', 'ic-dir') : null, oldEl), dir ? h('span', { class: 'pdir mono' }, dir) : null),
    h('span', { class: 'pcell' }, newEl),
    h('span', { class: 'pstatus', title: tip, 'aria-label': tip }, ic ? icon(ic) : null),
  );
}

function toggleAll(on) {
  if (on) S.excluded.clear(); else for (const r of S.rows) S.excluded.add(r.e.path);
  recompute();
}

function paintBar() {
  const bar = S.el.querySelector('#rn-bar');
  if (!bar) return;
  clear(bar);
  const st = S.plan?.stats;
  const n = st ? st.changed : 0;
  const bad = S.rows.filter((r) => r.status === 'invalid' || r.status === 'conflict').length;
  const warn = S.rows.filter((r) => r.status === 'warn' || r.status === 'renamed-suffix').length;
  const where = !S.root ? '' : S.root.kind === 'dir' ? `in "${S.root.name}"` : S.root.kind === 'zip' ? 'inside the ZIP' : 'inside the downloaded ZIP';
  bar.append(
    h('div', { class: 'bar-info' },
      h('p', { class: 'bar-count' }, S.root ? h('strong', null, `${n.toLocaleString('en-US')} of ${S.rows.length.toLocaleString('en-US')}`) : 'No source', S.root ? ' will be renamed' : ''),
      h('p', { class: 'bar-sub muted' },
        bad ? h('span', { class: 'bad' }, `${bad} skipped. `) : null,
        warn ? h('span', { class: 'warn' }, `${warn} with warnings. `) : null,
        S.root && n ? `An undo file will be saved ${where}.` : '')),
    btn(S.root?.kind === 'dir' ? `Rename ${n || ''}`.trim() : 'Rename and save ZIP', () => runRename(), { cls: 'btn-primary btn-lg', ic: 'play', disabled: !n || S.busy }),
  );
}

/* ------------------------------------------------------------------ extensions mode */
function renderExtPanel() {
  const box = S.el.querySelector('#rn-ext');
  if (!box) return;
  clear(box);
  const o = S.ext;
  box.append(
    h('div', { class: 'panel-head' }, icon('file-text'), h('h2', null, 'Change extensions')),
    h('p', { class: 'muted' }, 'Works on the open folder, ZIP or imported files, subfolders included. Type a new extension next to a group, or use the quick options. An undo file is written first, like every rename.'),
    renderFields([
      { key: 'case', type: 'segment', label: 'Letter case', options: [['keep', 'Keep'], ['lower', 'lower'], ['upper', 'UPPER']] },
      { key: 'unify', type: 'checkbox', label: 'Unify spelling variants', help: 'jpeg to jpg, tiff to tif, htm to html, mpeg to mpg, aif to aiff, yml to yaml and more.' },
      { key: 'fixContent', type: 'checkbox', label: 'Fix extensions that do not match the contents', help: 'Reads the first bytes of each file, so a PNG saved as .jpg becomes .png. Knows common image, audio, video, archive and PDF formats.' },
      { key: 'addMissing', type: 'checkbox', label: 'Add a missing extension from the contents' },
      { key: 'compound', type: 'checkbox', label: 'Treat .tar.gz and similar as one extension' },
    ], o, () => { saveState(); renderExtGroups(); changed(); }),
    h('div', { class: 'ext-hint', id: 'rn-ext-hint' }),
    h('div', { class: 'col-head' }, h('h3', null, 'Extensions found'),
      btn('Clear typed changes', () => { o.map = {}; renderExtGroups(); changed(); }, { cls: 'btn-sm btn-ghost', ic: 'x' })),
    h('div', { class: 'ext-groups', id: 'rn-ext-groups', role: 'list' }),
    h('p', { class: 'field-help' }, 'Type the new extension without the dot. Type - to remove an extension. Leave empty to keep it (quick options still apply).'),
  );
  renderExtGroups();
}

function renderExtGroups() {
  const wrap = S.el.querySelector('#rn-ext-groups');
  if (!wrap) return;
  clear(wrap);
  const o = S.ext;
  const files = S.root ? selectCandidates() : [];
  const groups = extGroups(files, { compound: o.compound !== false });
  if (!groups.length) { wrap.append(h('p', { class: 'muted' }, S.root ? 'No files match the filters.' : 'Open a folder, a ZIP or some files to see their extensions.')); paintExtHint([]); return; }
  for (const g of groups) {
    const auto = newNameFor({ name: `x.${g.ext}` }, { ...o, map: {}, fixContent: false, addMissing: false }, null).to;
    const input = h('input', {
      class: 'input mono', value: o.map[g.ext] ?? '', spellcheck: 'false', autocomplete: 'off',
      placeholder: g.ext && auto !== g.ext ? auto : 'keep', 'aria-label': `New extension for ${g.ext ? `.${g.ext}` : 'files without one'}`,
      oninput: (e) => { if (e.target.value.trim() === '') delete o.map[g.ext]; else o.map[g.ext] = e.target.value; changed(); },
    });
    wrap.append(h('div', { class: 'ext-row', role: 'listitem', dataset: { ext: g.ext } },
      h('span', { class: 'ext-from mono', title: g.sample }, g.ext ? `.${g.ext}` : '(none)'),
      h('span', { class: 'ext-count muted' }, `${g.count.toLocaleString('en-US')}`),
      icon('arrow-right', 'ext-arrow'),
      input,
      h('span', { class: 'ext-result', 'aria-live': 'polite' })));
  }
  paintExtHint(groups);
  paintExtCounts();
}

function paintExtHint(groups) {
  const el = S.el.querySelector('#rn-ext-hint');
  if (!el) return;
  clear(el);
  const fam = new Map();
  for (const g of groups) { if (!g.ext) continue; const k = UNIFY[g.ext.toLowerCase()] || g.ext.toLowerCase(); if (!fam.has(k)) fam.set(k, new Set()); fam.get(k).add(g.ext); }
  const mixed = [...fam.entries()].filter(([, v]) => v.size > 1);
  const noExt = groups.find((g) => !g.ext);
  if (mixed.length) {
    el.append(h('p', { class: 'f-warn' }, icon('triangle-alert'), h('span', null, `Mixed spellings: ${mixed.slice(0, 4).map(([k, v]) => `${[...v].map((x) => `.${x}`).join(', ')} (all .${k})`).join('; ')}.`)),
      btn('Make them consistent', () => { S.ext.unify = true; S.ext.case = 'lower'; saveState(); renderExtPanel(); changed(); }, { cls: 'btn-sm', ic: 'wand-sparkles' }));
  }
  if (noExt && !S.ext.addMissing) el.append(h('p', { class: 'f-info' }, icon('info'), h('span', null, `${noExt.count} file${noExt.count === 1 ? ' has' : 's have'} no extension. "Add a missing extension" can name them from their contents.`)));
}

function paintExtCounts() {
  const wrap = S.el?.querySelector('#rn-ext-groups');
  if (!wrap) return;
  const compound = S.ext.compound !== false;
  const byExt = new Map();
  for (const r of S.rows) {
    if (r.e.isDir) continue;
    const ext = compound ? splitName(r.e.name).ext : (r.e.name.lastIndexOf('.') > 0 ? r.e.name.slice(r.e.name.lastIndexOf('.') + 1) : '');
    const c = byExt.get(ext) || { n: 0, to: new Set() };
    if (r.newName !== r.e.name && r.status !== 'excluded') { c.n++; const t = compound ? splitName(r.newName).ext : r.newName.slice(r.newName.lastIndexOf('.') + 1); c.to.add(t ? `.${t}` : 'none'); }
    byExt.set(ext, c);
  }
  for (const row of wrap.querySelectorAll('.ext-row')) {
    const c = byExt.get(row.dataset.ext);
    const out = row.querySelector('.ext-result');
    out.textContent = c && c.n ? `${c.n} to ${[...c.to].slice(0, 2).join(', ')}` : '';
    row.classList.toggle('is-changing', !!(c && c.n));
  }
}

/* ------------------------------------------------------------------ analyser */
function renderAnalyser() {
  const box = S.el.querySelector('#rn-analyser');
  if (!box) return;
  clear(box);
  box.append(h('div', { class: 'panel-head' }, icon('wand-sparkles'), h('h3', null, 'Pattern analyser')));
  if (!S.root || !S.candidates.length) { box.append(h('p', { class: 'muted' }, 'Open some files and the analyser will read their naming pattern and suggest a cleaner one.')); return; }
  const a = analyze(S.candidates, { scope: 'both' });
  S.analysis = a;
  box.append(
    h('dl', { class: 'pattern' },
      h('dt', null, 'Now'), h('dd', null, h('code', { class: 'mono' }, a.detected.pattern || 'mixed names')),
      h('dt', null, 'Proposed'), h('dd', null, h('span', { class: 'tape' }, a.proposed || a.detected.pattern || '[text]'))),
  );
  if (a.findings.length) box.append(h('ul', { class: 'findings' }, a.findings.map((f) => h('li', { class: `f-${f.level}` }, icon(f.level === 'warn' ? 'triangle-alert' : f.level === 'ok' ? 'circle-check' : 'info'), h('span', null, f.text)))));
  const sample = S.candidates.slice(0, 3).map((e) => ({ path: e.path, name: e.name, isDir: e.isDir, mtime: e.mtime, size: e.size, tags: S.tags.get(e.path) || null }));
  for (const s of a.suggestions) {
    let ex = [];
    try { const { names } = runPipeline(sample, s.rules, { scope: 'both', rootName: S.root.name }); ex = sample.map((x) => [x.name, names.get(x.path) || x.name]); } catch { /* ignore */ }
    const clone = () => s.rules.map((r) => makeRule(r.type, JSON.parse(JSON.stringify(r.opts))));
    box.append(h('article', { class: `suggestion ${s.recommended ? 'is-rec' : ''}` },
      h('h4', null, s.title, s.recommended ? h('span', { class: 'pill pill-accent' }, 'Recommended') : null),
      h('p', { class: 'muted' }, s.why),
      ex.length ? h('ul', { class: 'examples mono' }, ex.map(([o, n]) => h('li', null, h('span', { class: 'ex-old' }, o), h('span', { class: 'ex-new' }, n)))) : null,
      h('div', { class: 'btn-row' },
        btn('Use these rules', () => { S.rules = clone(); renderRules(); changed(); toast(`Applied "${s.title}". Review the preview, then press Rename.`); }, { cls: 'btn-sm btn-primary' }),
        btn('Add to my rules', () => { S.rules.push(...clone()); renderRules(); changed(); }, { cls: 'btn-sm' }))));
  }
}

/* ------------------------------------------------------------------ execute */
async function runRename() {
  if (!S.plan || !S.plan.ops.length || S.busy) return;
  const root = S.root;
  const { stats, ops } = S.plan;
  const inPlace = root.kind === 'dir';
  const ok = await confirmDialog(S.mode === 'ext' ? 'Change extensions?' : 'Rename files?', h('div', null,
    h('p', null, `${stats.changed.toLocaleString('en-US')} item${stats.changed === 1 ? '' : 's'} will be renamed ${inPlace ? `directly in "${root.name}"` : 'and you will get a new ZIP'}.`),
    h('p', { class: 'muted' }, 'An undo file is written first, so you can put every name back with Restore, even from another computer.'),
    stats.invalid || stats.conflict ? h('p', { class: 'warn' }, `${stats.invalid + stats.conflict} item(s) will be skipped.`) : null), { okText: 'Rename' });
  if (!ok) return;
  if (inPlace && !(await root.verifyPermission(true))) { toast('Permission was not granted.', { type: 'error' }); return; }
  root.allowCopyFallback = S.opts.copyFallback;
  S.busy = true; paintBar();
  const extMode = S.mode === 'ext';
  const manifest = createRenameManifest({
    root: root.name, source: root.kind, ops, stats, tool: extMode ? 'extension' : 'renamer',
    rules: extMode ? [{ type: 'extensions', opts: JSON.parse(JSON.stringify(S.ext)) }] : S.rules.filter((r) => r.enabled).map(({ type, opts }) => ({ type, opts })),
  });
  const mName = manifestFileName('rename');
  let wroteManifest = false;
  try { await root.writeText(mName, JSON.stringify(manifest, null, 2)); wroteManifest = true; } catch (e) {
    const go = await confirmDialog('Could not write the undo file', `${e.message}. Continue anyway? The undo data will still be kept in History and offered as a download.`, { okText: 'Continue' });
    if (!go) { S.busy = false; paintBar(); return; }
  }
  const p = progress('Renaming');
  const ctl = new AbortController();
  const timer = setInterval(() => { if (p.cancelled) ctl.abort(); }, 100);
  const res = await executeOps(root, ops, { signal: ctl.signal, onStep: (i, op) => p.set(i, ops.length, basename(op.to)) });
  clearInterval(timer);
  manifest.operations = res.done.map((o) => ({ kind: o.kind, from: o.from, to: o.to }));
  manifest.status = res.error ? 'partial' : 'complete';
  manifest.completed = res.done.length;
  manifest.planned = ops.length;
  if (res.error) manifest.error = res.error.message;
  const text = JSON.stringify(manifest, null, 2);
  if (wroteManifest) { try { await root.writeText(mName, text); } catch { /* ignore */ } }
  else download(new Blob([text], { type: 'application/json' }), mName);
  await addHistory({ id: manifest.id, type: 'rename', createdAt: manifest.createdAt, rootName: root.name, source: root.kind, manifestName: mName, manifest, handle: root.handle || null, status: manifest.status });
  let fin = { message: '' };
  if (!inPlace) {
    p.set(0, 100, 'Building ZIP…');
    try { fin = await root.finalize({ onProgress: (pc) => p.set(Math.round(pc), 100, 'Building ZIP…'), download }); } catch (e) { toast(`ZIP failed: ${e.message}`, { type: 'error' }); }
  }
  p.close();
  S.busy = false;
  S.excluded.clear();
  if (res.error) toast(`Stopped after ${res.done.length} of ${ops.length}: ${res.error.message}. The undo file covers what was done.`, { type: 'error', timeout: 12000 });
  else toast(`Renamed ${res.done.length.toLocaleString('en-US')} item${res.done.length === 1 ? '' : 's'}. ${fin.message || ''}`, {
    type: 'success', timeout: 10000, action: res.done.length ? { label: 'Undo', onClick: () => undoNow(root, manifest, mName) } : null,
  });
  await scan();
}

async function undoNow(root, manifest, mName) {
  S.mode = 'restore';
  S.root = root;
  await scan();
  await loadRestore(manifest, mName);
}

/* ------------------------------------------------------------------ restore */
function renderRestore(body) {
  const wrap = h('div', { class: 'restore' });
  body.append(wrap);
  const openUndoFile = async () => {
    const [f] = await pickFiles({ accept: '.json,application/json', multiple: false });
    if (!f) return null;
    try {
      const mm = parseManifest(await readFileText(f));
      if (mm.type !== 'rename') throw new Error('This is a tag backup, not a rename undo file. Open it in the Tag editor.');
      return { manifest: mm, fileName: f.name };
    } catch (e) { toast(e.message, { type: 'error' }); return null; }
  };
  const targetButtons = (manifest, fileName, primary = true) => [
    support.dirPicker ? btn('Open folder', () => pickTargetFor(manifest, fileName, 'folder'), { cls: primary ? 'btn-primary' : '', ic: 'folder-open' }) : null,
    btn('Open ZIP', () => pickTargetFor(manifest, fileName, 'zip'), { ic: 'file-archive' }),
    btn('Import a folder', () => pickTargetFor(manifest, fileName, 'import'), { ic: 'upload' }),
  ];
  if (!S.root) {
    const pend = S.pendingShown;
    wrap.append(h('div', { class: 'panel' },
      h('h2', null, 'Restore original names'),
      pend
        ? h('p', null, 'Undo file loaded: ', h('strong', { class: 'mono' }, pend.fileName), `. It was made for "${pend.manifest.root}". Now choose where those files are on this computer: the same folder, its parent, or the extracted ZIP all work.`)
        : h('p', null, 'Open the folder (or ZIP) that was renamed. NameTag finds the undo files inside it, also in subfolders. Got only the undo file, for example on another computer? Open it first, then choose the folder.'),
      h('div', { class: 'btn-row' },
        ...(pend ? targetButtons(pend.manifest, pend.fileName) : [
          support.dirPicker ? btn('Open folder', () => openFolder(), { cls: 'btn-primary', ic: 'folder-open' }) : null,
          btn('Open ZIP', () => openZip(), { ic: 'file-archive' }),
          btn('Import a folder', () => importFiles(true), { ic: 'upload' }),
        ]),
        btn(pend ? 'Use a different undo file…' : 'Open an undo file first…', async () => { const r = await openUndoFile(); if (r) { S.pendingShown = r; render(); } }, { ic: 'file-json', cls: 'btn-ghost' }))));
    return;
  }
  S.pendingShown = null;
  const list = h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, icon('undo-2'), h('h2', null, 'Undo files in this source')),
    S.root.manifests.some((m) => /^nametag-rename-/i.test(m.name)) ? null : h('p', { class: 'muted' }, 'No NameTag undo files were found here. If the files came from another computer, open the undo file that came with them.'),
    h('ul', { class: 'manifest-list' }, S.root.manifests.filter((m) => /^nametag-rename-/i.test(m.name)).sort((a, b) => (a.name < b.name ? 1 : -1)).map((m) => h('li', null,
      h('button', { type: 'button', class: `manifest-item ${S.restore?.name === m.path ? 'is-active' : ''}`, onclick: async () => {
        try { const mm = parseManifest(await (await m.getFile()).text()); await loadRestore(mm, m.path); } catch (e) { toast(e.message, { type: 'error' }); }
      } }, icon('file-json'), h('span', { class: 'mono' }, m.path))))),
    h('div', { class: 'btn-row' }, btn('Open an undo file…', async () => {
      const r = await openUndoFile();
      if (r) await loadRestore(r.manifest, null, true, null, r.fileName);
    }, { ic: 'upload' })));
  wrap.append(list, h('div', { class: 'panel', id: 'rn-restore-detail' }));
  paintRestore();
}

async function loadRestore(manifest, name = null, external = false, remap = null, fileName = null) {
  const all = await S.root.list({ recursive: true, includeHidden: true, includeTemp: true, withFiles: false });
  const present = all.map((e) => e.path);
  const saved = currentPathsAfter(manifest.operations);
  const hasDirOps = manifest.operations.some((o) => o.kind === 'dir');
  const hint = name ? dirname(name) : '';
  if (!remap) remap = detectRemap(saved, present, { caseSensitive: S.opts.caseSensitive, allowDirs: !hasDirOps, hint });
  S.restore = { manifest, name: name || null, fileName: fileName || (name ? basename(name) : null), external, present, saved, hasDirOps, remap };
  computeRestore();
  S.mode = 'restore';
  render();
}

function computeRestore() {
  const R = S.restore;
  const rm = R.hasDirOps ? { ...R.remap, byName: false } : R.remap;
  R.ops = remapOps(reverseOps(R.manifest.operations), rm);
  R.sim = simulateOps(R.present, R.ops, { caseSensitive: S.opts.caseSensitive });
  R.matched = countMatches(R.saved, R.present, rm, { caseSensitive: S.opts.caseSensitive });
}

function paintRestore() {
  const box = S.el.querySelector('#rn-restore-detail');
  if (!box) return;
  clear(box);
  if (!S.restore) { box.append(h('p', { class: 'muted' }, 'Choose an undo file to see what would be restored.')); return; }
  const R = S.restore;
  const { manifest: m, sim } = R;
  const all = R.matched === R.saved.length;
  const panel = remapPanel({
    manifest: m, rootName: S.root.name, remap: R.remap, matched: R.matched, total: R.saved.length,
    allowDirs: !R.hasDirOps, dirsNote: 'Not available when folders themselves were renamed; use the two boxes above instead.',
    samples: R.saved.slice(0, 3).map((p) => [p, mapPath(p, R.hasDirOps ? { ...R.remap, byName: false } : R.remap) || p]).filter(([a, b]) => a !== b),
    onChange: (rm) => { R.remap = { ...R.remap, ...rm }; computeRestore(); paintRestore(); },
    onDetect: () => { R.remap = detectRemap(R.saved, R.present, { caseSensitive: S.opts.caseSensitive, allowDirs: !R.hasDirOps, hint: R.name ? dirname(R.name) : '' }); computeRestore(); paintRestore(); },
    onPickFolder: (e) => menu(e.currentTarget, [
      support.dirPicker ? { label: 'Open folder…', icon: 'folder-open', onClick: () => pickTargetFor(m, R.fileName, 'folder') } : null,
      { label: 'Open ZIP…', icon: 'file-archive', onClick: () => pickTargetFor(m, R.fileName, 'zip') },
      { label: 'Import a folder (copy)…', icon: 'upload', onClick: () => pickTargetFor(m, R.fileName, 'import') },
    ]),
  });
  const pathBox = h('details', { class: 'remap-wrap', open: !all || !isIdentity(R.remap) ? '' : null },
    h('summary', null, icon(all ? 'circle-check' : 'triangle-alert'), all ? `All ${R.saved.length} items found here. Paths and folder` : 'Paths need attention'), panel);
  box.append(
    h('div', { class: 'panel-head' }, icon('rotate-ccw'), h('h2', null, m.tool === 'extension' ? 'Restore extensions' : 'Restore preview')),
    h('p', null, `Created ${formatDate(new Date(m.createdAt), 'D MMM YYYY, HH:mm')} for "${m.root}". ${summarizeManifest(m)}.`,
      m.status === 'partial' ? ' The original run stopped early; only the completed renames are listed.' : '',
      m.restoredAt ? ` Already restored on ${formatDate(new Date(m.restoredAt), 'D MMM YYYY, HH:mm')}.` : ''),
    pathBox,
    h('p', { class: 'restore-stats' },
      h('span', { class: 'ok' }, `${sim.ok} ready`), h('span', { class: 'muted' }, `${sim.missing} not found or already restored`), sim.conflict ? h('span', { class: 'bad' }, `${sim.conflict} blocked by another file`) : null),
    h('ul', { class: 'restore-list mono' }, sim.results.filter((r) => !basename(r.from).startsWith('.nametag-tmp-') || r.status !== 'ok').slice(0, 400).map((r) => h('li', { class: `st-${r.status}` },
      h('span', { class: 'ex-old' }, r.from), h('span', { class: 'ex-new' }, r.to), h('span', { class: 'pill' }, { ok: 'ready', missing: 'missing', conflict: 'blocked' }[r.status])))),
    sim.results.length > 400 ? h('p', { class: 'muted' }, `…and ${sim.results.length - 400} more.`) : null,
    h('div', { class: 'btn-row' }, btn(`Restore ${sim.ok} name${sim.ok === 1 ? '' : 's'}`, () => runRestore(), { cls: 'btn-primary', ic: 'rotate-ccw', disabled: !sim.ok || S.busy })),
  );
}

async function runRestore() {
  const { manifest, sim, name, remap } = S.restore;
  const root = S.root;
  if (!isIdentity(remap)) manifest.lastRemap = { strip: remap.strip, prefix: remap.prefix, dirs: remap.byName ? remap.dirs : [], appliedTo: root.name };
  const ops = sim.results.filter((r) => r.status === 'ok').map(({ kind, from, to }) => ({ kind, from, to }));
  if (!(await confirmDialog('Restore original names?', `${ops.length} item(s) will get their previous names back.`, { okText: 'Restore' }))) return;
  if (root.kind === 'dir' && !(await root.verifyPermission(true))) return;
  root.allowCopyFallback = S.opts.copyFallback;
  S.busy = true;
  const p = progress('Restoring');
  const res = await executeOps(root, ops, { onStep: (i, op) => p.set(i, ops.length, basename(op.to)) });
  manifest.restoredAt = new Date().toISOString();
  manifest.restoreStatus = res.error ? 'partial' : 'complete';
  if (name && !S.restore.external) { try { await root.writeText(name, JSON.stringify(manifest, null, 2)); } catch { /* ignore */ } }
  await updateHistory(manifest.id, { manifest, status: res.error ? 'restore-partial' : 'restored' });
  if (root.kind !== 'dir') { try { await root.finalize({ onProgress: (pc) => p.set(Math.round(pc), 100, 'Building ZIP…'), download }); } catch (e) { toast(e.message, { type: 'error' }); } }
  p.close();
  S.busy = false;
  toast(res.error ? `Restore stopped: ${res.error.message}` : `Restored ${res.done.length} name${res.done.length === 1 ? '' : 's'}.`, { type: res.error ? 'error' : 'success' });
  S.restore = null;
  await scan();
}
