// ID3v2.2 / 2.3 / 2.4 reader and v2.3 / v2.4 writer, plus ID3v1.
import {
  u32be, u24be, syncsafe, ascii, asciiBytes, concat, decodeText, encodeText, findTerm, termLen, latin1, latin1Bytes, isLatin1,
  w32be, wSyncsafe, mimeFromBytes,
} from './bytes.js';
import { emptyModel, splitNumTotal, resolveGenre, GENRES } from './model.js';

const V22 = { TT2: 'TIT2', TP1: 'TPE1', TAL: 'TALB', TP2: 'TPE2', TRK: 'TRCK', TPA: 'TPOS', TYE: 'TYER', TCO: 'TCON', TCM: 'TCOM', COM: 'COMM', ULT: 'USLT', TPB: 'TPUB', TCR: 'TCOP', TEN: 'TENC', TBP: 'TBPM', TKE: 'TKEY', TRC: 'TSRC', TT1: 'TIT1', TT3: 'TIT3', TP3: 'TPE3', TP4: 'TPE4', TXT: 'TEXT', TXX: 'TXXX', PIC: 'APIC', TLA: 'TLAN', TCP: 'TCMP', TDA: 'TDAT', TOR: 'TORY', TSS: 'TSSE', TS2: 'TSO2', TSA: 'TSOA', TSP: 'TSOP', TST: 'TSOT' };

export const FRAME_FIELD = {
  TIT2: 'title', TPE1: 'artist', TALB: 'album', TPE2: 'albumartist', TCON: 'genre', TCOM: 'composer', TPUB: 'publisher', TCOP: 'copyright', TENC: 'encodedby',
  TBPM: 'bpm', TKEY: 'key', TSRC: 'isrc', TIT1: 'grouping', GRP1: 'grouping', TCMP: 'compilation', TPE3: 'conductor', TEXT: 'lyricist', TPE4: 'remixer', TIT3: 'subtitle',
  TMOO: 'mood', TLAN: 'language', TSOT: 'sorttitle', TSOP: 'sortartist', TSOA: 'sortalbum', TSO2: 'sortalbumartist',
};
const FIELD_FRAME = Object.fromEntries(Object.entries(FRAME_FIELD).filter(([k]) => k !== 'GRP1').map(([k, v]) => [v, k]));
const TXXX_FIELDS = { MOOD: 'mood' }; // v2.3 has no TMOO
const MANAGED = new Set([...Object.keys(FRAME_FIELD), 'TRCK', 'TPOS', 'TYER', 'TDRC', 'TDAT', 'TXXX', 'APIC']);

/** Remove unsynchronisation (FF 00 -> FF) */
export function deUnsync(b) {
  let n = 0; for (let i = 0; i < b.length - 1; i++) if (b[i] === 0xff && b[i + 1] === 0) n++;
  if (!n) return b;
  const out = new Uint8Array(b.length - n); let o = 0;
  for (let i = 0; i < b.length; i++) { out[o++] = b[i]; if (b[i] === 0xff && b[i + 1] === 0) i++; }
  return out;
}

/** Return total ID3v2 tag length at start of bytes (incl header/footer) or 0 */
export function id3v2Size(head) {
  if (head.length < 10 || ascii(head, 0, 3) !== 'ID3' || head[3] > 4 || head[3] < 2) return 0;
  return 10 + syncsafe(head, 6) + (head[3] === 4 && head[5] & 0x10 ? 10 : 0);
}

const validId = (b, o, n) => { for (let i = 0; i < n; i++) { const c = b[o + i]; if (!((c >= 65 && c <= 90) || (c >= 48 && c <= 57))) return false; } return true; };

