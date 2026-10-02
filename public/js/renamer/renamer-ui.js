// Bulk renamer view: sources, rule pipeline, pattern analyser, live preview, execution with an undo file, and restore.
import { isCompact, rowHeightFor, h, icon, btn, clear, toast, openDialog, confirmDialog, promptDialog, progress, tick, menu, VirtualList, download, pickFiles, readFileText, renderFields } from '../core/ui.js';
import { dirname, basename, splitName, naturalCompare, diffChars, debounce, formatBytes, formatDate } from '../core/utils.js';
import { DirRoot, pickFolderRoot, ZipRoot, MemRoot, support, filesFromDataTransfer } from '../core/sources.js';
import { buildPlan, executeOpsParallel, reverseOps, simulateOps } from '../core/planner.js';
import { startJob, activeFor, conflictFor, onJobs } from '../core/jobs.js';
import { createRenameManifest, manifestFileName, parseManifest, summarizeManifest, normaliseInterrupted } from '../core/manifest.js';
import { addHistory, updateHistory } from '../core/history.js';
import { RULES, RULE_GROUPS, makeRule, runPipeline, TAG_VARS } from './rules.js';
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
  analysis: null, restore: null, list: null, pane: 'preview', ext: { ...DEFAULT_EXT_OPTS, map: {} }, pending: null,
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
  let wasBusy = false;
  onJobs(() => {
    const busy = !!activeFor(S.root);
    if (busy === wasBusy) return;
    wasBusy = busy; paintBar();
    if (S.mode === 'restore') paintRestore();
  });
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
  if (support.folderPicker) bar.append(btn('Open folder', () => openFolder(), { cls: 'btn-primary', ic: 'folder-open' }));
  // No real folder picker here (most Android browsers): "import a folder" is the only way to bring
  // one in at all, so it gets a real, visible button instead of hiding inside the "more" menu, where
  // it reads as "the folder won't open" rather than "there's another way to open it".
  else bar.append(btn('Import a folder', () => importFiles(true), { cls: 'btn-primary', ic: 'folder' }));
  bar.append(btn('Open ZIP', () => openZip(), { ic: 'file-archive' }));
  const more = btn('', (e) => menu(e.currentTarget, [
    { label: 'Import files…', icon: 'upload', onClick: () => importFiles(false) },
    support.folderPicker ? { label: 'Import a folder (copy)…', icon: 'folder', onClick: () => importFiles(true) } : null,
    { separator: true },
    { label: 'Rescan', icon: 'refresh-cw', disabled: !S.root, onClick: () => scan() },
  ]), { title: 'More sources', ic: 'ellipsis-vertical' });
  more.dataset.menuAnchor = '';
  bar.append(more);
  const line = S.el.querySelector('#rn-source-line');
  clear(line);
  if (!S.root) {
    line.append(h('span', { class: 'muted' }, support.folderPicker
      ? 'Open a folder to rename in place, or open a ZIP. You can also drop files here.'
      : 'This browser cannot rename files on disk in place. Import a folder or files, or open a ZIP: you get a renamed ZIP back, with the undo file inside.'));
    return;
  }
  const kind = { dir: 'Folder', zip: 'ZIP archive', mem: 'Imported copy' }[S.root.kind] || S.root.kind;
  line.append(icon(S.root.kind === 'zip' ? 'file-archive' : 'folder'), h('strong', null, S.root.name), h('span', { class: 'pill' }, kind),
    h('span', { class: 'muted' }, `${S.entries.filter((e) => !e.isDir).length.toLocaleString('en-US')} files, ${S.entries.filter((e) => e.isDir).length.toLocaleString('en-US')} folders`));
  if (S.root.manifests.length) line.append(h('button', { class: 'link', type: 'button', onclick: () => { S.mode = 'restore'; render(); } }, `${S.root.manifests.length} undo file${S.root.manifests.length > 1 ? 's' : ''} found`));
}

/* ------------------------------------------------------------------ sources */
async function openFolder() {
  try { await setRoot(await pickFolderRoot()); } catch (e) { if (e.name !== 'AbortError') toast(e.message, { type: 'error' }); }
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
function setPane(v) {
  S.pane = v;
  S.el.querySelector('.workbench')?.classList.replace(v === 'rules' ? 'pane-preview' : 'pane-rules', `pane-${v}`);
  S.el.querySelectorAll('.pane-switch .seg').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.pane === v)));
  if (v === 'preview') requestAnimationFrame(() => S.list?.refresh?.());
}

