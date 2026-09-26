// Roots: uniform interface over a real folder (File System Access API), a ZIP archive (JSZip),
// in-memory imported files (download result as ZIP), and loose file handles.
import { dirname, basename, joinPath, isIgnoredName, MANIFEST_RE, naturalCompare } from './utils.js';

export const support = {
  get dirPicker() { return typeof window !== 'undefined' && 'showDirectoryPicker' in window; },
  get filePicker() { return typeof window !== 'undefined' && 'showOpenFilePicker' in window; },
  get saveFilePicker() { return typeof window !== 'undefined' && 'showSaveFilePicker' in window; },
  get handleMove() { return typeof FileSystemHandle !== 'undefined' && 'move' in FileSystemHandle.prototype; },
};

function sortEntries(list) {
  return list.sort((a, b) => {
    const da = dirname(a.path); const db = dirname(b.path);
    if (da !== db) return naturalCompare(da, db);
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return naturalCompare(a.name, b.name);
  });
}

class BaseRoot {
  constructor(kind, name) { this.kind = kind; this.name = name; this.manifests = []; }
  get label() { return this.name; }
  /** Filter hook shared by all roots */
  _accept(name, opts) {
    if (MANIFEST_RE.test(name)) return 'manifest';
    return isIgnoredName(name, opts) ? false : true;
  }
}

/* ------------------------------------------------------------------ folder (FSA) */
export class DirRoot extends BaseRoot {
  constructor(handle) { super('dir', handle.name); this.handle = handle; this.canRenameInPlace = true; this.allowCopyFallback = false; }

  static async pick() {
    const handle = await window.showDirectoryPicker({ id: 'nametag', mode: 'readwrite' });
    return new DirRoot(handle);
  }
  async verifyPermission(write = true) {
    const opts = { mode: write ? 'readwrite' : 'read' };
    if ((await this.handle.queryPermission?.(opts)) === 'granted') return true;
    return (await this.handle.requestPermission?.(opts)) === 'granted';
  }
  async dir(path, create = false) {
    let d = this.handle;
    if (!path) return d;
    for (const seg of path.split('/')) d = await d.getDirectoryHandle(seg, { create });
    return d;
  }
  async fileHandle(path, create = false) {
    const d = await this.dir(dirname(path), create);
    return d.getFileHandle(basename(path), { create });
  }
  async list({ recursive = true, includeHidden = false, includeTemp = false, withFiles = true, onProgress } = {}) {
    const out = []; this.manifests = [];
    let count = 0;
    const walk = async (dh, prefix, depth) => {
      for await (const [name, h] of dh.entries()) {
        const acc = this._accept(name, { includeHidden, includeTemp });
        const path = joinPath(prefix, name);
        if (acc === 'manifest' && h.kind === 'file' && !prefix) { this.manifests.push({ path, name, getFile: () => h.getFile() }); continue; }
        if (!acc) continue;
        if (h.kind === 'directory') {
          out.push({ path, name, isDir: true, depth, handle: h });
          if (recursive) await walk(h, path, depth + 1);
        } else {
          const e = { path, name, isDir: false, depth, handle: h, getFile: () => h.getFile() };
          if (withFiles) { try { const f = await h.getFile(); e.size = f.size; e.mtime = f.lastModified; } catch { /* locked */ } }
          out.push(e);
        }
        if (onProgress && ++count % 200 === 0) onProgress(count);
      }
    };
    await walk(this.handle, '', 0);
    return sortEntries(out);
  }
  async exists(path) {
    try { const d = await this.dir(dirname(path)); const n = basename(path);
      try { await d.getFileHandle(n); return true; } catch (e) { if (e.name === 'TypeMismatchError') return true; }
      try { await d.getDirectoryHandle(n); return true; } catch (e) { if (e.name === 'TypeMismatchError') return true; }
      return false;
    } catch { return false; }
  }
  /** exact-case listing check, used for case-only renames on case-insensitive FS */
  async listNames(dirPath) {
    const d = await this.dir(dirPath); const names = [];
    for await (const name of d.keys()) names.push(name);
    return names;
  }
  async isDirectory(path) {
    if (!path) return true;
    try { const d = await this.dir(dirname(path)); await d.getDirectoryHandle(basename(path)); return true; } catch { return false; }
  }
  async move(from, to) {
    const fromDir = dirname(from); const toDir = dirname(to);
    const parent = await this.dir(fromDir);
    const newParent = fromDir === toDir ? parent : await this.dir(toDir, true);
    const name = basename(from); const newName = basename(to);
    let handle; let isDir = false;
    try { handle = await parent.getFileHandle(name); } catch { handle = await parent.getDirectoryHandle(name); isDir = true; }
    if (support.handleMove) {
      try {
        if (fromDir === toDir) await handle.move(newName); else await handle.move(newParent, newName);
        return;
      } catch (e) {
        if (!isDir || !this.allowCopyFallback) throw decorateMoveError(e, isDir);
      }
    } else if (isDir && !this.allowCopyFallback) {
      throw new Error('This browser cannot rename folders in place. Enable "Copy fallback for folders" in options, or use ZIP/import mode.');
    }
    // Fallback: copy then delete
    if (isDir) {
      const target = await newParent.getDirectoryHandle(newName, { create: true });
      await copyDirRecursive(handle, target);
      await parent.removeEntry(name, { recursive: true });
    } else {
      const f = await handle.getFile();
      const nh = await newParent.getFileHandle(newName, { create: true });
      const w = await nh.createWritable(); await w.write(f); await w.close();
      await parent.removeEntry(name);
    }
  }
  async readText(path) { return (await (await this.fileHandle(path)).getFile()).text(); }
  async writeText(path, text) { return this.writeFile(path, new Blob([text], { type: 'application/json' })); }
  async getFile(path) { return (await this.fileHandle(path)).getFile(); }
  async writeFile(path, blob) {
    const fh = await this.fileHandle(path, true);
    const w = await fh.createWritable({ keepExistingData: false });
    await w.write(blob); await w.close();
  }
  async remove(path) { const d = await this.dir(dirname(path)); await d.removeEntry(basename(path)); }
  async finalize() { return { saved: true, message: 'Changes were written directly to the folder.' }; }
}

