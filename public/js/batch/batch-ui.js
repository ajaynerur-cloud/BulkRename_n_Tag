// Batch screen: Folders / Recipes / Activity.
// Every folder gets a recipe (rename rules + tag edits); "Run" starts one background job per folder, all at once.
import { h, icon, btn, clear, toast, menu, openDialog, confirmDialog, renderFields } from '../core/ui.js';
import { basename, formatBytes } from '../core/utils.js';
import { pickFolderRoot } from '../core/sources.js';
import { onJobs, allJobs, cancelJob, dismissJob } from '../core/jobs.js';
import { AUDIO_EXT } from '../tagger/index.js';
import { RULES, RULE_GROUPS, makeRule } from '../renamer/rules.js';
import { ruleFields, ruleSummary } from '../renamer/renamer-ui.js';
import { allRecipes, loadUserRecipes, saveUserRecipes, newRecipe, recipeSummary, hasRename, hasTags, foldersOf, TAG_TARGETS, hydrateRules } from './recipes.js';
import { startFolderJob, folderBusy } from './run.js';

const nf = (n) => Number(n).toLocaleString('en-US');
const B = { el: null, tab: 'folders', sources: [], recipes: [], sel: new Set(), assign: new Map(), jobs: new Map(), q: '' };
const keyOf = (src, dir) => `${src.id}\u0000${dir}`;
let seq = 0;
const supported = (root) => ['dir', 'saf', 'native'].includes(root.kind);
const recipeById = (id) => B.recipes.find((r) => r.id === id) || null;
const refreshRecipes = () => { B.recipes = allRecipes(); };

export function mountBatch(el) {
  B.el = el; refreshRecipes();
  el.append(
    h('div', { class: 'toolbar' },
      h('div', { class: 'segment', role: 'tablist', 'aria-label': 'Batch sections', id: 'bt-tabs' }),
      h('div', { class: 'toolbar-group' }, btn('Add folders', addFolders, { ic: 'folder-open', cls: 'btn-primary', title: 'Add folders to process' }))),
    h('div', { id: 'bt-body', class: 'bt-body' }),
    h('div', { id: 'bt-bar', class: 'bt-bar', hidden: true }));
  onJobs(() => { if (B.tab === 'activity') paintActivity(); else if (B.tab === 'folders') paintFolderStatus(); paintTabs(); });
  render();
}

function paintTabs() {
  const tabs = B.el.querySelector('#bt-tabs'); clear(tabs);
  const running = allJobs().filter((j) => j.kind === 'batch' && j.status === 'running').length;
  for (const [v, l] of [['folders', 'Folders'], ['recipes', 'Recipes'], ['activity', running ? `Activity · ${running}` : 'Activity']]) {
    tabs.append(h('button', { type: 'button', class: 'seg', role: 'tab', 'aria-selected': String(B.tab === v), 'aria-checked': String(B.tab === v), dataset: { v }, onclick: () => { B.tab = v; render(); } }, l));
  }
}
function render() {
  paintTabs();
  const body = B.el.querySelector('#bt-body'); clear(body);
  B.el.querySelector('#bt-bar').hidden = B.tab !== 'folders';
  if (B.tab === 'folders') renderFolders(body); else if (B.tab === 'recipes') renderRecipes(body); else renderActivity(body);
}

/* ------------------------------------------------------------------ adding folders */
async function addFolders() {
  let root;
  try { root = await pickFolderRoot({ title: 'Pick folders to process' }); } catch (e) { if (e.name !== 'AbortError' && e.message !== 'cancelled') toast(e.message, { type: 'error' }); return; }
  if (!root) return;
  if (!supported(root)) { toast('Batch works on folders you can change in place. ZIP files and dropped files are handled in the Renamer.', { type: 'warn' }); return; }
  if (!(await root.verifyPermission(true))) { toast('Permission was not granted.', { type: 'error' }); return; }
  const src = { id: ++seq, root, entries: [], folders: [], open: true, loading: true };
  B.sources.push(src); B.tab = 'folders'; render();
  try {
    src.entries = await root.list({ recursive: true });
    src.folders = foldersOf(src.entries, (n) => AUDIO_EXT.test(n));
  } catch (e) { toast(`Could not read: ${e.message}`, { type: 'error' }); }
  src.loading = false;
  render();
}

