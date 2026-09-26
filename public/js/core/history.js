// History of rename / tag jobs in IndexedDB. Stores the manifest and (when available) the
// FileSystemDirectoryHandle so a job can be restored later from the History tab.
const DB = 'nametag'; const STORE = 'history';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') { rej(new Error('IndexedDB unavailable')); return; }
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { const s = r.result.createObjectStore(STORE, { keyPath: 'id' }); s.createIndex('createdAt', 'createdAt'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode); const s = t.objectStore(STORE);
    const out = fn(s);
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
  });
}

export async function addHistory(entry) {
  // entry: {id, type, createdAt, rootName, source, manifestName, manifest, handle?, status}
  try { await tx('readwrite', (s) => s.put(entry)); } catch (e) {
    // handles may not be cloneable in some browsers — retry without
    if (entry.handle) { const { handle, ...rest } = entry; await tx('readwrite', (s) => s.put(rest)); } else console.warn('history', e);
  }
}
export async function updateHistory(id, patch) {
  const cur = await getHistory(id); if (!cur) return;
  await addHistory({ ...cur, ...patch });
}
export async function getHistory(id) { try { return await tx('readonly', (s) => s.get(id)); } catch { return null; } }
export async function listHistory() {
  try {
    const all = await tx('readonly', (s) => s.getAll());
    return (all || []).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } catch { return []; }
}
export async function deleteHistory(id) { try { await tx('readwrite', (s) => s.delete(id)); } catch { /* ignore */ } }
export async function clearHistory() { try { await tx('readwrite', (s) => s.clear()); } catch { /* ignore */ } }