function render() {
  if (!S.el) return;
  renderSource();
  S.el.querySelectorAll('.toolbar .segment .seg').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === S.mode)));
  const body = S.el.querySelector('#rn-body');
  clear(body);
  S.list = null;
  if (S.mode === 'restore') { renderRestore(body); return; }
  // Phones show one pane at a time; the switch is hidden on wider screens (CSS).
  const paneBtn = (v, label) => h('button', { type: 'button', class: 'seg', role: 'radio', 'aria-checked': String(S.pane === v), dataset: { pane: v }, onclick: () => setPane(v) }, label);
  body.append(
    h('div', { class: 'segment pane-switch', role: 'radiogroup', 'aria-label': 'Show' },
      paneBtn('rules', S.mode === 'ext' ? 'Extensions' : 'Rules'), paneBtn('preview', 'Preview')),
    h('div', { class: `workbench pane-${S.pane}` },
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
            h('label', { class: 'chip-toggle' }, h('input', { type: 'checkbox', checked: S.opts.changedOnly, onchange: (e) => { S.opts.changedOnly = e.target.checked; saveState(); filterRows(); } }), h('span', null, 'Changed only')))),
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
  S.list = new VirtualList(vp, { rowHeight: rowHeightFor(64, 54, 48), renderRow: renderRow });
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
    if (v === '' || v == null) continue;
    const label = f.label.replace(/\s*\(.*\)$/, '');
    if (f.type === 'bool') { if (v) parts.push(label); continue; }
    // Defaults are noise ("Dashes: Keep"), except for the rule's main choice and the fields that carry its meaning.
    const primary = f === def.fields.find((x) => x.type === 'select') || ['find', 'tpl', 'sep', 'marker', 'order', 'fmt'].includes(f.key);
    if (v === f.default && !primary) continue;
    let shown = f.type === 'select' ? (f.options.find((o) => o[0] === v) || [v, v])[1] : String(v);
    // Make whitespace-only values (a " - " separator, a single space) visible instead of looking empty.
    if (typeof v === 'string' && v !== v.trim()) shown = `“${v.replace(/ /g, '·')}”`;
    parts.push(`${label}: ${shown}`);
    if (parts.length >= 4) break;
  }
  return parts.join(' · ') || def.desc;
}

