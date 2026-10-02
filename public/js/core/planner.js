// Rename planner: validates target names, resolves conflicts, orders operations safely
// (children before parents, dependency chains, cycles and case-only renames via temp names),
// executes them against a root and produces a reversible operation log.
import { dirname, basename, joinPath, splitName, joinName, utf8len, randomString } from './utils.js';

const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001F]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** Validate a single file name. Returns array of {level:'error'|'warn', code, msg}. */
export function validateName(name, { windows = true } = {}) {
  const issues = [];
  if (!name || !name.trim()) issues.push({ level: 'error', code: 'empty', msg: 'Name is empty' });
  else {
    if (name.includes('/') || name.includes('\u0000')) issues.push({ level: 'error', code: 'slash', msg: 'Contains "/"' });
    if (name === '.' || name === '..') issues.push({ level: 'error', code: 'dots', msg: 'Reserved name' });
    if (windows && INVALID_CHARS.test(name.replace('/', ''))) issues.push({ level: windows === 'strict' ? 'error' : 'warn', code: 'chars', msg: 'Characters not allowed on Windows: < > : " \\ | ? *' });
    if (windows && RESERVED.test(name.split('.')[0])) issues.push({ level: 'warn', code: 'reserved', msg: 'Reserved device name on Windows' });
    if (windows && /[. ]$/.test(name)) issues.push({ level: 'warn', code: 'trailing', msg: 'Ends with a dot or space (problematic on Windows)' });
    if (/^\s|\s$/.test(name)) issues.push({ level: 'warn', code: 'spaces', msg: 'Leading/trailing whitespace' });
    if (utf8len(name) > 255) issues.push({ level: 'error', code: 'long', msg: 'Longer than 255 bytes' });
    if (name.startsWith('.nametag-tmp-')) issues.push({ level: 'error', code: 'tmp', msg: 'Reserved temporary prefix' });
  }
  return issues;
}

/**
 * Build a plan.
 * @param entries all entries of the root [{path, name, isDir}]
 * @param proposals Map path -> newName (only for selected items)
 * @param opts {caseSensitive=false, conflict='suffix'|'skip', windows=true}
 * @returns {rows: Map path -> {path, name, newName, status, issues, isDir}, ops: [{kind, from, to}], stats}
 */
export function buildPlan(entries, proposals, opts = {}) {
  const { caseSensitive = false, conflict = 'suffix', windows = true } = opts;
  const fold = caseSensitive ? (s) => s : (s) => s.toLowerCase();
  const rows = new Map();
  const byDir = new Map();
  for (const e of entries) {
    const d = dirname(e.path);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(e);
  }
  for (const [dir, list] of byDir) {
    // initial targets
    const items = list.map((e) => {
      let nn = proposals.has(e.path) ? proposals.get(e.path) : e.name;
      const issues = nn !== e.name ? validateName(nn, { windows }) : [];
      const hasError = issues.some((i) => i.level === 'error');
      return { e, target: hasError ? e.name : nn, wanted: nn, issues, invalid: hasError };
    });
    // conflict resolution loop
    for (let guard = 0; guard < 5; guard++) {
      const counts = new Map();
      for (const it of items) counts.set(fold(it.target), (counts.get(fold(it.target)) || 0) + 1);
      const dup = items.filter((it) => counts.get(fold(it.target)) > 1);
      if (!dup.length) break;
      const taken = new Set(items.map((it) => fold(it.target)));
      // Unchanged items keep their names; changed ones yield.
      const groups = new Map();
      for (const it of dup) { const k = fold(it.target); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
      for (const g of groups.values()) {
        const keeper = g.find((it) => it.target === it.e.name) || g[0];
        for (const it of g) {
          if (it === keeper) continue;
          it.conflict = true;
          if (conflict === 'skip' || it.target === it.e.name) { it.target = it.e.name; it.skipped = true; continue; }
          const { base, ext } = splitName(it.target, it.e.isDir);
          let n = 2; let cand;
          do { cand = joinName(`${base} (${n++})`, ext); } while (taken.has(fold(cand)));
          taken.add(fold(cand)); it.target = cand;
        }
      }
    }
    for (const it of items) {
      const changed = it.target !== it.e.name;
      let status = 'unchanged';
      if (it.invalid) status = 'invalid';
      else if (it.skipped && it.wanted !== it.e.name) status = 'conflict';
      else if (changed) status = it.conflict ? 'renamed-suffix' : (it.issues.length ? 'warn' : 'ok');
      rows.set(it.e.path, { path: it.e.path, name: it.e.name, newName: it.target, wanted: it.wanted, isDir: it.e.isDir, status, issues: it.issues, dir });
    }
  }
  const ops = orderOps(rows, byDir, { caseSensitive });
  const stats = { total: rows.size, changed: 0, invalid: 0, conflict: 0, suffixed: 0, warn: 0 };
  for (const r of rows.values()) {
    if (r.newName !== r.name) stats.changed++;
    if (r.status === 'invalid') stats.invalid++;
    if (r.status === 'conflict') stats.conflict++;
    if (r.status === 'renamed-suffix') stats.suffixed++;
    if (r.status === 'warn') stats.warn++;
  }
  stats.ops = ops.length;
  return { rows, ops, stats };
}

/** Produce ordered ops with full paths valid at execution time. */
export function orderOps(rows, byDir, { caseSensitive = false, tmpSeed } = {}) {
  const fold = caseSensitive ? (s) => s : (s) => s.toLowerCase();
  const tag = tmpSeed || randomString(6);
  let tmpN = 0;
  const dirs = [...byDir.keys()].sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : 1));
  const ops = [];
  for (const dir of dirs) {
    const list = byDir.get(dir);
    const occupied = new Set(list.map((e) => fold(e.name)));
    let pending = [];
    for (const e of list) {
      const r = rows.get(e.path);
      if (!r || r.newName === r.name) continue;
      pending.push({ from: r.name, to: r.newName, isDir: e.isDir });
    }
    const exec = (op, to) => {
      ops.push({ kind: op.isDir ? 'dir' : 'file', from: joinPath(dir, op.from), to: joinPath(dir, to) });
      occupied.delete(fold(op.from)); occupied.add(fold(to));
    };
    // case-only renames (under case-insensitive semantics) always go through a temp name
    for (const op of pending) {
      if (!caseSensitive && fold(op.from) === fold(op.to)) {
        const tmp = `.nametag-tmp-${tag}-${tmpN++}`; exec(op, tmp); op.from = tmp;
      }
    }
    while (pending.length) {
      let progressed = false;
      const next = [];
      for (const op of pending) {
        if (!occupied.has(fold(op.to))) { exec(op, op.to); progressed = true; } else next.push(op);
      }
      pending = next;
      if (!progressed && pending.length) {
        // cycle: move first op to temp
        const op = pending[0];
        const tmp = `.nametag-tmp-${tag}-${tmpN++}`; exec(op, tmp); op.from = tmp;
      }
    }
  }
  return ops;
}
const depth = (p) => (p ? p.split('/').length : 0);

