// Built-in and user presets (user presets persisted in localStorage).
import { makeRule } from './rules.js';

export const BUILTIN_PRESETS = [
  { id: 'clean', name: 'Tidy names', desc: 'Underscores, %20, duplicate markers, spacing, Windows-safe', rules: () => [makeRule('cleanup'), makeRule('extension', { mode: 'lower' })] },
  { id: 'music', name: 'Music: 01 - Title', desc: 'Strip old numbers, renumber per folder', rules: () => [makeRule('strip', { leading: true }), makeRule('cleanup'), makeRule('case', { mode: 'title' }), makeRule('number', { position: 'prefix', sep: ' - ', perFolder: true })] },
  { id: 'fromtags', name: 'Music from tags', desc: '{track:2} - {title} using audio tags', rules: () => [makeRule('template', { tpl: '{track:2} - {title}' }), makeRule('cleanup', { underscores: false })] },
  { id: 'photos', name: 'Photos by date', desc: 'YYYY-MM-DD HH.mm.ss from modified date', rules: () => [makeRule('template', { tpl: '{mdate:YYYY-MM-DD HH.mm.ss}' }), makeRule('extension', { mode: 'normalize' }), makeRule('extension', { mode: 'lower' })] },
  { id: 'slug', name: 'Web slug', desc: 'lowercase-kebab-case, ASCII only', rules: () => [makeRule('cleanup', { accents: 'translit', emoji: true, windows: 'remove' }), makeRule('remove', { mode: 'nonalnum' }), makeRule('case', { mode: 'kebab', ext: 'lower' })] },
  { id: 'snake', name: 'snake_case', desc: 'For code and data files', rules: () => [makeRule('cleanup', { accents: 'translit', windows: 'remove' }), makeRule('case', { mode: 'snake', ext: 'lower' })] },
  { id: 'sequence', name: 'Folder name + 001', desc: 'Replace names with a counter', rules: () => [makeRule('template', { tpl: '{parent} {n:3}' })] },
  { id: 'unnumber', name: 'Remove numbering', desc: 'Strip leading track/sequence numbers', rules: () => [makeRule('strip', { leading: true })] },
  { id: 'lowerext', name: 'Lowercase extensions', desc: '.JPG → .jpg, .jpeg → .jpg', rules: () => [makeRule('extension', { mode: 'normalize' }), makeRule('extension', { mode: 'lower' })] },
];

const KEY = 'nametag.presets';
export function loadUserPresets() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } }
export function saveUserPresets(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* quota */ } }
export function addUserPreset(name, rules) {
  const list = loadUserPresets().filter((p) => p.name !== name);
  list.push({ id: 'u' + Date.now().toString(36), name, rules: rules.map(({ type, enabled, opts }) => ({ type, enabled, opts })) });
  saveUserPresets(list); return list;
}
export function exportPresets(list) { return JSON.stringify({ app: 'NameTag', type: 'presets', version: 1, presets: list }, null, 2); }
export function importPresets(text) {
  const d = JSON.parse(text);
  const incoming = Array.isArray(d) ? d : d.presets;
  if (!Array.isArray(incoming)) throw new Error('No presets in file');
  const list = loadUserPresets();
  for (const p of incoming) if (p?.name && Array.isArray(p.rules)) { const i = list.findIndex((x) => x.name === p.name); const v = { id: p.id || 'u' + Math.random().toString(36).slice(2), name: p.name, rules: p.rules }; if (i >= 0) list[i] = v; else list.push(v); }
  saveUserPresets(list); return list;
}
