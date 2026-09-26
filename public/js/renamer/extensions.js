// Extension renamer: change file extensions in bulk (folder, files or ZIP), grouped by current extension.
// Pure logic, shared by the UI and the tests.
import { splitName, joinName } from '../core/utils.js';

/** Common spelling variants and the form most tools expect. */
export const UNIFY = {
  jpeg: 'jpg', jpe: 'jpg', jfif: 'jpg', tiff: 'tif', htm: 'html', mpeg: 'mpg', aif: 'aiff', aifc: 'aiff',
  oga: 'ogg', markdown: 'md', mkdn: 'md', yml: 'yaml', text: 'txt', midi: 'mid', m4v: 'mp4', qt: 'mov', jsonc: 'json',
};
/** Extensions that name the same content, used so "fix by content" does not rename .jpeg to .jpg etc. */
const SAME = [['jpg', 'jpeg', 'jpe', 'jfif'], ['tif', 'tiff'], ['mp4', 'm4v', 'mov'], ['m4a', 'm4b', 'm4p', 'mp4', 'aac'], ['aiff', 'aif', 'aifc'], ['ogg', 'oga', 'ogv'], ['zip', 'docx', 'xlsx', 'pptx', 'epub', 'jar', 'apk', 'odt', 'ods', 'odp', 'cbz', 'kmz', '3mf'], ['mkv', 'webm', 'mka'], ['heic', 'heif', 'avif'], ['mp3', 'mp2', 'mpga'], ['rar', 'cbr'], ['gz', 'tgz', 'tar.gz']];
export function sameContent(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return true;
  return SAME.some((g) => g.includes(a) && g.includes(b));
}

export const DEFAULT_EXT_OPTS = { map: {}, case: 'keep', unify: false, fixContent: false, addMissing: false, compound: true };

/** Groups files by their exact current extension ('' = none). */
export function extGroups(items, { compound = true } = {}) {
  const g = new Map();
  for (const it of items) {
    if (it.isDir) continue;
    const ext = extOf(it.name, compound);
    if (!g.has(ext)) g.set(ext, { ext, count: 0, sample: it.name, bytes: 0 });
    const e = g.get(ext); e.count++; e.bytes += it.size || 0;
  }
  return [...g.values()].sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));
}

export function extOf(name, compound = true) {
  if (compound) return splitName(name).ext;
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i + 1) : '';
}
function baseOf(name, compound) {
  const ext = extOf(name, compound);
  return ext ? name.slice(0, name.length - ext.length - 1) : name;
}

/** Cleans what a person types into an extension box: ".JPG " -> "JPG". Returns null for "keep". */
export function cleanTarget(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  if (s === '-' || s.toLowerCase() === '(none)') return '';
  return s.replace(/^\.+/, '').replace(/[\\/:*?"<>|]/g, '');
}

/**
 * New name for one file.
 * Priority: content fix (or adding a missing one) > your mapping for that extension > unify variants > case.
 */
export function newNameFor(item, o, detected) {
  const compound = o.compound !== false;
  const ext = extOf(item.name, compound);
  const base = baseOf(item.name, compound);
  let next = ext;
  let why = null;
  if (o.fixContent && detected && ext && !sameContent(ext, detected)) { next = detected; why = 'content'; }
  else if (o.addMissing && detected && !ext) { next = detected; why = 'content'; }
  else {
    const mapped = Object.prototype.hasOwnProperty.call(o.map || {}, ext) ? cleanTarget(o.map[ext]) : null;
    if (mapped !== null) { next = mapped; why = 'map'; }
    else if (o.unify && UNIFY[ext.toLowerCase()]) { next = UNIFY[ext.toLowerCase()]; why = 'unify'; }
  }
  if (why !== 'map' && next) {
    if (o.case === 'lower') next = next.toLowerCase();
    else if (o.case === 'upper') next = next.toUpperCase();
    else if (why && ext && ext === ext.toUpperCase() && /[A-Z]/.test(ext)) next = next.toUpperCase(); // keep the file's style
  }
  return { name: joinName(base, next), from: ext, to: next, why };
}

/** Proposals for a list of files: Map(path -> new name). */
export function extensionProposals(items, o, magic = new Map()) {
  const out = new Map();
  for (const it of items) {
    if (it.isDir) continue;
    out.set(it.path, newNameFor(it, o, magic.get(it.path) || null).name);
  }
  return out;
}

export const needsContent = (o) => !!(o.fixContent || o.addMissing);