/* ------------------------------------------------------------------ folders tab */
const folderLabel = (src, f) => (f.dir ? f.dir : src.root.name);
function allRows() { return B.sources.flatMap((s) => s.folders.map((f) => ({ src: s, f, key: keyOf(s, f.dir) }))); }

function renderFolders(body) {
  if (!B.sources.length) {
    body.append(h('div', { class: 'bt-empty' }, icon('folder-open'), h('h2', null, 'Add the folders you want to process'),
      h('p', { class: 'muted' }, 'Pick one or many folders. Each folder with files in it gets its own recipe, and they all run at the same time.'),
      btn('Add folders', addFolders, { ic: 'folder-open', cls: 'btn-primary' })));
    paintBar(); return;
  }
  const rows = allRows();
  const q = B.q.trim().toLowerCase();
  const shown = q ? rows.filter((r) => folderLabel(r.src, r.f).toLowerCase().includes(q)) : rows;
  const allOn = shown.length && shown.every((r) => B.sel.has(r.key));
  body.append(
    h('div', { class: 'bt-tools' },
      h('label', { class: 'bt-all' }, h('input', { type: 'checkbox', class: 'check', checked: !!allOn, onchange: (e) => { for (const r of shown) e.target.checked ? B.sel.add(r.key) : B.sel.delete(r.key); render(); } }), h('span', null, `${nf(shown.length)} folder${shown.length === 1 ? '' : 's'}`)),
      h('input', { type: 'search', class: 'input bt-search', placeholder: 'Filter folders', value: B.q, 'aria-label': 'Filter folders', oninput: (e) => { B.q = e.target.value; clearTimeout(B._t); B._t = setTimeout(render, 200); } }),
      withAnchor(btn('Recipe for selected', (e) => recipeMenu(e.currentTarget, (id) => { for (const r of rows) if (B.sel.has(r.key)) { id ? B.assign.set(r.key, id) : B.assign.delete(r.key); } render(); }, 'Apply to selected folders'), { ic: 'layers', cls: 'btn-sm', disabled: !B.sel.size })),
      btn('', () => { B.sources = []; B.sel.clear(); B.assign.clear(); render(); }, { ic: 'trash-2', cls: 'btn-icon', title: 'Clear the list' })));
  for (const src of B.sources) {
    if (src.loading) { body.append(h('p', { class: 'muted bt-loading' }, `Reading "${src.root.name}"…`)); continue; }
    if (!src.folders.length) body.append(h('p', { class: 'muted' }, `No files found in "${src.root.name}".`));
  }
  const list = h('ul', { class: 'bt-list' });
  for (const r of shown) list.append(folderRow(r));
  body.append(list);
  paintBar();
}

const withAnchor = (b) => { b.dataset.menuAnchor = ''; return b; };

function recipeMenu(anchor, onPick, header) {
  const mine = B.recipes.filter((r) => !r.builtin);
  menu(anchor, [
    { header: header || 'Recipe' },
    ...B.recipes.filter((r) => r.builtin).map((r) => ({ label: r.name, icon: hasTags(r) && !hasRename(r) ? 'tag' : 'layers', hint: r.desc, onClick: () => onPick(r.id) })),
    mine.length ? { header: 'My recipes' } : null,
    ...mine.map((r) => ({ label: r.name, icon: 'layers', hint: recipeSummary(r), onClick: () => onPick(r.id) })),
    { separator: true },
    { label: 'No recipe', icon: 'x', onClick: () => onPick(null) },
    { label: 'New recipe…', icon: 'plus', onClick: async () => { const r = await editRecipe(newRecipe('Custom')); if (r) onPick(r.id); } },
  ], { cls: 'menu-wide' });
}