function renderRules() {
  const ol = S.el.querySelector('#rn-rules');
  if (!ol) return;
  clear(ol);
  if (!S.rules.length) ol.append(h('li', { class: 'rule-empty' }, 'No rules yet. Add one, pick a preset, or use a suggestion from the analyser below.'));
  S.rules.forEach((r, i) => {
    const def = RULES[r.type];
    const sumText = ruleSummary(r);
    const summary = h('span', { class: 'rule-summary', title: sumText }, sumText);
    const bodyId = `rule-body-${r.id}`;
    const li = h('li', { class: `rule ${r.enabled ? '' : 'is-off'} ${r.open ? 'is-open' : ''}` },
      h('div', { class: 'rule-head' },
        h('span', { class: 'rule-num', 'aria-hidden': 'true' }, String(i + 1)),
        h('button', { type: 'button', class: 'rule-toggle', 'aria-expanded': String(!!r.open), 'aria-controls': bodyId, onclick: () => { r.open = !r.open; renderRules(); } },
          h('span', { class: 'rule-ic', 'aria-hidden': 'true' }, icon(def.icon || 'wand-sparkles')),
          h('span', { class: 'rule-text' }, h('span', { class: 'rule-title' }, def.label), summary),
          icon(r.open ? 'chevron-up' : 'chevron-down', 'rule-chev')),
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
      const form = renderFields(ruleFields(def), r.opts, () => { const t = ruleSummary(r); summary.textContent = t; summary.title = t; changed(); });
      li.append(h('div', { class: 'rule-body', id: bodyId }, h('p', { class: 'rule-desc' }, def.desc), form));
    }
    ol.append(li);
  });
}

function moveRule(i, d) { const [r] = S.rules.splice(i, 1); S.rules.splice(i + d, 0, r); renderRules(); changed(); }

function addRuleMenu(anchor) {
  const item = ([type, def]) => ({
    label: def.label, icon: def.icon, hint: def.desc,
    onClick: () => { const r = makeRule(type); r.open = true; S.rules.push(r); renderRules(); changed(); },
  });
  const all = Object.entries(RULES);
  menu(anchor, RULE_GROUPS.flatMap(([g, title]) => {
    const list = all.filter(([, d]) => (d.group || 'advanced') === g);
    return list.length ? [{ header: title }, ...list.map(item)] : [];
  }), { cls: 'menu-wide' });
}

function presetsMenu(anchor) {
  const user = loadUserPresets();
  const use = (rules, name) => { S.rules = rules; renderRules(); changed(); toast(`Preset "${name}" loaded.`); if (isCompact()) setPane('preview'); };
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
  const oldEl = h('span', { class: 'fname mono', title: e.name }, parts.filter((p) => p.t !== 'add').map((p) => (p.t === 'del' ? h('del', null, p.s) : p.s)));
  const newEl = h('span', { class: `fname mono ${changedName ? '' : 'muted'}`, title: changedName ? r.newName : null }, changedName ? parts.filter((p) => p.t !== 'del').map((p) => (p.t === 'add' ? h('mark', null, p.s) : p.s)) : (r.status === 'excluded' ? r.wanted : '—'));
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
  const pv = S.el.querySelector('.pane-switch [data-pane="preview"]');
  if (pv) pv.textContent = S.root ? `Preview (${n.toLocaleString('en-US')})` : 'Preview';
  const rl = S.el.querySelector('.pane-switch [data-pane="rules"]');
  if (rl && S.mode !== 'ext') rl.textContent = `Rules (${S.rules.filter((r) => r.enabled).length})`;
  const warn = S.rows.filter((r) => r.status === 'warn' || r.status === 'renamed-suffix').length;
  const running = activeFor(S.root);
  const where = !S.root ? '' : S.root.kind === 'dir' ? `in "${S.root.name}"` : S.root.kind === 'zip' ? 'inside the ZIP' : 'inside the downloaded ZIP';
  bar.append(
    h('div', { class: 'bar-info' },
      h('p', { class: 'bar-count' }, S.root ? h('strong', null, `${n.toLocaleString('en-US')} of ${S.rows.length.toLocaleString('en-US')}`) : 'No source', S.root ? ' will be renamed' : ''),
      h('p', { class: 'bar-sub muted' },
        bad ? h('span', { class: 'bad' }, `${bad} skipped. `) : null,
        warn ? h('span', { class: 'warn' }, `${warn} with warnings. `) : null,
        running ? 'Running in the background. You can switch screens; progress is at the top.' : S.root && n ? `An undo file will be saved ${where}.` : '')),
    btn(running ? 'Renaming…' : S.root?.kind === 'dir' ? `Rename ${n || ''}`.trim() : 'Rename and save ZIP', () => runRename(), { cls: 'btn-primary btn-lg', ic: 'play', disabled: !n || !!running }),
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
      ex.length ? h('ul', { class: 'examples examples-stack mono' }, ex.map(([o, n]) => h('li', null, h('span', { class: 'ex-old', title: o }, o), h('span', { class: 'ex-new', title: n }, n)))) : null,
      h('div', { class: 'btn-row' },
        btn('Use these rules', () => { S.rules = clone(); renderRules(); changed(); toast(`Applied "${s.title}". Review the preview, then press Rename.`); if (isCompact()) setPane('preview'); }, { cls: 'btn-sm btn-primary' }),
        btn('Add to my rules', () => { S.rules.push(...clone()); renderRules(); changed(); }, { cls: 'btn-sm' }))));
  }
}

/* ------------------------------------------------------------------ execute */
const nf = (n) => Number(n).toLocaleString('en-US');
const busyToast = () => toast('A rename or tag save is still running on this folder. It keeps going in the background; try again when it has finished.', { type: 'warn', timeout: 7000 });

