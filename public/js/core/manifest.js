// NameTag undo manifests — JSON files written next to the renamed items so every change can be reverted,
// even on another machine or after clearing the browser.
import { timestampForFile, uuid, MANIFEST_RE } from './utils.js';

export const APP = 'NameTag';
export const VERSION = 1;

export function manifestFileName(type, d = new Date()) {
  return `nametag-${type === 'tags' ? 'tags' : 'rename'}-${timestampForFile(d)}.json`;
}

export function createRenameManifest({ root, source, rules, ops, stats }) {
  return {
    app: APP, type: 'rename', version: VERSION, id: uuid(), createdAt: new Date().toISOString(),
    root, source, status: 'in-progress', rules: rules || [], stats: stats || {},
    operations: ops.map((o) => ({ kind: o.kind, from: o.from, to: o.to })),
    restoredAt: null,
    note: 'Created by NameTag. Open this folder in NameTag and choose Restore to undo these renames. Operations are listed in execution order; undo runs them in reverse.',
  };
}

export function createTagManifest({ root, source, files, options }) {
  return {
    app: APP, type: 'tags', version: VERSION, id: uuid(), createdAt: new Date().toISOString(),
    root, source, status: 'in-progress', options: options || {}, files, restoredAt: null,
    note: 'Created by NameTag. Contains tag values before and after editing. Use Restore in the Tag editor to write the "before" values back.',
  };
}

export function parseManifest(text) {
  let m;
  try { m = JSON.parse(text); } catch { throw new Error('Not a valid JSON file'); }
  if (!m || m.app !== APP || !['rename', 'tags'].includes(m.type)) throw new Error('This JSON file was not created by NameTag');
  if (m.type === 'rename' && !Array.isArray(m.operations)) throw new Error('Manifest has no operations');
  if (m.type === 'tags' && !Array.isArray(m.files)) throw new Error('Manifest has no file list');
  return m;
}

export const isManifestName = (n) => MANIFEST_RE.test(n);

export function summarizeManifest(m) {
  if (m.type === 'rename') {
    const files = m.operations.filter((o) => !o.to.split('/').pop().startsWith('.nametag-tmp-') && !o.from.split('/').pop().startsWith('.nametag-tmp-')).length;
    return `${m.operations.length} operation${m.operations.length === 1 ? '' : 's'}${files !== m.operations.length ? ` (${files} visible renames)` : ''}`;
  }
  return `${m.files.length} file${m.files.length === 1 ? '' : 's'} with tag changes`;
}
