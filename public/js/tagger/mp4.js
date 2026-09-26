// MP4 / M4A / M4B metadata (iTunes-style moov.udta.meta.ilst). Rewrites moov and shifts chunk offsets.
import { readSlice, ascii, u32be, u16be, u64be, concat, w32be, asciiBytes, utf8, utf8Bytes, latin1, latin1Bytes, put32be, mimeFromBytes } from './bytes.js';
import { emptyModel, GENRES } from './model.js';

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'meta', 'edts', 'dinf', 'mvex', 'ilst', 'stsd']);
const TEXT_ITEMS = {
  '©nam': 'title', '©ART': 'artist', '©alb': 'album', aART: 'albumartist', '©day': 'year', '©gen': 'genre', '©wrt': 'composer', '©cmt': 'comment', '©lyr': 'lyrics',
  '©grp': 'grouping', cprt: 'copyright', '©enc': 'encodedby', sonm: 'sorttitle', soar: 'sortartist', soal: 'sortalbum', soaa: 'sortalbumartist', '©st3': 'subtitle',
};
const FIELD_ITEM = Object.fromEntries(Object.entries(TEXT_ITEMS).map(([k, v]) => [v, k]));
const FREEFORM = { ISRC: 'isrc', LABEL: 'publisher', PUBLISHER: 'publisher', CONDUCTOR: 'conductor', LYRICIST: 'lyricist', SUBTITLE: 'subtitle', MOOD: 'mood', initialkey: 'key', LANGUAGE: 'language', REMIXER: 'remixer' };
const FIELD_FREEFORM = { isrc: 'ISRC', publisher: 'LABEL', conductor: 'CONDUCTOR', lyricist: 'LYRICIST', mood: 'MOOD', key: 'initialkey', language: 'LANGUAGE', remixer: 'REMIXER' };
const MANAGED = new Set([...Object.keys(TEXT_ITEMS), 'trkn', 'disk', 'tmpo', 'cpil', 'gnre', 'covr']);

function parseAtoms(b, start, end, depth = 0) {
  const out = []; let o = start;
  while (o + 8 <= end) {
    let size = u32be(b, o); const type = latin1(b.subarray(o + 4, o + 8)); let hl = 8;
    if (size === 1) { size = u64be(b, o + 8); hl = 16; } else if (size === 0) size = end - o;
    if (size < hl || o + size > end) break;
    const node = { type, off: o, size, hl, extra: 0, children: null };
    if (CONTAINERS.has(type) && depth < 12) {
      let cs = o + hl;
      if (type === 'meta') { if (ascii(b, cs + 4, 4) !== 'hdlr') { node.extra = 4; cs += 4; } }
      if (type === 'stsd') { node.extra = 8; cs += 8; }
      node.children = type === 'ilst' ? parseAtoms(b, cs, o + size, 99) : parseAtoms(b, cs, o + size, depth + 1);
    }
    out.push(node); o += size;
  }
  return out;
}
const child = (n, t) => n?.children?.find((c) => c.type === t);
const path = (n, ...ts) => ts.reduce((a, t) => child(a, t), n);

async function topLevel(file) {
  const atoms = []; let o = 0;
  while (o + 8 <= file.size) {
    const h = await readSlice(file, o, o + 16);
    let size = u32be(h, 0); const type = latin1(h.subarray(4, 8)); let hl = 8;
    if (size === 1) { size = u64be(h, 8); hl = 16; } else if (size === 0) size = file.size - o;
    if (size < 8 || !/^[\x20-\xff]{4}$/.test(type)) break;
    atoms.push({ type, off: o, size, hl });
    o += size;
  }
  return atoms;
}

function parseItems(buf, ilst) {
  const items = [];
  for (const it of ilst.children || []) {
    const rec = { type: it.type, raw: buf.slice(it.off, it.off + it.size), data: [] };
    const sub = parseAtoms(buf, it.off + it.hl, it.off + it.size, 99);
    for (const s of sub) {
      const body = buf.subarray(s.off + s.hl, s.off + s.size);
      if (s.type === 'data') rec.data.push({ type: u32be(body, 0) & 0xffffff, value: body.subarray(8) });
      else if (s.type === 'mean') rec.mean = utf8(body.subarray(4));
      else if (s.type === 'name') rec.name = utf8(body.subarray(4));
    }
    items.push(rec);
  }
  return items;
}