async function runRename() {
  if (!S.plan || !S.plan.ops.length) return;
  const root = S.root;
  if (activeFor(root) || await conflictFor(root)) { busyToast(); return; }
  // Freeze the plan now: the person may change rules, open another folder or leave this screen while it runs.
  const { stats } = S.plan;
  const ops = S.plan.ops.map(({ kind, from, to }) => ({ kind, from, to }));
  const inPlace = root.kind === 'dir';
  const extMode = S.mode === 'ext';
  const ok = await confirmDialog(extMode ? 'Change extensions?' : 'Rename files?', h('div', null,
    h('p', null, `${nf(stats.changed)} item${stats.changed === 1 ? '' : 's'} will be renamed ${inPlace ? `directly in "${root.name}"` : 'and you will get a new ZIP'}.`),
    h('p', { class: 'muted' }, 'It runs in the background, so you can switch screens or apps while it works. An undo file is written first, so you can put every name back with Restore, even from another computer.'),
    stats.invalid || stats.conflict ? h('p', { class: 'warn' }, `${stats.invalid + stats.conflict} item(s) will be skipped.`) : null), { okText: 'Rename' });
  if (!ok) return;
  if (inPlace && !(await root.verifyPermission(true))) { toast('Permission was not granted.', { type: 'error' }); return; }
  if (activeFor(root)) { busyToast(); return; } // a second click while the dialog was open
  root.allowCopyFallback = S.opts.copyFallback;
  const manifest = createRenameManifest({
    root: root.name, source: root.kind, ops, stats, tool: extMode ? 'extension' : 'renamer',
    rules: extMode ? [{ type: 'extensions', opts: JSON.parse(JSON.stringify(S.ext)) }] : S.rules.filter((r) => r.enabled).map(({ type, opts }) => ({ type, opts: JSON.parse(JSON.stringify(opts)) })),
  });
  const mName = manifestFileName('rename');
  let wroteManifest = false;
  try { await root.writeText(mName, JSON.stringify(manifest, null, 2)); wroteManifest = true; } catch (e) {
    const go = await confirmDialog('Could not write the undo file', `${e.message}. Continue anyway? The undo data will still be kept in History and offered as a download.`, { okText: 'Continue' });
    if (!go) return;
  }
  await addHistory({ id: manifest.id, type: 'rename', createdAt: manifest.createdAt, rootName: root.name, source: root.kind, manifestName: mName, manifest, handle: root.handle || null, status: 'in-progress' });
  S.excluded.clear();
  startRenameJob({ root, manifest, mName, ops, prior: [], wroteManifest, title: `${extMode ? 'Changing extensions' : 'Renaming'}: ${nf(ops.length)} step${ops.length === 1 ? '' : 's'} in "${root.name}"` });
  paintBar();
}

/**
 * Run (or finish) the renames of one undo file as a background job.
 * `ops` are executed in parallel where that cannot change the outcome (see opDependencies in planner.js);
 * `prior` are operations an earlier, interrupted run already did.
 */
