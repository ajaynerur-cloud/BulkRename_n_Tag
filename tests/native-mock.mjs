// A stand-in for the Android direct-file plugin (fsList, fsRead, fsRename ...), backed by an in-memory tree.
// Runs in Node and in the browser, so the same fake storage serves unit tests and the UI check.
const enc = (s) => (typeof s === 'string' ? new TextEncoder().encode(s) : s);
const b64 = (u8) => { let bin = ''; for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(bin); };
const unb64 = (s) => { const bin = atob(s || ''); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; };
const parent = (p) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const base = (p) => p.slice(p.lastIndexOf('/') + 1);

/** files: { '/storage/emulated/0/Music/a.mp3': Uint8Array | string }. Names are case-insensitive like Android's storage. */
export function makeNativePlugin(files, { granted = true } = {}) {
  const fsMap = new Map(); const dirs = new Set(['/', '/storage', '/storage/emulated', '/storage/emulated/0']);
  const addDirs = (p) => { for (let d = parent(p); d && !dirs.has(d); d = parent(d)) dirs.add(d); };
  for (const [p, d] of Object.entries(files)) { fsMap.set(p, { data: enc(d), mtime: 1_700_000_000_000 }); addDirs(p); }
  const lower = (p) => p.toLowerCase();
  const find = (p) => { for (const k of fsMap.keys()) if (lower(k) === lower(p)) return k; return null; };
  const findDir = (p) => { for (const k of dirs) if (lower(k) === lower(p)) return k; return null; };
  const kids = (dir) => {
    const out = new Map();
    for (const [k, v] of fsMap) if (parent(k) === dir) out.set(base(k), { name: base(k), isDir: false, size: v.data.length, mtime: v.mtime });
    for (const d of dirs) if (d !== dir && parent(d) === dir) out.set(base(d), { name: base(d), isDir: true, size: 0, mtime: 1_700_000_000_000 });
    return [...out.values()];
  };
  const api = {
    calls: [], granted, files: fsMap, dirs,
    async storageAccess() { return { granted: api.granted, sdk: 34 }; },
    async requestStorageAccess() { api.requested = true; },
    async fsRoots() { return { roots: [{ name: 'Internal storage', path: '/storage/emulated/0' }] }; },
    async fsList({ path }) { const d = findDir(path); return { entries: d ? kids(d) : [], readable: !!d && !/\/Android$/.test(d) }; },
    async fsListAll({ path }) {
      const out = []; const walk = (dir, prefix) => { for (const k of kids(dir)) { const rel = prefix ? `${prefix}/${k.name}` : k.name; out.push({ ...k, path: rel }); if (k.isDir) walk(`${dir}/${k.name}`, rel); } };
      walk(findDir(path) || path, ''); return { entries: out };
    },
    async fsStat({ path }) { const f = find(path); if (f) return { exists: true, isDir: false, size: fsMap.get(f).data.length, mtime: fsMap.get(f).mtime }; const d = findDir(path); return d ? { exists: true, isDir: true, size: 0, mtime: 0 } : { exists: false }; },
    async fsRead({ path, offset = 0, length = -1 }) { api.calls.push(`read:${length}`); const f = find(path); if (!f) throw new Error('Could not read the file: not found'); const d = fsMap.get(f).data; return { data: b64(d.subarray(offset, length < 0 ? undefined : offset + length)) }; },
    async fsWrite({ path, data, append }) {
      const bytes = unb64(data); const f = find(path) || path;
      if (append && fsMap.has(f)) { const old = fsMap.get(f).data; const n = new Uint8Array(old.length + bytes.length); n.set(old); n.set(bytes, old.length); fsMap.set(f, { data: n, mtime: Date.now() }); } else fsMap.set(f, { data: bytes, mtime: Date.now() });
      addDirs(f);
    },
    async fsWriteAt({ path, offset, data }) { const f = find(path); const d = fsMap.get(f).data; const before = d.length; d.set(unb64(data), offset); return { before, after: d.length }; },
    async fsRename({ from, to }) {
      const f = find(from); const dir = findDir(from);
      const sameParent = parent(from) === parent(to); const caseOnly = sameParent && lower(base(from)) === lower(base(to));
      if (!f && !dir) throw new Error(`Not found: ${base(from)}`);
      if ((find(to) || findDir(to)) && !caseOnly) throw new Error(`"${base(to)}" already exists`);
      if (f) { fsMap.set(to, fsMap.get(f)); fsMap.delete(f); addDirs(to); return; }
      const oldPrefix = dir; const moved = [];
      for (const [k, v] of fsMap) if (k.startsWith(`${oldPrefix}/`)) moved.push([k, v]);
      for (const [k, v] of moved) { fsMap.delete(k); fsMap.set(to + k.slice(oldPrefix.length), v); }
      const ds = [...dirs].filter((d) => d === oldPrefix || d.startsWith(`${oldPrefix}/`));
      for (const d of ds) dirs.delete(d);
      for (const d of ds) dirs.add(to + d.slice(oldPrefix.length));
      addDirs(to);
    },
    async fsDelete({ path }) { const f = find(path); if (f) { fsMap.delete(f); return { deleted: true }; } return { deleted: false }; },
  };
  return api;
}