function decorateMoveError(e, isDir) {
  const msg = isDir ? 'Folder rename failed (browsers may not support moving directories). Enable the copy fallback in options.' : `Rename failed: ${e.message || e.name}`;
  const err = new Error(msg); err.cause = e; return err;
}

async function copyDirRecursive(src, dst) {
  for await (const [name, h] of src.entries()) {
    if (h.kind === 'directory') await copyDirRecursive(h, await dst.getDirectoryHandle(name, { create: true }));
    else {
      const f = await h.getFile(); const nh = await dst.getFileHandle(name, { create: true });
      const w = await nh.createWritable(); await w.write(f); await w.close();
    }
  }
}

/* ------------------------------------------------------------------ ZIP (JSZip) */
export class ZipRoot extends BaseRoot {
  constructor(zip, name, { fileHandle = null, origFile = null } = {}) {
    super('zip', name); this.zip = zip; this.fileHandle = fileHandle; this.origFile = origFile; this.canRenameInPlace = true; this.dirty = false;
    this._index();
  }
  static async load(file, fileHandle = null) {
    const JSZip = globalThis.JSZip;
    if (!JSZip) throw new Error('ZIP library not loaded');
    const zip = await JSZip.loadAsync(file);
    return new ZipRoot(zip, file.name, { fileHandle, origFile: file });
  }
  _index() {
    // Map current path (no trailing slash) -> {obj|null, isDir, idx}
    this.map = new Map(); let idx = 0;
    for (const [key, obj] of Object.entries(this.zip.files)) {
      const isDir = obj.dir || key.endsWith('/');
      const p = key.replace(/\/+$/, '');
      if (!p) continue;
      this.map.set(p, { obj, isDir, idx: idx++ });
      // implicit parents
      let d = dirname(p);
      while (d && !this.map.has(d)) { this.map.set(d, { obj: null, isDir: true, idx: -1 }); d = dirname(d); }
    }
  }
  async list({ recursive = true, includeHidden = false, includeTemp = false } = {}) {
    const out = []; this.manifests = [];
    const hiddenBy = (p) => p.split('/').some((seg) => !this._accept(seg, { includeHidden, includeTemp }) && !MANIFEST_RE.test(seg));
    for (const [path, e] of this.map) {
      const name = basename(path);
      if (!e.isDir && !dirname(path) && MANIFEST_RE.test(name)) { this.manifests.push({ path, name, getFile: () => this.getFile(path) }); continue; }
      if (hiddenBy(path)) continue;
      const depth = path.split('/').length - 1;
      if (!recursive && depth > 0) continue;
      const ent = { path, name, isDir: e.isDir, depth };
      if (!e.isDir && e.obj) {
        ent.size = e.obj._data?.uncompressedSize ?? undefined; ent.mtime = e.obj.date?.getTime();
        ent.getFile = () => this.getFile(path);
      }
      out.push(ent);
    }
    return sortEntries(out);
  }
  exists(path) {
    if (this.map.has(path)) return true;
    const low = path.toLowerCase();
    for (const k of this.map.keys()) if (k.toLowerCase() === low) return 'case';
    return false;
  }
  async listNames(dirPath) { const out = []; for (const k of this.map.keys()) if (dirname(k) === dirPath) out.push(basename(k)); return out; }
  isDirectory(path) { return !path || !!this.map.get(path)?.isDir; }
  move(from, to) {
    const e = this.map.get(from);
    if (!e) throw new Error(`Not found in ZIP: ${from}`);
    if (this.map.has(to)) throw new Error(`Target exists in ZIP: ${to}`);
    const moves = [[from, to]];
    if (e.isDir) for (const k of this.map.keys()) if (k.startsWith(from + '/')) moves.push([k, to + k.slice(from.length)]);
    const vals = moves.map(([a]) => this.map.get(a));
    moves.forEach(([a]) => this.map.delete(a));
    moves.forEach(([, b], i) => this.map.set(b, vals[i]));
    let d = dirname(to); while (d && !this.map.has(d)) { this.map.set(d, { obj: null, isDir: true, idx: -1 }); d = dirname(d); }
    this.dirty = true;
  }
  async getFile(path) {
    const e = this.map.get(path); if (!e?.obj) throw new Error(`Not found in ZIP: ${path}`);
    const blob = await e.obj.async('blob');
    return new File([blob], basename(path), { lastModified: e.obj.date?.getTime() || Date.now() });
  }
  async readText(path) { return (await this.getFile(path)).text(); }
  writeText(path, text) { return this.writeFile(path, new Blob([text], { type: 'application/json' })); }
  async writeFile(path, blob) {
    const JSZip = globalThis.JSZip;
    const tmp = new JSZip(); tmp.file(path, blob, { date: new Date() });
    const obj = tmp.files[path];
    const prev = this.map.get(path);
    this.map.set(path, { obj, isDir: false, idx: prev ? prev.idx : Number.MAX_SAFE_INTEGER - 1000 + this.map.size });
    this.dirty = true;
  }
  remove(path) { this.map.delete(path); this.dirty = true; }
  /** Rebuild zip.files from the map, preserving original entry order. */
  rebuild() {
    const entries = [...this.map.entries()].filter(([, e]) => e.obj).sort((a, b) => a[1].idx - b[1].idx);
    const files = {};
    for (const [path, e] of entries) {
      const key = e.isDir ? path + '/' : path;
      e.obj.name = key; files[key] = e.obj;
    }
    this.zip.files = files;
  }
  async toBlob(onProgress) {
    this.rebuild();
    return this.zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/zip' },
      (m) => onProgress?.(m.percent));
  }
  async finalize({ onProgress, download } = {}) {
    const blob = await this.toBlob(onProgress);
    if (this.fileHandle) {
      try {
        const w = await this.fileHandle.createWritable(); await w.write(blob); await w.close();
        this.dirty = false;
        return { saved: true, message: `Saved ${this.name} in place.` };
      } catch (e) { console.warn('in-place zip save failed', e); }
    }
    download?.(blob, this.name.replace(/(\.zip)?$/i, '') + (this.fileHandle ? '' : '-renamed') + '.zip');
    this.dirty = false;
    return { saved: true, downloaded: true, message: 'Downloaded the updated ZIP.' };
  }
}

