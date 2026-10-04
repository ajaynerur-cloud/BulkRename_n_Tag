// Recipes: a saved set of rename rules plus tag edits that can be applied to any folder.
// Pure logic (no DOM) so it can be tested in Node; batch-ui.js draws the screen.
import { dirname } from '../core/utils.js';
import { RULES, makeRule, runPipeline, templateUsesTags } from '../renamer/rules.js';
import { buildPlan } from '../core/planner.js';

const KEY = 'nametag.recipes';
const ASSIGN_KEY = 'nametag.recipes.assign';

/** Tag fields a recipe may set. Values are templates: {name} {parent} {grandparent} {n} {n:3} {total} plus any text. */
export const TAG_TARGETS = [
  ['artist', 'Artist'], ['title', 'Title'], ['album', 'Album'], ['albumartist', 'Album artist'], ['year', 'Year'], ['genre', 'Genre'],
  ['track', 'Track number'], ['composer', 'Composer'], ['comment', 'Comment'], ['publisher', 'Label / publisher'],
];

export const BUILTIN_RECIPES = [
  { id: 'b-tidy-number', name: 'Tidy + Number', desc: 'Clean names, remove codes, then number 01, 02…', rules: () => [makeRule('cleanup'), makeRule('codes'), makeRule('number', { position: 'prefix', sep: ' - ', perFolder: true })], tags: {} },
  { id: 'b-clean-codes', name: 'Remove codes & IDs', desc: 'Strips SzH34yR2-style tokens, YouTube IDs and hashes', rules: () => [makeRule('codes'), makeRule('cleanup')], tags: {} },
  { id: 'b-letters-digits', name: 'Keep letters & digits', desc: 'Drops every other symbol from names', rules: () => [makeRule('keep', { extra: '' })], tags: {} },
  { id: 'b-tags-folder', name: 'Tags: Album from folder', desc: 'Album = folder name, Artist = parent of the folder', rules: () => [], tags: { album: '{parent}', albumartist: '{grandparent}', artist: '{grandparent}' } },
  { id: 'b-tags-title', name: 'Tags: Title from file name', desc: 'Title = file name, Track = position in folder', rules: () => [], tags: { title: '{name}', track: '{n}' } },
];

const lite = (rules) => (rules || []).filter((r) => RULES[r.type]).map((r) => ({ type: r.type, enabled: r.enabled !== false, opts: JSON.parse(JSON.stringify(r.opts || {})) }));
export const hydrateRules = (rules) => lite(rules).map((r) => ({ ...makeRule(r.type, r.opts), enabled: r.enabled }));

export function builtinRecipes() { return BUILTIN_RECIPES.map((b) => ({ id: b.id, name: b.name, desc: b.desc, builtin: true, rules: lite(b.rules()), tags: { ...b.tags } })); }