function startRenameJob({ root, manifest, mName, ops, prior, wroteManifest, title }) {
  const inPlace = root.kind === 'dir';
  const total = prior.length + ops.length;
  const job = startJob({ id: manifest.id, kind: 'rename', title, root, total, run: async (ctx) => {
    ctx.set(prior.length, total, 'Starting…');
    // Checkpoint: the undo file always lists the whole plan plus which steps are finished, so if the app is
    // killed, Undo reverses exactly what was done and Resume does the rest.
    manifest.operations = [...prior, ...ops];
    manifest.status = 'in-progress';
    const live = new Set(prior.map((_, i) => i));
    let saving = false; let lastSaved = -1;
    const checkpoint = async () => {
      if (!wroteManifest || !inPlace || saving || live.size === lastSaved) return;
      saving = true; lastSaved = live.size;
      try { await root.writeText(mName, JSON.stringify({ ...manifest, doneIdx: [...live] })); } catch { /* the final write will report problems */ }
      saving = false;
    };
    const timer = setInterval(checkpoint, Math.max(2000, Math.min(15000, ops.length * 0.2)));
    const res = await executeOpsParallel(root, ops, {
      concurrency: root.maxConcurrency, signal: ctx.signal,
      onStep: (count, op, idx) => { live.add(prior.length + idx); ctx.set(prior.length + count, total, basename(op.to)); },
    });
    clearInterval(timer);
    while (saving) await tick();
    const doneAll = [...prior, ...res.done];
    manifest.operations = doneAll.map((o) => ({ kind: o.kind, from: o.from, to: o.to }));
    delete manifest.doneIdx; delete manifest.interrupted;
    manifest.status = res.error ? 'partial' : 'complete';
    manifest.completed = doneAll.length;
    manifest.planned = total;
    const doneSet = new Set(res.doneIdx);
    const left = ops.filter((_, i) => !doneSet.has(i)).map(({ kind, from, to }) => ({ kind, from, to }));
    if (left.length) manifest.remaining = left; else delete manifest.remaining;
    if (res.error) manifest.error = res.error.message; else delete manifest.error;
    const text = JSON.stringify(manifest, null, 2);
    if (wroteManifest) { try { await root.writeText(mName, text); } catch { /* ignore */ } }
    else download(new Blob([text], { type: 'application/json' }), mName);
    await updateHistory(manifest.id, { manifest, status: manifest.status });
    let fin = { message: '' };
    if (!inPlace) {
      try { fin = await root.finalize({ onProgress: (pc) => ctx.set(total, total, `Building ZIP… ${Math.round(pc)}%`), download }); } catch (e) { fin = { message: `ZIP failed: ${e.message}` }; }
    }
    const actions = [];
    if (doneAll.length) actions.push({ label: 'Undo', onClick: () => undoNow(root, manifest, mName) });
    if (left.length && inPlace && !res.error) actions.push({ label: `Resume (${nf(left.length)} left)`, onClick: () => resumeRename(root, manifest, mName) });
    const cancelled = res.error?.message === 'Cancelled';
    if (res.error) {
      return { status: 'partial', actions, details: [res.error.message],
        message: cancelled ? `Stopped: ${nf(doneAll.length)} of ${nf(total)} done. The undo file covers what was done.` : `Stopped after ${nf(doneAll.length)} of ${nf(total)}. The undo file covers what was done.` };
    }
    return { status: 'done', actions, message: `Done: ${nf(doneAll.length)} step${doneAll.length === 1 ? '' : 's'}. ${fin.message || ''}`.trim() };
  } });
  job.promise.then(() => { if (S.root === root && !activeFor(root)) scan(); else paintBar(); });
  return job;
}