/* ------------------------------------------------------------------ imported files (memory) */
export class MemRoot extends BaseRoot {
  /** files: File[] with webkitRelativePath or plain */
  constructor(files, name = 'Imported files', { autoStrip = true } = {}) {
    super('mem', name); this.canRenameInPlace = false; this.map = new Map(); this.dirty = false;
    let idx = 0;
    const rels = files.map((f) => f.webkitRelativePath || f.relativePath || f.name);
    // If all share a single top folder, use it as root name and strip it
    const tops = new Set(rels.map((r) => (r.includes('/') ? r.split('/')[0] : '')));
    let strip = '';
    if (autoStrip && tops.size === 1 && [...tops][0]) { strip = [...tops][0] + '/'; this.name = [...tops][0]; }
    files.forEach((f, i) => {
      const p = rels[i].startsWith(strip) ? rels[i].slice(strip.length) : rels[i];
      if (!p) return;
      this.map.set(p, { file: f, isDir: false, idx: idx++ });
      let d = dirname(p); while (d && !this.map.has(d)) { this.map.set(d, { file: null, isDir: true, idx: idx++ }); d = dirname(d); }
    });
  }
  async list({ recursive = true, includeHidden = false, includeTemp = false } = {}) {
    const out = []; this.manifests = [];
    for (const [path, e] of this.map) {
      const name = basename(path);
      if (!e.isDir && !dirname(path) && MANIFEST_RE.test(name)) { this.manifests.push({ path, name, getFile: async () => e.file }); continue; }
      if (path.split('/').some((seg) => !this._accept(seg, { includeHidden, includeTemp }) && !MANIFEST_RE.test(seg))) continue;
      const depth = path.split('/').length - 1;
      if (!recursive && depth > 0) continue;
      out.push({ path, name, isDir: e.isDir, depth, size: e.file?.size, mtime: e.file?.lastModified, getFile: e.file ? async () => e.file : undefined });
    }
    return sortEntries(out);
  }
  exists(path) {
    if (this.map.has(path)) return true;
    const low = path.toLowerCase(); for (const k of this.map.keys()) if (k.toLowerCase() === low) return 'case';
    return false;
  }
  async listNames(dirPath) { const out = []; for (const k of this.map.keys()) if (dirname(k) === dirPath) out.push(basename(k)); return out; }
  isDirectory(path) { return !path || !!this.map.get(path)?.isDir; }
  move(from, to) {
    const e = this.map.get(from); if (!e) throw new Error(`Not found: ${from}`);
    if (this.map.has(to)) throw new Error(`Target exists: ${to}`);
    const moves = [[from, to]];
    if (e.isDir) for (const k of this.map.keys()) if (k.startsWith(from + '/')) moves.push([k, to + k.slice(from.length)]);
    const vals = moves.map(([a]) => this.map.get(a)); moves.forEach(([a]) => this.map.delete(a)); moves.forEach(([, b], i) => this.map.set(b, vals[i]));
    this.dirty = true;
  }
  async getFile(path) { const e = this.map.get(path); if (!e?.file) throw new Error(`Not found: ${path}`); return e.file; }
  async readText(path) { return (await this.getFile(path)).text(); }
  writeText(path, text) { return this.writeFile(path, new Blob([text], { type: 'application/json' })); }
  async writeFile(path, blob) {
    const prev = this.map.get(path);
    const file = new File([blob], basename(path), { lastModified: prev?.file?.lastModified || Date.now() });
    this.map.set(path, { file, isDir: false, idx: prev ? prev.idx : this.map.size + 1e6 }); this.dirty = true;
  }
  remove(path) { this.map.delete(path); this.dirty = true; }
  async toBlob(onProgress) {
    const zip = new globalThis.JSZip();
    const entries = [...this.map.entries()].sort((a, b) => a[1].idx - b[1].idx);
    for (const [path, e] of entries) {
      if (e.isDir) zip.folder(path);
      else zip.file(path, e.file, { date: new Date(e.file.lastModified || Date.now()) });
    }
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/zip' }, (m) => onProgress?.(m.percent));
  }
  async finalize({ onProgress, download } = {}) {
    const blob = await this.toBlob(onProgress);
    download?.(blob, `${this.name}-nametag.zip`);
    this.dirty = false;
    return { saved: true, downloaded: true, message: 'Downloaded a ZIP with the result (imported files cannot be changed in place).' };
  }
}

