// Portable restore: maps the relative paths stored in an undo/backup file onto the folder opened now.
// Handles the usual "other computer" cases: the folder was opened one level higher or lower, a ZIP was
// extracted into an extra folder, the top folder got a different name, or subfolders were moved around.
import { dirname, basename } from './utils.js';

/** strip: leading folders to drop from saved paths; prefix: folder inside the opened location to add;
 *  byName: relocate folders whose files are found elsewhere by unique file name; dirs: [[savedDir, newDir]] */
export const emptyRemap = () => ({ strip: 0, prefix: '', byName: true, dirs: [] });

export function normPrefix(p) {
  const s = String(p || '').trim().replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '');
  return s ? `${s}/` : '';
}
function stripSegs(p, k) {
  if (!k) return p;
  const s = p.split('/');
  return s.length > k ? s.slice(k).join('/') : null;
}

/** Base mapping only (strip + prefix). */
export function baseMap(p, rm) {
  const q = stripSegs(p, rm.strip || 0);
  return q == null ? null : normPrefix(rm.prefix) + q;
}

/** Full mapping: base mapping, then the longest matching moved-folder rule. */
export function mapPath(p, rm) {
  const q = baseMap(p, rm);
  if (q == null) return null;
  if (!rm.byName || !rm.dirs?.length) return q;
  for (const [from, to] of rm.dirs) {
    if (q === from) return to;
    if (q.startsWith(`${from}/`)) return (to ? `${to}/` : '') + q.slice(from.length + 1);
  }
  return q;
}

export function isIdentity(rm) { return !rm.strip && !normPrefix(rm.prefix) && !(rm.byName && rm.dirs?.length); }

/**
 * Paths that exist right now if the renames in `ops` were applied: follows each item through
 * later renames of itself or of its parent folders. Temporary names are skipped.
 */
export function currentPathsAfter(ops) {
  const cur = []; // tracked current paths
  const idx = new Map();
  for (const op of ops) {
    const i = idx.get(op.from);
    if (i !== undefined) { cur[i] = op.to; idx.delete(op.from); idx.set(op.to, i); } else { idx.set(op.to, cur.length); cur.push(op.to); }
    if (op.kind === 'dir') {
      const pre = `${op.from}/`;
      for (let j = 0; j < cur.length; j++) {
        if (cur[j].startsWith(pre)) { idx.delete(cur[j]); cur[j] = `${op.to}/${cur[j].slice(pre.length)}`; idx.set(cur[j], j); }
      }
    }
  }
  return cur.filter((p) => !basename(p).startsWith('.nametag-tmp-'));
}

/**
 * Finds the mapping that makes the most saved paths line up with the paths present now.
 * @param {string[]} saved paths that should exist now (relative to the original root)
 * @param {string[]} present paths found in the opened location
 * @param {{caseSensitive?: boolean, allowDirs?: boolean, hint?: string}} opts hint: folder where the undo file was found
 */
export function detectRemap(saved, present, { caseSensitive = false, allowDirs = true, hint = '' } = {}) {
  const key = caseSensitive ? (s) => s : (s) => s.toLowerCase();
  const presentKeys = new Set(present.map(key));
  const byBase = new Map();
  for (const p of present) { const b = key(basename(p)); if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(p); }
  const sample = saved.length > 3000 ? saved.filter((_, i) => i % Math.ceil(saved.length / 3000) === 0) : saved;

  const votes = new Map();
  for (const m of sample) {
    const cands = byBase.get(key(basename(m))) || [];
    if (!cands.length || cands.length > 50) continue;
    const seen = new Set();
    const depth = m.split('/').length;
    for (let k = 0; k < Math.min(4, depth); k++) {
      const s = key(stripSegs(m, k));
      for (const c of cands) {
        const kc = key(c);
        if (!kc.endsWith(s)) continue;
        const cut = kc.length - s.length;
        if (cut > 0 && kc[cut - 1] !== '/') continue;
        const id = `${k}\u0000${c.slice(0, cut)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        votes.set(id, (votes.get(id) || 0) + 1);
      }
    }
  }
  const hintP = normPrefix(hint);
  // Rank by votes, then evaluate the strongest few by how many items they place in total
  // (moved-folder rules included), preferring mappings that keep more of the saved structure.
  const cands = [...votes.entries()].map(([id, n]) => { const [k, P] = id.split('\u0000'); return { strip: Number(k), prefix: P, n }; })
    .sort((x, y) => y.n - x.n || x.strip - y.strip).slice(0, 8);
  if (!cands.length) cands.push({ strip: 0, prefix: hintP, n: 0 });
  const ctx = { key, presentKeys, byBase };
  let best = null;
  for (const c of cands) {
    const rm = { ...emptyRemap(), strip: c.strip, prefix: c.prefix.replace(/\/$/, ''), byName: allowDirs };
    if (allowDirs) rm.dirs = detectMovedDirs(saved, present, rm, ctx);
    const total = countMatches(saved, present, rm, { caseSensitive });
    const score = [total, -c.strip, -(rm.dirs?.length || 0), c.prefix === hintP ? 1 : 0, c.n, -c.prefix.length];
    if (!best || cmp(score, best.score) > 0) best = { rm, score };
  }
  return best.rm;
}
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

function detectMovedDirs(saved, present, rm, { key, presentKeys, byBase }) {
  const savedBase = new Map();
  for (const m of saved) { const b = key(basename(m)); savedBase.set(b, (savedBase.get(b) || 0) + 1); }
  const tally = new Map(); // savedDir -> Map(newDir -> n), plus total
  for (const m of saved) {
    const q = baseMap(m, rm);
    if (q == null || presentKeys.has(key(q))) continue;
    const b = key(basename(m));
    if (savedBase.get(b) !== 1) continue;
    const cands = byBase.get(b) || [];
    if (cands.length !== 1) continue;
    const from = dirname(q); const to = dirname(cands[0]);
    if (from === to || !from) continue;
    if (!tally.has(from)) tally.set(from, new Map());
    const t = tally.get(from); t.set(to, (t.get(to) || 0) + 1);
  }
  const dirs = [];
  for (const [from, t] of tally) {
    let bestTo = null; let n = 0; let total = 0;
    for (const [to, c] of t) { total += c; if (c > n) { n = c; bestTo = to; } }
    if (bestTo !== null && n / total >= 0.6) dirs.push([from, bestTo]);
  }
  return dirs.sort((a, b) => b[0].length - a[0].length);
}

/** How many saved paths exist after mapping. */
export function countMatches(saved, present, rm, { caseSensitive = false } = {}) {
  const key = caseSensitive ? (s) => s : (s) => s.toLowerCase();
  const set = new Set(present.map(key));
  let n = 0;
  for (const m of saved) { const q = mapPath(m, rm); if (q != null && set.has(key(q))) n++; }
  return n;
}

/** Applies a mapping to every path of a list of operations. Returns null entries as unmappable. */
export function remapOps(ops, rm) {
  return ops.map((o) => ({ ...o, from: mapPath(o.from, rm) ?? o.from, to: mapPath(o.to, rm) ?? o.to, savedFrom: o.from, savedTo: o.to }));
}