/** Parse an ID3v2 tag (bytes = whole tag incl header). */
export function parseID3v2(bytes) {
  const major = bytes[3]; const flags = bytes[5];
  const size = syncsafe(bytes, 6);
  let body = bytes.subarray(10, 10 + size);
  if (flags & 0x80 && major < 4) body = deUnsync(body);
  let o = 0;
  if (flags & 0x40 && major >= 3) {
    o = major === 3 ? 4 + u32be(body, 0) : syncsafe(body, 0);
  }
  const frames = [];
  const hlen = major === 2 ? 6 : 10;
  while (o + hlen <= body.length) {
    if (body[o] === 0) break; // padding
    const idLen = major === 2 ? 3 : 4;
    if (!validId(body, o, idLen)) break;
    let id = ascii(body, o, idLen);
    let fsize;
    if (major === 2) fsize = u24be(body, o + 3);
    else if (major === 3) fsize = u32be(body, o + 4);
    else {
      fsize = syncsafe(body, o + 4);
      // iTunes-style non-syncsafe sizes: prefer the reading that lands on a valid frame or padding
      const plain = u32be(body, o + 4);
      if (plain !== fsize && plain >= 0x80) {
        const okSafe = o + 10 + fsize === body.length || (o + 10 + fsize + 4 <= body.length && (validId(body, o + 10 + fsize, 4) || body[o + 10 + fsize] === 0));
        const okPlain = o + 10 + plain === body.length || (o + 10 + plain + 4 <= body.length && (validId(body, o + 10 + plain, 4) || body[o + 10 + plain] === 0));
        if (!okSafe && okPlain) fsize = plain;
      }
    }
    if (fsize <= 0 || o + hlen + fsize > body.length) break;
    const f1 = major === 2 ? 0 : body[o + 8]; const f2 = major === 2 ? 0 : body[o + 9];
    const raw = body.subarray(o, o + hlen + fsize);
    let content = body.subarray(o + hlen, o + hlen + fsize);
    let parsable = true;
    if (major === 3) {
      if (f2 & 0x80 || f2 & 0x40) parsable = false; // compressed / encrypted
      else if (f2 & 0x20) content = content.subarray(1);
    } else if (major === 4) {
      if (f2 & 0x08 || f2 & 0x04) parsable = false;
      else {
        if (f2 & 0x40) content = content.subarray(1);
        if (f2 & 0x01) content = content.subarray(4);
        if (f2 & 0x02 || flags & 0x80) content = deUnsync(content);
      }
    }
    const origId = id;
    if (major === 2) id = V22[id] || id;
    frames.push({ id, origId, f1, f2, content, raw, parsable, v22: major === 2 && !V22[origId] });
    o += hlen + fsize;
  }
  return { major, frames, size: 10 + size };
}

function textValue(content, major) {
  if (!content.length) return '';
  const enc = content[0];
  let s = decodeText(enc, content.subarray(1));
  s = s.replace(/\0+$/, '');
  if (s.includes('\0')) s = s.split('\0').filter(Boolean).join(major === 4 ? '; ' : ' ');
  return s;
}

function parseCommLike(content) {
  const enc = content[0]; const lang = ascii(content, 1, 3);
  const t = findTerm(content, 4, enc);
  const desc = t < 0 ? '' : decodeText(enc, content.subarray(4, t));
  const text = t < 0 ? decodeText(enc, content.subarray(4)) : decodeText(enc, content.subarray(t + termLen(enc)));
  return { lang, desc: desc.replace(/\0+$/, ''), text: text.replace(/\0+$/, '') };
}
function parseTXXX(content) {
  const enc = content[0]; const t = findTerm(content, 1, enc);
  if (t < 0) return { desc: decodeText(enc, content.subarray(1)), value: '' };
  return { desc: decodeText(enc, content.subarray(1, t)), value: decodeText(enc, content.subarray(t + termLen(enc))).replace(/\0+$/, '').split('\0').join('; ') };
}
function parseAPIC(content, v22) {
  const enc = content[0]; let o = 1; let mime;
  if (v22) { const fmt = ascii(content, 1, 3).toUpperCase(); mime = fmt === 'PNG' ? 'image/png' : 'image/jpeg'; o = 4; } else {
    const t = content.indexOf(0, 1); mime = latin1(content.subarray(1, t)); o = t + 1;
  }
  const type = content[o]; o++;
  const t2 = findTerm(content, o, enc);
  const desc = decodeText(enc, content.subarray(o, t2 < 0 ? o : t2));
  const data = content.slice(t2 < 0 ? o : t2 + termLen(enc));
  if (!mime || !mime.includes('/')) mime = mime && /png/i.test(mime) ? 'image/png' : mimeFromBytes(data);
  return { type, mime: mime.toLowerCase() === 'image/jpg' ? 'image/jpeg' : mime, desc, data };
}