function folderRow({ src, f, key }) {
  const rec = recipeById(B.assign.get(key));
  const job = B.jobs.get(key);
  const running = job && job.status === 'running';
  const li = h('li', { class: `bt-row ${running ? 'is-running' : ''}`, dataset: { key } },
    h('input', { type: 'checkbox', class: 'check', checked: B.sel.has(key), disabled: running, 'aria-label': `Select ${folderLabel(src, f)}`, onchange: (e) => { e.target.checked ? B.sel.add(key) : B.sel.delete(key); paintBar(); } }),
    h('div', { class: 'bt-main' },
      h('strong', { class: 'bt-name', title: folderLabel(src, f) }, icon('folder'), h('span', null, f.dir ? basename(f.dir) : src.root.name)),
      h('span', { class: 'bt-path muted mono' }, f.dir && f.dir.includes('/') ? f.dir.slice(0, f.dir.lastIndexOf('/')) : src.root.name),
      h('span', { class: 'bt-meta muted' }, `${nf(f.files)} file${f.files === 1 ? '' : 's'}${f.audio ? ` · ${nf(f.audio)} audio` : ''}${f.bytes ? ` · ${formatBytes(f.bytes)}` : ''}`)),
    withAnchor(h('button', { type: 'button', class: `bt-chip ${rec ? 'is-set' : ''}`, disabled: running, 'aria-label': `Recipe for ${folderLabel(src, f)}`, onclick: (e) => recipeMenu(e.currentTarget, (id) => { id ? B.assign.set(key, id) : B.assign.delete(key); if (id && !B.sel.has(key)) B.sel.add(key); render(); }, folderLabel(src, f)) },
      icon(rec && hasTags(rec) && !hasRename(rec) ? 'tag' : 'layers'), h('span', null, rec ? rec.name : 'Choose recipe'), icon('chevron-down'))),
    h('div', { class: 'bt-state' }));
  paintState(li, key);
  return li;
}

function paintState(li, key) {
  const st = li.querySelector('.bt-state'); if (!st) return; clear(st);
  const job = B.jobs.get(key); if (!job) return;
  if (job.status === 'running') {
    const pct = job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
    st.append(h('div', { class: 'bt-prog' }, h('div', { class: 'progress-bar' }, h('span', { style: `width:${pct}%` })), h('em', null, `${pct}%`)),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => cancelJob(job) }, icon('x'), h('span', null, 'Stop')));
  } else {
    const ok = job.status === 'done';
    st.append(h('span', { class: `bt-done ${ok ? 'ok' : 'warn'}`, title: job.result?.message || '' }, icon(ok ? 'check' : 'zap'), h('span', null, ok ? 'Done' : 'Check Activity')));
  }
}
function paintFolderStatus() {
  B.el.querySelectorAll('.bt-row').forEach((li) => { const k = li.dataset.key; const job = B.jobs.get(k); li.classList.toggle('is-running', !!job && job.status === 'running'); li.querySelector('input.check').disabled = !!job && job.status === 'running'; paintState(li, k); });
  paintBar();
}

function paintBar() {
  const bar = B.el.querySelector('#bt-bar'); if (!bar) return; clear(bar);
  const ready = allRows().filter((r) => B.sel.has(r.key) && B.assign.get(r.key) && recipeById(B.assign.get(r.key)) && !(B.jobs.get(r.key)?.status === 'running'));
  const noRecipe = allRows().filter((r) => B.sel.has(r.key) && !B.assign.get(r.key)).length;
  const files = ready.reduce((a, r) => a + r.f.files, 0);
  bar.append(h('span', { class: 'bt-summary' }, B.sel.size ? `${nf(B.sel.size)} selected${noRecipe ? ` · ${nf(noRecipe)} need a recipe` : ''}${ready.length ? ` · ${nf(files)} files` : ''}` : 'Tick folders, choose a recipe, then run.'),
    btn(ready.length ? `Run ${nf(ready.length)} folder${ready.length === 1 ? '' : 's'}` : 'Run', () => runSelected(ready), { ic: 'play', cls: 'btn-primary', disabled: !ready.length }));
}

