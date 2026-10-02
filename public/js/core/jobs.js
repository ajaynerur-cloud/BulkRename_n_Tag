// Background jobs: renames and tag saves run here, not inside a dialog, so the person can switch tabs,
// keep editing, or leave the browser / app while they finish.
//
// What keeps a job alive:
//  - The job is plain async code held by this module. Switching screens never touches it.
//  - While anything runs we hold a Web Lock (Chrome does not freeze or discard a tab that holds one),
//    ask for a screen wake lock (so the phone does not sleep mid-job), warn before the page is closed,
//    and in the Android app start a foreground service (see KeepAliveService.java) so Android does not
//    suspend the process when the app is in the background.
//  - Before a rename starts, its plan is written to the undo file, and the file is updated as work
//    proceeds (see renamer-ui.js). If the app is killed anyway, nothing is lost: Undo covers what was done
//    and Resume finishes the rest.
import { uuid } from './utils.js';

const jobs = [];
const subs = new Set();
const idleWaiters = [];

export const allJobs = () => jobs;
export const runningJobs = () => jobs.filter((j) => j.status === 'running');
export const hasRunning = () => jobs.some((j) => j.status === 'running');
export const isRunning = (id) => jobs.some((j) => j.status === 'running' && j.id === id);
/** The job currently working on this exact source object, if any. */
export const activeFor = (root) => (root ? jobs.find((j) => j.status === 'running' && j.root === root) || null : null);
export function onJobs(fn) { subs.add(fn); return () => subs.delete(fn); }
/** Resolves when no job is running (used to postpone an app update reload). */
export const whenIdle = () => (hasRunning() ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve());

let emitTimer = 0;
function emit(now = false) {
  const fire = () => { emitTimer = 0; for (const f of subs) { try { f(jobs); } catch (e) { console.warn(e); } } };
  if (now) { clearTimeout(emitTimer); fire(); } else if (!emitTimer) emitTimer = setTimeout(fire, 100);
}

/** Do two source objects point at the same folder / ZIP on disk? (Two pickers can open the same folder.) */
export async function sameSource(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  try {
    if (a.isSaf || b.isSaf) return !!(a.isSaf && b.isSaf && a.uri === b.uri);
    const ha = a.handle || a.fileHandle; const hb = b.handle || b.fileHandle;
    if (ha?.isSameEntry && hb) return await ha.isSameEntry(hb);
  } catch { /* fall through */ }
  return false;
}
/** A running job that is using the same source, or null. Two jobs on one folder would race. */
export async function conflictFor(root) {
  for (const j of runningJobs()) if (await sameSource(j.root, root)) return j;
  return null;
}

/**
 * startJob({ id?, kind, title, root, total?, run(ctx) }) -> job
 *   ctx.set(done, total, label)  report progress
 *   ctx.signal / ctx.cancelled   set when the person pressed Stop
 *   run resolves to { status: 'done'|'partial'|'error'|'cancelled', message, details?: string[], action?: {label, onClick} }
 * job.promise resolves with the same object when the job ends; it never rejects.
 */
export function startJob({ id, kind, title, root = null, total = 0, run }) {
  const controller = new AbortController();
  const job = { id: id || uuid(), kind, title, root, status: 'running', done: 0, total, label: '', startedAt: Date.now(), finishedAt: 0, cancelRequested: false, result: null, controller };
  const ctx = {
    signal: controller.signal,
    get cancelled() { return job.cancelRequested; },
    set(done, tot, label) {
      job.done = done; if (tot != null) job.total = tot; if (label != null) job.label = label;
      progressSideEffects(job);
      emit();
    },
  };
  jobs.push(job);
  engage(job);
  emit(true);
  job.promise = (async () => {
    let result;
    try { result = (await run(ctx)) || {}; } catch (e) { console.warn('job failed', e); result = { status: 'error', message: e.message || String(e) }; }
    if (job.cancelRequested && result.status === 'done') result.status = 'cancelled';
    job.result = result;
    job.status = result.status || 'done';
    job.finishedAt = Date.now();
    if (!hasRunning()) disengage();
    emit(true);
    if (!hasRunning()) for (const r of idleWaiters.splice(0)) r();
    if (job.status === 'done') setTimeout(() => dismissJob(job), 25_000);
    return result;
  })();
  return job;
}

