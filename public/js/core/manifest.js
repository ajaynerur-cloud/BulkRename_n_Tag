// NameTag undo manifests — JSON files written next to the renamed items so every change can be reverted,
// even on another machine or after clearing the browser.
import { timestampForFile, uuid, MANIFEST_RE } from './utils.js';

export const APP = 'NameTag';
export const VERSION = 1;

export function manifestFileName(type, d = new Date()) {
  return `nametag-${type === 'tags' ? 'tags' : 'rename'}-${timestampForFile(d)}.json`;
}

export function createRenameManifest({ root, source, rules, ops, stats, tool = 'renamer' }) {
  return {
    app: APP, type: 'rename', version: VERSION, id: uuid(), createdAt: new Date().toISOString(),
    root, source, tool, pathsRelativeTo: root, status: 'in-progress', rules: rules || [], stats: stats || {},
    operations: ops.map((o) => ({ kind: o.kind, from: o.from, to: o.to })),
    restoredAt: null,
    note: 'Created by NameTag. Paths are relative to the folder or ZIP that was renamed, so this file works on any computer: open that folder (or its parent, or the extracted ZIP) in NameTag, choose Restore, and adjust the paths if asked. Operations are listed in execution order; undo runs them in reverse.',
  };
}

export function createTagManifest({ root, source, files, options }) {
  return {
    app: APP, type: 'tags', version: VERSION, id: uuid(), createdAt: new Date().toISOString(),
    root, source, pathsRelativeTo: root, status: 'in-progress', options: options || {}, files, restoredAt: null,
    note: 'Created by NameTag. Contains tag values before and after editing. Use Restore in the Tag editor to write the "before" values back.',
  };
}

export function parseManifest(text) {
  let m;
  try { m = JSON.parse(text); } catch { throw new Error('Not a valid JSON file'); }
  if (!m || m.app !== APP || !['rename', 'tags'].includes(m.type)) throw new Error('This JSON file was not created by NameTag');
  if (m.type === 'rename' && !Array.isArray(m.operations)) throw new Error('Manifest has no operations');
  if (m.type === 'rename') normaliseInterrupted(m);
  if (m.type === 'tags' && !Array.isArray(m.files)) throw new Error('Manifest has no file list');
  return m;
}

export const isManifestName = (n) => MANIFEST_RE.test(n);

export function summarizeManifest(m) {
  if (m.type === 'rename') {
    const files = m.operations.filter((o) => !o.to.split('/').pop().startsWith('.nametag-tmp-') && !o.from.split('/').pop().startsWith('.nametag-tmp-')).length;
    const what = m.tool === 'extension' ? 'extension change' : 'operation';
    return `${m.operations.length} ${what}${m.operations.length === 1 ? '' : 's'}${files !== m.operations.length ? ` (${files} visible renames)` : ''}`;
  }
  return `${m.files.length} file${m.files.length === 1 ? '' : 's'} with tag changes`;
}

/**
 * A rename that was cut off (app closed, phone locked and killed) leaves a checkpoint: the planned
 * operations plus `doneIdx`, the ones that finished. Undo must only reverse what really happened, and
 * Resume needs what is left, so split the two here. Safe to call on any manifest.
 */
export function normaliseInterrupted(m) {
  if (m.status !== 'in-progress' || !Array.isArray(m.doneIdx)) return m;
  const done = new Set(m.doneIdx);
  const planned = m.operations;
  m.remaining = planned.filter((_, i) => !done.has(i));
  m.operations = m.doneIdx.slice().sort((a, b) => a - b).map((i) => planned[i]).filter(Boolean);
  m.status = 'partial';
  m.interrupted = true;
  m.completed = m.operations.length;
  m.planned = planned.length;
  delete m.doneIdx;
  return m;
}