/* ------------------------------------------------------------------ loose file handles (tagger) */
export class FilesRoot extends BaseRoot {
  constructor(items, name = 'Selected files') {
    // items: [{file, handle?}]
    super('files', name); this.canRenameInPlace = false; this.items = new Map(); this.dirty = false; this.pending = new Map();
    for (const it of items) {
      let p = it.file.name; let n = 2; while (this.items.has(p)) p = `${it.file.name} (${n++})`;
      this.items.set(p, it);
    }
    this.writable = items.every((i) => i.handle);
  }
  static async pick() {
    const handles = await window.showOpenFilePicker({ id: 'nametag-audio', multiple: true, types: [{ description: 'Audio', accept: { 'audio/*': ['.mp3', '.flac', '.m4a', '.m4b', '.mp4', '.aac', '.ogg', '.oga', '.opus', '.wav', '.aif', '.aiff'] } }] });
    const items = []; for (const h of handles) items.push({ file: await h.getFile(), handle: h });
    return new FilesRoot(items);
  }
  async list() {
    return [...this.items.entries()].map(([path, it]) => ({ path, name: it.file.name, isDir: false, depth: 0, size: it.file.size, mtime: it.file.lastModified, getFile: () => this.getFile(path) }));
  }
  exists(path) { return this.items.has(path); }
  async getFile(path) {
    const it = this.items.get(path); if (!it) throw new Error('Not found');
    if (this.pending.has(path)) return this.pending.get(path);
    if (it.handle) { try { return await it.handle.getFile(); } catch { /* fall through */ } }
    return it.file;
  }
  async readText(path) { return (await this.getFile(path)).text(); }
  async writeFile(path, blob) {
    const it = this.items.get(path);
    if (it?.handle?.createWritable) {
      if ((await it.handle.queryPermission?.({ mode: 'readwrite' })) !== 'granted') await it.handle.requestPermission?.({ mode: 'readwrite' });
      const w = await it.handle.createWritable(); await w.write(blob); await w.close();
      return;
    }
    this.pending.set(path, new File([blob], it ? it.file.name : path)); this.dirty = true;
  }
  writeText(path, text) { this.pending.set(path, new File([text], basename(path), { type: 'application/json' })); this.dirty = true; return Promise.resolve(); }
  move() { throw new Error('Loose files cannot be renamed in place. Open the folder instead.'); }
  async finalize({ download } = {}) {
    if (!this.pending.size) return { saved: true, message: 'Saved.' };
    const zip = new globalThis.JSZip();
    for (const [p, f] of this.pending) zip.file(p, f);
    download?.(await zip.generateAsync({ type: 'blob' }), 'nametag-files.zip');
    this.pending.clear(); this.dirty = false;
    return { saved: true, downloaded: true, message: 'Downloaded changed files as a ZIP.' };
  }
}