const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

/** Check the target is free, then move. Shared by the sequential and the parallel executor. */
async function runOp(root, op) {
  const ex = await root.exists(op.to);
  if (ex === true) throw new Error(`Target already exists: ${op.to}`);
  await root.move(op.from, op.to);
}
const wrapError = (e, op) => Object.assign(new Error(`${e.message} (while renaming "${op.from}")`), { cause: e, op });

/**
 * Execute ops one after the other, in order, with existence checks.
 * onStep(count, op, index) progress; returns {done: ops executed (in plan order), doneIdx, error}
 */
export async function executeOps(root, ops, { onStep, signal } = {}) {
  const done = []; const doneIdx = [];
  for (let i = 0; i < ops.length; i++) {
    if (signal?.aborted) return { done, doneIdx, error: new Error('Cancelled') };
    const op = ops[i];
    try {
      await runOp(root, op);
      done.push(op); doneIdx.push(i);
      onStep?.(done.length, op, i);
    } catch (e) {
      return { done, doneIdx, error: wrapError(e, op) };
    }
    if (i % 200 === 199) await yieldToUI(); // keep the page responsive on huge batches
  }
  return { done, doneIdx, error: null };
}

/**
 * Work out which ops must wait for which. The planned order is only ONE valid order; many ops do not
 * depend on each other, and running those at the same time cannot change the result. Op j waits for an
 * earlier op i exactly when they touch the same path (swap chains, temp names, a target that another
 * op frees up), or when one is a folder rename and the other works anywhere inside that folder
 * (children must finish before their folder is renamed, and the other way round when restoring).
 * Paths are compared case-insensitively, which is the safe choice on every file system.
 * Returns deps[j] = indices j must wait for.
 */
export function opDependencies(ops) {
  const exact = new Map();   // path -> last op that touched exactly this path
  const inside = new Map();  // folder -> ops that touched something strictly inside it
  const ancestors = (p) => { const out = []; let i; while ((i = p.lastIndexOf('/')) > 0) { p = p.slice(0, i); out.push(p); } return out; };
  return ops.map((op, j) => {
    const paths = [op.from.toLowerCase(), op.to.toLowerCase()];
    const d = new Set();
    for (const p of paths) {
      if (exact.has(p)) d.add(exact.get(p));
      for (const a of ancestors(p)) if (exact.has(a)) d.add(exact.get(a));
      if (op.kind === 'dir' && inside.has(p)) for (const i of inside.get(p)) d.add(i);
    }
    for (const p of paths) {
      exact.set(p, j);
      for (const a of ancestors(p)) { let l = inside.get(a); if (!l) inside.set(a, l = []); l.push(j); }
    }
    d.delete(j);
    return [...d];
  });
}