async function runSelected(ready) {
  if (!ready.length) return;
  const files = ready.reduce((a, r) => a + r.f.files, 0);
  const ok = await confirmDialog('Run recipes?', h('div', null,
    h('p', null, `${nf(ready.length)} folder${ready.length === 1 ? '' : 's'} (${nf(files)} files) will be changed directly on the device, all at the same time.`),
    h('ul', { class: 'bt-confirm' }, ready.slice(0, 8).map((r) => h('li', null, h('strong', null, r.f.dir ? basename(r.f.dir) : r.src.root.name), ` → ${recipeById(B.assign.get(r.key)).name}`)), ready.length > 8 ? h('li', { class: 'muted' }, `…and ${ready.length - 8} more`) : null),
    h('p', { class: 'muted' }, 'It keeps running if you switch screens or apps. An undo file is written for each folder first (see History).')), { okText: 'Run' });
  if (!ok) return;
  let started = 0;
  for (const { src, f, key } of ready) {
    if (await folderBusy(src.root, f.dir)) { toast(`"${folderLabel(src, f)}" is busy with another job.`, { type: 'warn' }); continue; }
    const recipe = recipeById(B.assign.get(key));
    const job = startFolderJob({ root: src.root, entries: src.entries, dir: f.dir, recipe, label: f.dir ? basename(f.dir) : src.root.name, onFinish: async () => {
      // Re-read this source so the next run sees the new names.
      try { src.entries = await src.root.list({ recursive: true }); src.folders = foldersOf(src.entries, (n) => AUDIO_EXT.test(n)); } catch { /* keep old */ }
      if (B.tab === 'folders' && ![...B.jobs.values()].some((j) => j.status === 'running')) render();
    } });
    B.jobs.set(key, job); B.sel.delete(key); started++;
  }
  if (started) toast(`Started ${nf(started)} folder${started === 1 ? '' : 's'}. Follow them in Activity.`, { action: { label: 'Activity', onClick: () => { B.tab = 'activity'; render(); } } });
  render();
}

/* ------------------------------------------------------------------ activity tab */
function renderActivity(body) {
  body.append(h('div', { id: 'bt-act' }));
  paintActivity();
}
function paintActivity() {
  const host = B.el.querySelector('#bt-act'); if (!host) return; clear(host);
  const jobs = allJobs().filter((j) => j.kind === 'batch').sort((a, b) => b.startedAt - a.startedAt);
  if (!jobs.length) { host.append(h('div', { class: 'bt-empty' }, icon('zap'), h('h2', null, 'Nothing running'), h('p', { class: 'muted' }, 'Folders you run appear here, one live bar each.'))); return; }
  const running = jobs.filter((j) => j.status === 'running').length;
  host.append(h('p', { class: 'bt-act-sum' }, running ? `${nf(running)} folder${running === 1 ? '' : 's'} running in parallel` : 'All finished'));
  const ul = h('ul', { class: 'bt-list' });
  for (const j of jobs) {
    const pct = j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : 0;
    const run = j.status === 'running';
    ul.append(h('li', { class: `bt-row bt-act-row is-${j.status}` },
      h('div', { class: 'bt-main' }, h('strong', { class: 'bt-name' }, icon(run ? 'folder-open' : j.status === 'done' ? 'check' : 'zap'), h('span', null, j.title)),
        h('div', { class: 'progress-bar' }, h('span', { style: `width:${run ? pct : 100}%` })),
        h('span', { class: 'bt-meta muted' }, run ? `${nf(j.done)} of ${nf(j.total)} · ${j.label || ''}` : (j.result?.message || '')),
        !run && j.result?.details?.length ? h('details', null, h('summary', null, `${j.result.details.length} problem${j.result.details.length === 1 ? '' : 's'}`), h('ul', { class: 'mono small' }, j.result.details.slice(0, 50).map((d) => h('li', null, d)))) : null),
      run ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => cancelJob(j) }, icon('x'), h('span', null, 'Stop'))
        : h('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Dismiss', onclick: () => { dismissJob(j); paintActivity(); } }, icon('x'))));
  }
  host.append(ul);
}

