// A small pool of Web Workers for writing tags. Falls back to doing the work on the main thread when
// workers are unavailable (old WebView, blocked by policy, tests in Node), so saving always works.
import { writeTags } from './index.js';

const MAX = Math.max(1, Math.min(3, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2) - 1));
const slots = [];
const queue = [];
let broken = typeof Worker === 'undefined';
let seq = 0;

function spawn() {
  let w;
  try { w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); } catch { broken = true; return null; }
  const slot = { w, task: null };
  w.onmessage = (e) => {
    const t = slot.task; if (!t || e.data.id !== t.id) return;
    slot.task = null;
    if (e.data.error) t.reject(new Error(e.data.error)); else t.resolve({ blob: e.data.blob, notes: e.data.notes || [] });
    next(slot);
  };
  w.onerror = () => {
    // The worker script itself failed to load or crashed: stop using workers and redo the task here.
    broken = true;
    const t = slot.task; slot.task = null;
    try { w.terminate(); } catch { /* ignore */ }
    const i = slots.indexOf(slot); if (i >= 0) slots.splice(i, 1);
    if (t) t.reject(Object.assign(new Error('worker failed'), { fallback: true }));
    for (const q of queue.splice(0)) q.reject(Object.assign(new Error('worker failed'), { fallback: true }));
  };
  slots.push(slot);
  return slot;
}
function next(slot) {
  if (slot.task || !queue.length) return;
  const t = queue.shift(); slot.task = t;
  try { slot.w.postMessage({ id: t.id, file: t.file, model: t.model, opts: t.opts }); } catch (e) { slot.task = null; t.reject(Object.assign(e, { fallback: true })); next(slot); }
}

/** Same result as writeTags(file, model, opts), computed in a worker when possible. */
export async function writeTagsOffThread(file, model, opts) {
  if (!broken) {
    try {
      return await new Promise((resolve, reject) => {
        const task = { id: ++seq, file, model, opts, resolve, reject };
        queue.push(task);
        const idle = slots.find((s) => !s.task) || (slots.length < MAX ? spawn() : null);
        if (broken && !idle) { const i = queue.indexOf(task); if (i >= 0) queue.splice(i, 1); reject(Object.assign(new Error('no workers'), { fallback: true })); return; }
        if (idle) next(idle);
      });
    } catch (e) { if (!e.fallback) throw e; }
  }
  return writeTags(file, model, opts);
}