/** Build a MemRoot from a DataTransfer (drag & drop), walking directories via webkitGetAsEntry. */
export async function filesFromDataTransfer(dt) {
  const items = [...(dt.items || [])];
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...(dt.files || [])];
  const out = [];
  const readAll = (reader) => new Promise((res, rej) => { const acc = []; const next = () => reader.readEntries((b) => { if (!b.length) res(acc); else { acc.push(...b); next(); } }, rej); next(); });
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      try { Object.defineProperty(f, 'relativePath', { value: prefix + f.name }); } catch { /* ignore */ }
      out.push(f);
    } else if (entry.isDirectory) {
      for (const c of await readAll(entry.createReader())) await walk(c, prefix + entry.name + '/');
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

/** Also expose for Node tests: a generic in-memory FS root with configurable case sensitivity */
export class MockRoot extends MemRoot {
  constructor(paths, { caseInsensitive = true } = {}) {
    super(paths.map((p) => { const f = { name: basename(p), relativePath: p, size: 1, lastModified: 0 }; return f; }), 'mock', { autoStrip: false });
    this.caseInsensitive = caseInsensitive; this.canRenameInPlace = true; this.log = [];
    for (const k of this.map.keys()) { const d = dirname(k); if (d && this.map.has(d)) this.map.get(d).isDir = true; }
  }
  exists(path) {
    if (this.map.has(path)) return true;
    if (!this.caseInsensitive) return false;
    const low = path.toLowerCase(); for (const k of this.map.keys()) if (k.toLowerCase() === low) return 'case';
    return false;
  }
  move(from, to) {
    if (this.caseInsensitive && from.toLowerCase() === to.toLowerCase() && from !== to) {
      // emulate risky copy-fallback semantics: a direct case-only move is refused in the mock
      throw new Error('case-only direct move refused');
    }
    const ex = this.exists(to); if (ex) throw new Error(`exists ${to}`);
    this.log.push([from, to]);
    super.move(from, to);
  }
}