/* ------------------------------------------------------------------ recipes tab */
function renderRecipes(body) {
  refreshRecipes();
  body.append(h('div', { class: 'bt-tools' }, h('p', { class: 'muted bt-grow' }, 'A recipe is a saved set of rename rules and tag edits. Give any folder a recipe on the Folders tab.'),
    btn('New recipe', async () => { const r = await editRecipe(newRecipe('My recipe')); if (r) render(); }, { ic: 'plus', cls: 'btn-primary btn-sm' })));
  const ul = h('ul', { class: 'bt-list' });
  for (const r of B.recipes) {
    ul.append(h('li', { class: 'bt-row bt-recipe' },
      h('div', { class: 'bt-main' }, h('strong', { class: 'bt-name' }, icon(hasTags(r) && !hasRename(r) ? 'tag' : 'layers'), h('span', null, r.name), r.builtin ? h('em', { class: 'bt-tag' }, 'Built in') : null), h('span', { class: 'bt-meta muted' }, `${recipeSummary(r)}${r.desc ? ` · ${r.desc}` : ''}`)),
      h('div', { class: 'bt-actions' },
        btn(r.builtin ? 'Copy to edit' : 'Edit', async () => { const x = await editRecipe(r.builtin ? { ...structuredClone(r), id: newRecipe().id, name: `${r.name} (copy)`, builtin: false } : structuredClone(r)); if (x) render(); }, { cls: 'btn-sm', ic: r.builtin ? 'copy' : 'pencil' }),
        !r.builtin ? btn('', async () => { if (await confirmDialog('Delete recipe?', `"${r.name}" will be removed. Folders using it lose their recipe.`, { okText: 'Delete' })) { saveUserRecipes(loadUserRecipes().filter((x) => x.id !== r.id)); for (const [k, v] of B.assign) if (v === r.id) B.assign.delete(k); render(); } }, { ic: 'trash-2', cls: 'btn-icon', title: 'Delete' }) : null)));
  }
  body.append(ul);
}