export async function readMp4(file) {
  const top = await topLevel(file);
  const moovA = top.find((a) => a.type === 'moov');
  if (!moovA) throw new Error('No moov atom found');
  const buf = await readSlice(file, moovA.off, moovA.off + moovA.size);
  const [moov] = parseAtoms(buf, 0, buf.length);
  const model = emptyModel('MP4');
  // props
  const mvhd = child(moov, 'mvhd');
  if (mvhd) {
    const b = buf.subarray(mvhd.off + mvhd.hl); const v = b[0];
    const ts = v === 1 ? u32be(b, 20) : u32be(b, 12); const dur = v === 1 ? u64be(b, 24) : u32be(b, 16);
    model.props.duration = ts ? dur / ts : 0;
  }
  for (const trak of moov.children.filter((c) => c.type === 'trak')) {
    const hdlr = path(trak, 'mdia', 'hdlr'); if (hdlr && ascii(buf, hdlr.off + hdlr.hl + 8, 4) !== 'soun') continue;
    const stsd = path(trak, 'mdia', 'minf', 'stbl', 'stsd');
    const e = stsd?.children?.[0];
    if (e) {
      model.props.codec = { mp4a: 'AAC', alac: 'ALAC', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', Opus: 'Opus', fLaC: 'FLAC', mp3: 'MP3', '.mp3': 'MP3' }[e.type] || e.type;
      const b = buf.subarray(e.off + 8);
      model.props.channels = u16be(b, 16); model.props.sampleRate = u32be(b, 24) >>> 16;
    }
    break;
  }
  const mdat = top.filter((a) => a.type === 'mdat').reduce((s, a) => s + a.size, 0);
  if (model.props.duration) model.props.bitrate = Math.round(((mdat || file.size) * 8) / model.props.duration / 1000);
  if (top.some((a) => a.type === 'moof') || child(moov, 'mvex')) model.notes.push('Fragmented MP4: tags can be read but not written.');
  const ilst = path(moov, 'udta', 'meta', 'ilst');
  if (ilst) itemsToModel(parseItems(buf, ilst), model);
  return model;
}

function itemsToModel(items, model) {
  const f = model.fields;
  for (const it of items) {
    const d = it.data[0];
    if (TEXT_ITEMS[it.type] && d) { f[TEXT_ITEMS[it.type]] = it.data.map((x) => utf8(x.value)).join('; '); continue; }
    switch (it.type) {
      case 'trkn': if (d && d.value.length >= 6) { const t = u16be(d.value, 2); const n = u16be(d.value, 4); if (t) f.track = String(t); if (n) f.tracktotal = String(n); } continue;
      case 'disk': if (d && d.value.length >= 6) { const t = u16be(d.value, 2); const n = u16be(d.value, 4); if (t) f.disc = String(t); if (n) f.disctotal = String(n); } continue;
      case 'tmpo': if (d?.value.length) { const v = d.value.length >= 2 ? u16be(d.value, 0) : d.value[0]; if (v) f.bpm = String(v); } continue;
      case 'cpil': if (d?.value.length && d.value[d.value.length - 1]) f.compilation = '1'; continue;
      case 'gnre': if (d?.value.length >= 2 && !f.genre) { const g = GENRES[u16be(d.value, 0) - 1]; if (g) f.genre = g; } continue;
      case 'covr': for (const x of it.data) model.pictures.push({ type: 3, mime: x.type === 14 ? 'image/png' : x.type === 13 ? 'image/jpeg' : mimeFromBytes(x.value), desc: '', data: x.value.slice() }); continue;
      case '----': {
        if (it.mean === 'com.apple.iTunes' && it.name && d) {
          const val = it.data.map((x) => utf8(x.value)).join('; ');
          const field = FREEFORM[it.name] || FREEFORM[it.name.toUpperCase()];
          if (field && !f[field]) f[field] = val; else if (!field) model.custom.push({ key: it.name, value: val });
          it.mapped = true;
        }
        continue;
      }
      default:
    }
  }
  return model;
}

/* ------------------------------------------------------------------ writing */
const atom = (type, ...parts) => { const body = concat(parts); return concat([w32be(body.length + 8), latin1Bytes(type), body]); };
const dataAtom = (type, value) => atom('data', w32be(type), w32be(0), value);
const textItem = (type, s) => atom(type, dataAtom(1, utf8Bytes(s)));
const freeform = (name, s) => atom('----', atom('mean', w32be(0), utf8Bytes('com.apple.iTunes')), atom('name', w32be(0), utf8Bytes(name)), dataAtom(1, utf8Bytes(s)));

function buildIlst(model, origItems) {
  const f = model.fields; const out = [];
  for (const [field, type] of Object.entries(FIELD_ITEM)) if (f[field]) out.push(textItem(type, f[field]));
  if (f.track || f.tracktotal) { const v = new Uint8Array(8); v[2] = (+f.track >> 8) & 255; v[3] = +f.track & 255; v[4] = (+f.tracktotal >> 8) & 255; v[5] = +f.tracktotal & 255; out.push(atom('trkn', dataAtom(0, v))); }
  if (f.disc || f.disctotal) { const v = new Uint8Array(6); v[2] = (+f.disc >> 8) & 255; v[3] = +f.disc & 255; v[4] = (+f.disctotal >> 8) & 255; v[5] = +f.disctotal & 255; out.push(atom('disk', dataAtom(0, v))); }
  if (f.bpm && +f.bpm) { const n = Math.round(+f.bpm); out.push(atom('tmpo', dataAtom(21, new Uint8Array([(n >> 8) & 255, n & 255])))); }
  if (f.compilation && f.compilation !== '0') out.push(atom('cpil', dataAtom(21, new Uint8Array([1]))));
  for (const [field, name] of Object.entries(FIELD_FREEFORM)) if (f[field]) out.push(freeform(name, f[field]));
  for (const c of model.custom || []) if (c.key) out.push(freeform(c.key, c.value ?? ''));
  if (model.pictures?.length) out.push(atom('covr', ...model.pictures.map((p) => dataAtom(/png/.test(p.mime) ? 14 : /bmp/.test(p.mime) ? 27 : 13, p.data))));
  for (const it of origItems) {
    if (MANAGED.has(it.type)) continue;
    if (it.type === '----' && it.mapped) continue;
    out.push(it.raw);
  }
  return atom('ilst', ...out);
}

const HDLR = () => atom('hdlr', new Uint8Array(4), new Uint8Array(4), asciiBytes('mdirappl'), new Uint8Array(9));

function serialize(buf, node, over, append, dirty) {
  if (over.has(node)) return over.get(node);
  if (!dirty.has(node)) return buf.subarray(node.off, node.off + node.size);
  const parts = [];
  if (node.extra) parts.push(buf.subarray(node.off + node.hl, node.off + node.hl + node.extra));
  for (const c of node.children) parts.push(serialize(buf, c, over, append, dirty));
  if (append.has(node)) parts.push(...append.get(node));
  return atom(node.type, ...parts);
}

export async function writeMp4(file, model, { strip = false } = {}) {
  const top = await topLevel(file);
  const moovA = top.find((a) => a.type === 'moov');
  if (!moovA) throw new Error('No moov atom found');
  if (top.some((a) => a.type === 'moof')) throw new Error('Fragmented MP4 files are not supported for writing');
  const buf = await readSlice(file, moovA.off, moovA.off + moovA.size);
  const [moov] = parseAtoms(buf, 0, buf.length);
  if (child(moov, 'mvex')) throw new Error('Fragmented MP4 files are not supported for writing');
  const udta = child(moov, 'udta'); const meta = child(udta, 'meta'); const ilst = child(meta, 'ilst');
  const items = ilst ? parseItems(buf, ilst) : [];
  if (ilst) itemsToModel(items, emptyModel()); // marks mapped freeform items
  const newIlst = buildIlst(model, strip ? [] : items);
  const over = new Map(); const append = new Map(); const dirty = new Set([moov]);
  if (ilst) { over.set(ilst, newIlst); dirty.add(udta); dirty.add(meta); }
  else if (meta) {
    dirty.add(udta); dirty.add(meta);
    append.set(meta, child(meta, 'hdlr') ? [newIlst] : [HDLR(), newIlst]);
  } else if (udta) { dirty.add(udta); append.set(udta, [atom('meta', new Uint8Array(4), HDLR(), newIlst)]); }
  else append.set(moov, [atom('udta', atom('meta', new Uint8Array(4), HDLR(), newIlst))]);
  // first pass for size delta
  const trial = serialize(buf, moov, over, append, dirty);
  const delta = trial.length - moovA.size;
  let finalMoov = trial;
  if (delta !== 0) {
    // shift chunk offsets that point after the moov atom
    const copy = buf.slice();
    const moovEnd = moovA.off + moovA.size;
    for (const trak of moov.children.filter((c) => c.type === 'trak')) {
      const stbl = path(trak, 'mdia', 'minf', 'stbl'); if (!stbl) continue;
      for (const t of stbl.children) {
        if (t.type !== 'stco' && t.type !== 'co64') continue;
        const b0 = t.off + t.hl; const n = u32be(copy, b0 + 4);
        for (let i = 0; i < n; i++) {
          if (t.type === 'stco') {
            const p = b0 + 8 + i * 4; const v = u32be(copy, p);
            if (v >= moovEnd - 1 || v >= moovA.off) { const nv = v + delta; if (nv > 0xffffffff) throw new Error('File too large to retag (32-bit chunk offsets overflow)'); put32be(copy, p, nv); }
          } else {
            const p = b0 + 8 + i * 8; const v = u64be(copy, p);
            if (v >= moovA.off) { const nv = v + delta; put32be(copy, p, Math.floor(nv / 4294967296)); put32be(copy, p + 4, nv >>> 0); }
          }
        }
      }
    }
    finalMoov = serialize(copy, moov, over, append, dirty);
  }
  return new Blob([file.slice(0, moovA.off), finalMoov, file.slice(moovA.off + moovA.size)], { type: 'audio/mp4' });
}