/**
 * Execute ops with several in flight at once, never starting an op before everything it depends on has
 * finished, so the final names are exactly what the sequential run would produce.
 * If one op fails nothing new is started; the ones already running finish, and the result lists
 * exactly what was done (in plan order), so the undo file stays exact.
 * Returns {done, doneIdx, error}.
 */
export async function executeOpsParallel(root, ops, { onStep, signal, concurrency = 4 } = {}) {
  const n = ops.length;
  const limit = Math.max(1, Math.min(concurrency | 0, 16));
  if (limit === 1 || n < 2) return executeOps(root, ops, { onStep, signal });
  const deps = opDependencies(ops);
  const waiting = deps.map((d) => d.length);
  const dependents = Array.from({ length: n }, () => []);
  deps.forEach((d, j) => d.forEach((i) => dependents[i].push(j)));
  // Ready ops start in plan order (smallest index first).
  const heap = [];
  const push = (v) => { heap.push(v); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p] <= heap[i]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { let m = i; const l = 2 * i + 1; const r = l + 1; if (l < heap.length && heap[l] < heap[m]) m = l; if (r < heap.length && heap[r] < heap[m]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  waiting.forEach((w, j) => { if (!w) push(j); });
  const finished = new Set();
  let failure = null; let running = 0; let sinceYield = 0;
  return new Promise((resolve) => {
    const finish = () => {
      const doneIdx = [...finished].sort((a, b) => a - b);
      const cancelled = !failure && doneIdx.length < n;
      resolve({ done: doneIdx.map((i) => ops[i]), doneIdx, error: failure || (cancelled ? new Error('Cancelled') : null) });
    };
    const pump = () => {
      if (signal?.aborted && !failure && finished.size < n) { while (heap.length) pop(); } // stop starting new ops
      while (!failure && running < limit && heap.length) {
        const j = pop(); const op = ops[j]; running++;
        runOp(root, op).then(() => {
          finished.add(j);
          for (const k of dependents[j]) if (--waiting[k] === 0) push(k);
          onStep?.(finished.size, op, j);
        }, (e) => { if (!failure) failure = wrapError(e, op); }).then(async () => {
          running--;
          if (++sinceYield >= 200) { sinceYield = 0; await yieldToUI(); }
          pump();
        });
      }
      if (!running && (failure || !heap.length)) finish();
    };
    pump();
  });
}

/** Reverse ops for restore */
export function reverseOps(ops) { return ops.slice().reverse().map((o) => ({ kind: o.kind, from: o.to, to: o.from })); }

/**
 * Simulate ops against a path set. Returns each op with status ok|missing|conflict and applies only ok ones.
 * paths: iterable of current paths (files & dirs)
 */
export function simulateOps(paths, ops, { caseSensitive = false } = {}) {
  const fold = caseSensitive ? (s) => s : (s) => s.toLowerCase();
  const cur = new Map(); for (const p of paths) cur.set(fold(p), p);
  const results = [];
  for (const op of ops) {
    const exact = cur.get(fold(op.from));
    if (!exact || (caseSensitive && exact !== op.from)) { results.push({ ...op, status: 'missing' }); continue; }
    const tgt = cur.get(fold(op.to));
    if (tgt && !(fold(op.to) === fold(op.from))) { results.push({ ...op, status: 'conflict' }); continue; }
    // apply (with children for dirs)
    const moves = [[exact, op.to]];
    const prefix = fold(exact) + '/';
    for (const [k, v] of cur) if (k.startsWith(prefix)) moves.push([v, op.to + v.slice(exact.length)]);
    for (const [a] of moves) cur.delete(fold(a));
    for (const [, b] of moves) cur.set(fold(b), b);
    results.push({ ...op, status: 'ok' });
  }
  return { results, ok: results.filter((r) => r.status === 'ok').length, missing: results.filter((r) => r.status === 'missing').length, conflict: results.filter((r) => r.status === 'conflict').length };
}

/** Apply ops to a list of paths (pure). Returns Map oldPath->newPath for items that moved. */
export function applyOpsToPaths(paths, ops) {
  const cur = new Map(paths.map((p) => [p, p])); // original -> current
  const inv = new Map(paths.map((p) => [p, p])); // current -> original
  for (const op of ops) {
    const moves = [];
    for (const [c, o] of inv) if (c === op.from || c.startsWith(op.from + '/')) moves.push([c, o]);
    for (const [c, o] of moves) { const n = op.to + c.slice(op.from.length); inv.delete(c); inv.set(n, o); cur.set(o, n); }
  }
  const out = new Map(); for (const [o, n] of cur) if (o !== n) out.set(o, n);
  return out;
}

export { basename };