/** Convert parsed frames to model; marks frames as mapped. */
export function id3ToModel(tag, model = emptyModel('id3')) {
  const f = model.fields; let commDone = false; let usltDone = false;
  let tdat = '';
  for (const fr of tag.frames) {
    if (!fr.parsable) continue;
    const id = fr.id;
    try {
      if (FRAME_FIELD[id]) { if (!f[FRAME_FIELD[id]]) f[FRAME_FIELD[id]] = textValue(fr.content, tag.major); fr.mapped = true; }
      else if (id === 'TRCK') { const [a, b] = splitNumTotal(textValue(fr.content)); f.track = a; if (b) f.tracktotal = b; fr.mapped = true; }
      else if (id === 'TPOS') { const [a, b] = splitNumTotal(textValue(fr.content)); f.disc = a; if (b) f.disctotal = b; fr.mapped = true; }
      else if (id === 'TDRC' || id === 'TYER') { const v = textValue(fr.content); if (v && (!f.year || id === 'TDRC')) f.year = v; fr.mapped = true; }
      else if (id === 'TDAT') { tdat = textValue(fr.content); fr.mapped = true; }
      else if (id === 'COMM' && !commDone) {
        const c = parseCommLike(fr.content);
        if (!c.desc || c.desc === 'Comment') { f.comment = c.text; commDone = true; fr.mapped = true; fr.lang = c.lang; }
      } else if (id === 'USLT' && !usltDone) { const c = parseCommLike(fr.content); f.lyrics = c.text; usltDone = true; fr.mapped = true; }
      else if (id === 'TXXX') {
        const t = parseTXXX(fr.content);
        const up = t.desc.toUpperCase();
        if (TXXX_FIELDS[up] && !f[TXXX_FIELDS[up]]) f[TXXX_FIELDS[up]] = t.value; else model.custom.push({ key: t.desc, value: t.value });
        fr.mapped = true;
      } else if (id === 'APIC') { model.pictures.push(parseAPIC(fr.content, fr.origId === 'PIC')); fr.mapped = true; }
    } catch (e) { model.notes.push(`Could not read frame ${id}: ${e.message}`); }
  }
  if (f.genre) f.genre = resolveGenre(f.genre);
  if (tdat && /^\d{4}$/.test(tdat) && /^\d{4}$/.test(f.year || '')) f.year = `${f.year}-${tdat.slice(2, 4)}-${tdat.slice(0, 2)}`;
  if (f.compilation) f.compilation = f.compilation === '0' ? '' : '1';
  return model;
}

/* ------------------------------------------------------------------ writer */
function frame(id, content, version, f1 = 0) {
  const size = version === 4 ? wSyncsafe(content.length) : w32be(content.length);
  return concat([asciiBytes(id), size, new Uint8Array([f1, 0]), content]);
}
function pickEnc(version, ...strs) {
  if (version === 4) return strs.every((s) => /^[\x00-\x7f]*$/.test(s)) ? 0 : 3;
  return strs.every((s) => isLatin1(s)) ? 0 : 1;
}
function textFrame(id, value, version) {
  const enc = pickEnc(version, value);
  const v = version === 4 ? value.split(/;\s*/).length > 1 && ['TPE1', 'TCOM', 'TCON', 'TPE2', 'TEXT'].includes(id) ? value.split(/;\s*/).join('\0') : value : value;
  return frame(id, concat([new Uint8Array([enc]), encodeText(enc, v)]), version);
}
function commFrame(id, text, version, lang = 'eng', desc = '') {
  const enc = pickEnc(version, text, desc);
  const term = new Uint8Array(termLen(enc));
  return frame(id, concat([new Uint8Array([enc]), asciiBytes((lang || 'eng').slice(0, 3).padEnd(3, ' ')), encodeText(enc, desc), term, encodeText(enc, text)]), version);
}
function txxxFrame(desc, value, version) {
  const enc = pickEnc(version, desc, value);
  return frame('TXXX', concat([new Uint8Array([enc]), encodeText(enc, desc), new Uint8Array(termLen(enc)), encodeText(enc, value)]), version);
}
function apicFrame(p, version) {
  const enc = pickEnc(version, p.desc || '');
  return frame('APIC', concat([new Uint8Array([enc]), latin1Bytes(p.mime || 'image/jpeg'), new Uint8Array([0, p.type ?? 3]), encodeText(enc, p.desc || ''), new Uint8Array(termLen(enc)), p.data]), version);
}

/**
 * Build a complete ID3v2 tag.
 * @param model tag model
 * @param opts {version:3|4, original: parsed tag or null, padding}
 */