export function loadUserRecipes() { try { const l = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(l) ? l.filter((r) => r && r.name).map((r) => ({ id: r.id || `u-${Math.random().toString(36).slice(2, 9)}`, name: r.name, desc: r.desc || '', rules: lite(r.rules), tags: r.tags && typeof r.tags === 'object' ? r.tags : {} })) : []; } catch { return []; } }
export function saveUserRecipes(list) { try { localStorage.setItem(KEY, JSON.stringify(list.map(({ id, name, desc, rules, tags }) => ({ id, name, desc, rules: lite(rules), tags })))); } catch { /* quota */ } }
export const allRecipes = () => [...builtinRecipes(), ...loadUserRecipes()];
export function newRecipe(name = 'New recipe') { return { id: `u-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name, desc: '', rules: [], tags: {} }; }
export function loadAssignments() { try { return JSON.parse(localStorage.getItem(ASSIGN_KEY) || '{}') || {}; } catch { return {}; } }
export function saveAssignments(map) { try { localStorage.setItem(ASSIGN_KEY, JSON.stringify(map)); } catch { /* ignore */ } }

export const recipeSummary = (r) => {
  if (!r) return 'No recipe';
  const parts = [];
  const rules = (r.rules || []).filter((x) => x.enabled !== false && RULES[x.type]);
  if (rules.length) parts.push(`${rules.length} rename rule${rules.length === 1 ? '' : 's'}`);
  const t = Object.keys(r.tags || {}).filter((k) => r.tags[k] !== '' && r.tags[k] != null);
  if (t.length) parts.push(`${t.length} tag${t.length === 1 ? '' : 's'}`);
  return parts.join(' + ') || 'Does nothing yet';
};
export const hasRename = (r) => !!r && (r.rules || []).some((x) => x.enabled !== false && RULES[x.type]);
export const hasTags = (r) => !!r && Object.values(r.tags || {}).some((v) => v !== '' && v != null);
export const needsTagRead = (r) => (r?.rules || []).some((x) => x.enabled !== false && Object.values(x.opts || {}).some((v) => typeof v === 'string' && templateUsesTags(v)));

/* ---------------------------------------------------------------- folders */
/** Group scanned entries into folders: every directory that directly contains at least one file. */
export function foldersOf(entries, isAudio = () => false) {
  const map = new Map();
  for (const e of entries) {
    if (e.isDir) continue;
    const d = dirname(e.path);
    let f = map.get(d); if (!f) { f = { dir: d, files: 0, audio: 0, bytes: 0 }; map.set(d, f); }
    f.files++; if (isAudio(e.name)) f.audio++; f.bytes += e.size || 0;
  }
  return [...map.values()];
}
export const entriesIn = (entries, dir) => entries.filter((e) => dirname(e.path) === dir);

const parts = (path) => path.split('/').filter(Boolean);
export function expandTagTemplate(tpl, { path, name, n, total, rootName }) {
  const p = parts(path); p.pop();
  const base = name.replace(/\.[^.]+$/, '');
  return String(tpl).replace(/\{(name|parent|grandparent|n|total)(?::(\d+))?\}/g, (_, k, w) => {
    if (k === 'name') return base;
    if (k === 'parent') return p[p.length - 1] || rootName || '';
    if (k === 'grandparent') return p[p.length - 2] || (p.length === 1 ? rootName : '') || '';
    const v = k === 'n' ? n : total;
    return w ? String(v).padStart(+w, '0') : String(v);
  }).trim();
}

/** The new field values for each audio file of one folder (only fields whose value changes). */
export function planTagEdits(files, tags, readFields, rootName) {
  const out = new Map();
  const total = files.length;
  files.forEach((e, i) => {
    const cur = readFields?.get(e.path) || {};
    const set = {};
    for (const [k, tpl] of Object.entries(tags)) {
      if (tpl === '' || tpl == null) continue;
      const v = expandTagTemplate(tpl, { path: e.path, name: e.name, n: i + 1, total, rootName });
      if (v !== '' && v !== (cur[k] ?? '')) set[k] = v;
    }
    if (Object.keys(set).length) out.set(e.path, set);
  });
  return out;
}

/**
 * Work out what a recipe does to one folder. Returns { ops, rows, stats, names }.
 * Only files directly in `dir` are touched, so folders can run in parallel.
 */
export function planFolderRename({ entries, dir, rules, tagsByPath = new Map(), rootName = '', opts = {} }) {
  const here = entriesIn(entries, dir);
  const files = here.filter((e) => !e.isDir);
  const items = files.map((e) => ({ path: e.path, name: e.name, isDir: false, mtime: e.mtime, size: e.size, tags: tagsByPath.get(e.path) || null }));
  const { names, errors } = runPipeline(items, hydrateRules(rules), { scope: 'files', rootName, now: new Date() });
  const proposals = new Map(names);
  const plan = buildPlan(here, proposals, { conflict: opts.conflict || 'suffix', windows: opts.windows !== false, caseSensitive: !!opts.caseSensitive });
  return { ops: plan.ops.map(({ kind, from, to }) => ({ kind, from, to })), stats: plan.stats, rows: plan.rows, errors };
}
