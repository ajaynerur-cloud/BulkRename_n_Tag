// A stand-in for the Android NameTagFolders plugin, backed by a real directory. It imitates Android's
// external-storage provider: document ids are "primary:<path>" (so renaming a folder changes its children's
// ids), names are case-insensitive, and renaming onto an existing name silently adds " (1)".
import fs from 'node:fs';
import path from 'node:path';

export function makeSafPlugin(base) {
  const abs = (id) => path.join(base, id.replace(/^primary:/, ''));
  const idFor = (rel) => `primary:${rel}`;
  const childrenOf = (id) => {
    const dir = abs(id);
    return fs.readdirSync(dir).map((name) => {
      const p = path.join(dir, name); const st = fs.statSync(p);
      const rel = path.relative(base, p).split(path.sep).join('/');
      return { id: idFor(rel), name, isDir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: Math.round(st.mtimeMs) };
    });
  };
  return {
    calls: [],
    async pick() { return { uri: 'content://tree/primary%3AMusic', rootId: 'primary:', name: path.basename(base) }; },
    async hasAccess() { return { granted: true }; },
    async list({ id, recursive = true }) {
      this.calls.push('list');
      const out = []; const q = [[id, '']];
      while (q.length) {
        const [cur, prefix] = q.shift();
        for (const c of childrenOf(cur)) { const p = prefix ? `${prefix}/${c.name}` : c.name; out.push({ ...c, path: p }); if (c.isDir && recursive) q.push([c.id, p]); }
      }
      return { entries: out };
    },
    async read({ id, offset = 0, length = -1 }) {
      this.calls.push(`read:${length}`);
      const buf = fs.readFileSync(abs(id));
      return { data: buf.subarray(offset, length < 0 ? undefined : offset + length).toString('base64') };
    },
    async write({ id, parentId, name, data, append }) {
      const bytes = Buffer.from(data || '', 'base64');
      if (!id) { const rel = path.join(parentId.replace(/^primary:/, ''), name).split(path.sep).join('/'); fs.writeFileSync(path.join(base, rel), bytes); return { id: idFor(rel) }; }
      if (append) fs.appendFileSync(abs(id), bytes); else fs.writeFileSync(abs(id), bytes);
      return { id };
    },
    async rename({ id, name }) {
      const from = abs(id); const dir = path.dirname(from);
      let finalName = name;
      const taken = (n) => fs.readdirSync(dir).some((x) => x.toLowerCase() === n.toLowerCase() && x !== path.basename(from));
      if (taken(finalName)) { const i = name.lastIndexOf('.'); finalName = i > 0 ? `${name.slice(0, i)} (1)${name.slice(i)}` : `${name} (1)`; }
      fs.renameSync(from, path.join(dir, finalName));
      const rel = path.relative(base, path.join(dir, finalName)).split(path.sep).join('/');
      return { id: idFor(rel), name: finalName };
    },
    async delete({ id }) { fs.rmSync(abs(id), { recursive: true }); return { deleted: true }; },
  };
}