/** Dialog: edit one recipe (name, rename rules, tag edits). Resolves with the saved recipe or null. */
async function editRecipe(rec) {
  const work = { ...rec, rules: hydrateRules(rec.rules).map((r) => ({ ...r, open: false })), tags: { ...rec.tags } };
  const name = h('input', { class: 'input', value: work.name, 'aria-label': 'Recipe name', maxlength: 60 });
  const rulesHost = h('ol', { class: 'rules bt-rules' });
  const tagsHost = h('div', { class: 'bt-tags' });
  const paintRules = () => {
    clear(rulesHost);
    if (!work.rules.length) rulesHost.append(h('li', { class: 'rule-empty' }, 'No rename rules. Add one below, or leave it empty for a tags-only recipe.'));
    work.rules.forEach((r, i) => {
      const def = RULES[r.type];
      const summary = h('span', { class: 'rule-summary' }, ruleSummary(r));
      const li = h('li', { class: `rule ${r.enabled ? '' : 'is-off'} ${r.open ? 'is-open' : ''}` },
        h('div', { class: 'rule-head' }, h('span', { class: 'rule-num' }, String(i + 1)),
          h('button', { type: 'button', class: 'rule-toggle', 'aria-expanded': String(!!r.open), onclick: () => { r.open = !r.open; paintRules(); } },
            h('span', { class: 'rule-ic' }, icon(def.icon || 'wand-sparkles')), h('span', { class: 'rule-text' }, h('span', { class: 'rule-title' }, def.label), summary), icon(r.open ? 'chevron-up' : 'chevron-down', 'rule-chev')),
          h('input', { type: 'checkbox', class: 'switch', checked: r.enabled, 'aria-label': `Enable ${def.label}`, onchange: (e) => { r.enabled = e.target.checked; li.classList.toggle('is-off', !r.enabled); } }),
          btn('', () => { work.rules.splice(i, 1); paintRules(); }, { ic: 'trash-2', cls: 'btn-icon', title: 'Remove rule' })));
      if (r.open) li.append(h('div', { class: 'rule-body' }, h('p', { class: 'rule-desc' }, def.desc), renderFields(ruleFields(def), r.opts, () => { summary.textContent = ruleSummary(r); })));
      rulesHost.append(li);
    });
  };
  const addRule = (anchor) => menu(anchor, RULE_GROUPS.flatMap(([g, title]) => {
    const list = Object.entries(RULES).filter(([, d]) => (d.group || 'advanced') === g);
    return list.length ? [{ header: title }, ...list.map(([type, d]) => ({ label: d.label, icon: d.icon, hint: d.desc, onClick: () => { const r = makeRule(type); r.open = true; work.rules.push(r); paintRules(); } }))] : [];
  }), { cls: 'menu-wide' });
  const paintTags = () => {
    clear(tagsHost);
    const keys = Object.keys(work.tags);
    for (const k of keys) {
      tagsHost.append(h('div', { class: 'bt-tagrow' },
        h('span', { class: 'bt-tagname' }, (TAG_TARGETS.find((t) => t[0] === k) || [k, k])[1]),
        h('input', { class: 'input mono', value: work.tags[k], placeholder: 'e.g. {parent}', 'aria-label': `${k} value`, oninput: (e) => { work.tags[k] = e.target.value; } }),
        btn('', () => { delete work.tags[k]; paintTags(); }, { ic: 'x', cls: 'btn-icon', title: 'Remove' })));
    }
    const free = TAG_TARGETS.filter(([k]) => !(k in work.tags));
    if (free.length) tagsHost.append(withAnchor(btn('Add a tag edit', (e) => menu(e.currentTarget, free.map(([k, l]) => ({ label: l, onClick: () => { work.tags[k] = ''; paintTags(); } }))), { ic: 'plus', cls: 'btn-sm' })));
    tagsHost.append(h('p', { class: 'muted small' }, 'Values can use {name} (file name), {parent} (folder), {grandparent}, {n} / {n:2} (position in the folder) and {total}. Empty values are ignored.'));
  };
  paintRules(); paintTags();
  const body = h('div', { class: 'bt-edit' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), name),
    h('h3', null, 'Rename rules'), h('p', { class: 'muted small' }, 'Run top to bottom on every file of the folder.'), rulesHost, withAnchor(btn('Add rule', (e) => addRule(e.currentTarget), { ic: 'plus', cls: 'btn-sm' })),
    h('h3', null, 'Tag edits (audio files)'), tagsHost);
  const res = await openDialog({ title: 'Recipe', body, wide: true, actions: [{ label: 'Cancel', value: null }, { label: 'Save recipe', value: 'save', primary: true }] });
  if (res !== 'save') return null;
  const saved = { id: work.id, name: name.value.trim() || 'Recipe', desc: work.desc || '', rules: work.rules.map(({ type, enabled, opts }) => ({ type, enabled, opts })), tags: Object.fromEntries(Object.entries(work.tags).filter(([, v]) => String(v).trim() !== '')) };
  const list = loadUserRecipes(); const i = list.findIndex((x) => x.id === saved.id); if (i >= 0) list[i] = saved; else list.push(saved);
  saveUserRecipes(list); refreshRecipes();
  return saved;
}