export function buildID3v2(model, { version = 3, original = null, padding = 1024 } = {}) {
  const f = model.fields; const out = []; const notes = [];
  // Mark which original frames map onto model fields, so edited/cleared values are not also passed through.
  if (original && !original.mappedDone) { id3ToModel(original); original.mappedDone = true; }
  for (const [field, id] of Object.entries(FIELD_FRAME)) {
    const v = f[field]; if (!v) continue;
    if (id === 'TMOO' && version === 3) { out.push(txxxFrame('MOOD', v, version)); continue; }
    if (id === 'TCMP') { if (v && v !== '0') out.push(textFrame(id, '1', version)); continue; }
    out.push(textFrame(id, v, version));
  }
  if (f.track) out.push(textFrame('TRCK', f.tracktotal ? `${f.track}/${f.tracktotal}` : f.track, version));
  else if (f.tracktotal) out.push(textFrame('TRCK', `/${f.tracktotal}`, version));
  if (f.disc) out.push(textFrame('TPOS', f.disctotal ? `${f.disc}/${f.disctotal}` : f.disc, version));
  if (f.year) {
    if (version === 4) out.push(textFrame('TDRC', f.year, version));
    else {
      out.push(textFrame('TYER', f.year.slice(0, 4), version));
      const m = f.year.match(/^\d{4}-(\d{2})-(\d{2})/); if (m) out.push(textFrame('TDAT', m[2] + m[1], version));
    }
  }
  if (f.comment) { const orig = original?.frames.find((x) => x.id === 'COMM' && x.mapped); out.push(commFrame('COMM', f.comment, version, orig?.lang || 'eng')); }
  if (f.lyrics) out.push(commFrame('USLT', f.lyrics, version));
  for (const c of model.custom || []) if (c.key) out.push(txxxFrame(c.key, c.value ?? '', version));
  for (const p of model.pictures || []) out.push(apicFrame(p, version));
  // passthrough
  if (original) {
    for (const fr of original.frames) {
      if (fr.mapped) continue;
      if (MANAGED.has(fr.id) && fr.parsable) continue;
      if (fr.v22 || fr.id.length !== 4) { notes.push(`Dropped ID3v2.2 frame ${fr.origId} (no v2.${version} equivalent)`); continue; }
      if (fr.parsable) out.push(frame(fr.id, fr.content, version));
      else if (original.major === version) out.push(fr.raw.slice());
      else notes.push(`Dropped compressed/encrypted frame ${fr.id} (cannot convert between ID3 versions)`);
    }
  }
  const body = concat(out);
  const pad = new Uint8Array(Math.max(0, padding));
  const header = concat([asciiBytes('ID3'), new Uint8Array([version, 0, 0]), wSyncsafe(body.length + pad.length)]);
  return { bytes: concat([header, body, pad]), notes };
}

/* ------------------------------------------------------------------ ID3v1 */
export function parseID3v1(b) {
  if (b.length < 128 || ascii(b, 0, 3) !== 'TAG') return null;
  const str = (o, n) => latin1(b.subarray(o, o + n)).replace(/\0.*$/s, '').trim();
  const f = { title: str(3, 30), artist: str(33, 30), album: str(63, 30), year: str(93, 4) };
  if (b[125] === 0 && b[126] !== 0) { f.comment = str(97, 28); f.track = String(b[126]); } else f.comment = str(97, 30);
  if (b[127] < GENRES.length) f.genre = GENRES[b[127]];
  for (const k of Object.keys(f)) if (!f[k]) delete f[k];
  return f;
}
export function buildID3v1(fields) {
  const b = new Uint8Array(128); b.set(asciiBytes('TAG'));
  const put = (o, n, s) => { const t = latin1Bytes([...(s || '')].map((c) => (c.charCodeAt(0) < 256 ? c : '?')).join('')).subarray(0, n); b.set(t, o); };
  put(3, 30, fields.title); put(33, 30, fields.artist); put(63, 30, fields.album); put(93, 4, (fields.year || '').slice(0, 4));
  put(97, 28, fields.comment);
  const tr = parseInt(fields.track, 10); if (tr > 0 && tr < 256) { b[125] = 0; b[126] = tr; }
  const g = (fields.genre || '').split(/;\s*/)[0];
  const gi = GENRES.findIndex((x) => x.toLowerCase() === g.toLowerCase());
  b[127] = gi >= 0 ? gi : 255;
  return b;
}