/** Finish an interrupted or stopped rename: only the steps that are still possible are run. */
export async function resumeRename(root, manifest, mName) {
  normaliseInterrupted(manifest);
  const remaining = manifest.remaining || [];
  if (!remaining.length) { toast('Nothing is left to do for this undo file.'); return; }
  if (activeFor(root) || await conflictFor(root)) { busyToast(); return; }
  S.mode = 'rename';
  await setRoot(root, { keepMode: true });
  if (root.kind === 'dir' && !(await root.verifyPermission(true))) { toast('Permission was not granted.', { type: 'error' }); return; }
  const present = (await root.list({ recursive: true, includeHidden: true, includeTemp: true, withFiles: false })).map((e) => e.path);
  const sim = simulateOps(present, remaining);
  const todo = sim.results.filter((r) => r.status === 'ok').map(({ kind, from, to }) => ({ kind, from, to }));
  if (!todo.length) { toast('None of the remaining steps can run any more: the files were moved or renamed since.', { type: 'warn', timeout: 9000 }); return; }
  const skipped = remaining.length - todo.length;
  const go = await confirmDialog('Resume this rename?', h('div', null,
    h('p', null, `${nf(todo.length)} step${todo.length === 1 ? '' : 's'} left to run in "${root.name}".`),
    skipped ? h('p', { class: 'warn' }, `${nf(skipped)} other step${skipped === 1 ? ' is' : 's are'} no longer possible (a file was moved, renamed or already exists) and will be skipped.`) : null), { okText: 'Resume' });
  if (!go) return;
  root.allowCopyFallback = S.opts.copyFallback;
  let wroteManifest = true;
  try { await root.writeText(mName, JSON.stringify({ ...manifest, status: 'in-progress', operations: [...manifest.operations, ...todo], doneIdx: manifest.operations.map((_, i) => i) })); } catch { wroteManifest = false; }
  await addHistory({ id: manifest.id, type: 'rename', createdAt: manifest.createdAt, rootName: root.name, source: root.kind, manifestName: mName, manifest, handle: root.handle || null, status: 'in-progress' });
  startRenameJob({ root, manifest, mName, ops: todo, prior: manifest.operations, wroteManifest, title: `Resuming: ${nf(todo.length)} step${todo.length === 1 ? '' : 's'} in "${root.name}"` });
  paintBar();
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
    support.folderPicker ? btn('Open folder', () => pickTargetFor(manifest, fileName, 'folder'), { cls: primary ? 'btn-primary' : '', ic: 'folder-open' }) : null,
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
          support.folderPicker ? btn('Open folder', () => openFolder(), { cls: 'btn-primary', ic: 'folder-open' }) : null,
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
      support.folderPicker ? { label: 'Open folder…', icon: 'folder-open', onClick: () => pickTargetFor(m, R.fileName, 'folder') } : null,
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
    m.remaining?.length ? h('p', { class: 'f-warn' }, icon('triangle-alert'), h('span', null, `This run did not finish: ${nf(m.remaining.length)} step${m.remaining.length === 1 ? ' was' : 's were'} never done.`)) : null,
    h('div', { class: 'btn-row' },
      btn(`Restore ${sim.ok} name${sim.ok === 1 ? '' : 's'}`, () => runRestore(), { cls: 'btn-primary', ic: 'rotate-ccw', disabled: !sim.ok || !!activeFor(S.root) }),
      m.remaining?.length && S.root?.kind === 'dir' ? btn('Finish the rest instead', () => resumeRename(S.root, m, R.name || R.fileName), { ic: 'play', disabled: !!activeFor(S.root) }) : null),
  );
}

async function runRestore() {
  const { manifest, sim, name, remap } = S.restore;
  const root = S.root;
  if (activeFor(root) || await conflictFor(root)) { busyToast(); return; }
  const external = S.restore.external;
  const ops = sim.results.filter((r) => r.status === 'ok').map(({ kind, from, to }) => ({ kind, from, to }));
  if (!(await confirmDialog('Restore original names?', `${nf(ops.length)} item(s) will get their previous names back. This runs in the background.`, { okText: 'Restore' }))) return;
  if (root.kind === 'dir' && !(await root.verifyPermission(true))) return;
  if (!isIdentity(remap)) manifest.lastRemap = { strip: remap.strip, prefix: remap.prefix, dirs: remap.byName ? remap.dirs : [], appliedTo: root.name };
  root.allowCopyFallback = S.opts.copyFallback;
  const total = ops.length;
  startJob({ id: `restore-${manifest.id}-${Date.now()}`, kind: 'restore', title: `Restoring ${nf(total)} name${total === 1 ? '' : 's'} in "${root.name}"`, root, total, run: async (ctx) => {
    const res = await executeOpsParallel(root, ops, {
      concurrency: root.maxConcurrency, signal: ctx.signal,
      onStep: (count, op) => ctx.set(count, total, basename(op.to)),
    });
    manifest.restoredAt = new Date().toISOString();
    manifest.restoreStatus = res.error ? 'partial' : 'complete';
    if (name && !external) { try { await root.writeText(name, JSON.stringify(manifest, null, 2)); } catch { /* ignore */ } }
    await updateHistory(manifest.id, { manifest, status: res.error ? 'restore-partial' : 'restored' });
    if (root.kind !== 'dir') { try { await root.finalize({ onProgress: (pc) => ctx.set(total, total, `Building ZIP… ${Math.round(pc)}%`), download }); } catch (e) { res.error = res.error || e; } }
    return res.error
      ? { status: 'partial', message: `Restore stopped after ${nf(res.done.length)} of ${nf(total)}: ${res.error.message}`, details: [res.error.message] }
      : { status: 'done', message: `Restored ${nf(res.done.length)} name${res.done.length === 1 ? '' : 's'}.` };
  } }).promise.then(() => { if (S.root === root && !activeFor(root)) { S.restore = null; scan(); } else paintBar(); });
  paintBar();
  paintRestore();
}