export function cancelJob(job) {
  if (job.status !== 'running' || job.cancelRequested) return;
  job.cancelRequested = true; job.label = 'Stopping after the current items…';
  job.controller.abort();
  emit(true);
}
export function dismissJob(job) {
  if (job.status === 'running') return;
  const i = jobs.indexOf(job); if (i >= 0) jobs.splice(i, 1);
  emit(true);
}

/* ------------------------------------------------------------------ keeping the work alive */
let engaged = false; let releaseLock = null; let wake = null; let lastNative = 0;
const hasDom = typeof document !== 'undefined';
const native = () => (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() ? window.Capacitor?.Plugins?.NameTagFolders : null);

async function acquireWake() {
  try {
    if (!hasDom || wake || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    wake = await navigator.wakeLock.request('screen');
    wake.addEventListener('release', () => { wake = null; });
  } catch { wake = null; /* battery saver, or not allowed: not essential */ }
}
if (hasDom) document.addEventListener('visibilitychange', () => { if (engaged && document.visibilityState === 'visible') acquireWake(); });

function engage(job) {
  if (!engaged) {
    engaged = true;
    try {
      if (typeof navigator !== 'undefined' && navigator.locks?.request) navigator.locks.request('nametag-running-job', () => new Promise((res) => { releaseLock = res; })).catch(() => {});
    } catch { /* ignore */ }
    acquireWake();
  }
  try { native()?.startKeepAlive?.({ title: job.title, text: 'Starting…' })?.catch?.(() => {}); } catch { /* old app build without the service */ }
}
function disengage() {
  engaged = false;
  try { releaseLock?.(); } catch { /* ignore */ }
  releaseLock = null;
  try { wake?.release?.(); } catch { /* ignore */ }
  wake = null;
  setTitleProgress(null);
  try { native()?.stopKeepAlive?.()?.catch?.(() => {}); } catch { /* ignore */ }
}

function setTitleProgress(pct) {
  if (!hasDom) return;
  const base = document.title.replace(/^\(\d+%\)\s*/, '');
  document.title = pct == null ? base : `(${pct}%) ${base}`;
}
function progressSideEffects(job) {
  const running = runningJobs();
  const total = running.reduce((a, j) => a + (j.total || 0), 0);
  const done = running.reduce((a, j) => a + Math.min(j.done || 0, j.total || 0), 0);
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : null;
  if (pct != null) setTitleProgress(pct);
  const now = Date.now();
  if (now - lastNative > 1000) {
    lastNative = now;
    try { native()?.updateKeepAlive?.({ title: job.title, text: job.total ? `${job.done.toLocaleString('en-US')} of ${job.total.toLocaleString('en-US')}` : job.label, done: job.done, total: job.total })?.catch?.(() => {}); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ small concurrency helpers */
/** Memory shared by every running job: two tag saves at once must not each assume they own all of it. */
export const memoryBudget = { used: 0, pumps: new Set() };
/**
 * Run `worker(item, index)` over items with at most `limit` running at once, and never more than
 * `maxWeight` of summed weight() in flight (so a batch of big files cannot exhaust memory). Pass the same
 * `budget` object to several pools (jobs) and they share that limit. Items are started in order. Stops
 * starting new items when shouldStop() returns true. Results keep item order.
 */
export async function runPool(items, worker, { limit = 3, weight = () => 0, maxWeight = Infinity, shouldStop = () => false, budget = null } = {}) {
  const results = new Array(items.length);
  const b = budget || { used: 0, pumps: new Set() };
  let next = 0; let inflight = 0;
  return new Promise((resolve) => {
    let finished = false;
    const pump = () => {
      if (finished) return;
      while (next < items.length && inflight < limit && !shouldStop()) {
        const w = weight(items[next]);
        if (b.used > 0 && b.used + w > maxWeight) break; // wait for memory; a single huge item still runs alone
        const i = next++; inflight++; b.used += w;
        Promise.resolve().then(() => worker(items[i], i)).then(
          (r) => { results[i] = { ok: true, value: r }; },
          (e) => { results[i] = { ok: false, error: e }; },
        ).then(() => { inflight--; b.used -= w; for (const p of [...b.pumps]) p(); });
      }
      if (!inflight && (next >= items.length || shouldStop())) { finished = true; b.pumps.delete(pump); resolve(results); }
    };
    b.pumps.add(pump);
    pump();
  });
}
