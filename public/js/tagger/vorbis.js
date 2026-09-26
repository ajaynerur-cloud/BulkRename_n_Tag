// Vorbis comments (FLAC, Ogg Vorbis, Opus) <-> model, and FLAC PICTURE blocks.
import { u32le, u32be, w32le, w32be, utf8, utf8Bytes, concat, ascii, asciiBytes, mimeFromBytes, imageSize } from './bytes.js';
import { splitNumTotal } from './model.js';
import { bytesToBase64, base64ToBytes } from '../core/utils.js';

const MAP = {
  TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'albumartist', 'ALBUM ARTIST': 'albumartist', DATE: 'year', YEAR: 'year', GENRE: 'genre',
  COMPOSER: 'composer', COMMENT: 'comment', DESCRIPTION: 'comment', LYRICS: 'lyrics', UNSYNCEDLYRICS: 'lyrics', ORGANIZATION: 'publisher', LABEL: 'publisher', PUBLISHER: 'publisher',
  COPYRIGHT: 'copyright', ENCODEDBY: 'encodedby', 'ENCODED-BY': 'encodedby', BPM: 'bpm', KEY: 'key', INITIALKEY: 'key', ISRC: 'isrc', GROUPING: 'grouping', CONTENTGROUP: 'grouping',
  COMPILATION: 'compilation', CONDUCTOR: 'conductor', LYRICIST: 'lyricist', REMIXER: 'remixer', SUBTITLE: 'subtitle', MOOD: 'mood', LANGUAGE: 'language',
  TITLESORT: 'sorttitle', ARTISTSORT: 'sortartist', ALBUMSORT: 'sortalbum', ALBUMARTISTSORT: 'sortalbumartist',
};
const WRITE = {
  title: 'TITLE', artist: 'ARTIST', album: 'ALBUM', albumartist: 'ALBUMARTIST', year: 'DATE', genre: 'GENRE', composer: 'COMPOSER', comment: 'COMMENT', lyrics: 'LYRICS',
  publisher: 'ORGANIZATION', copyright: 'COPYRIGHT', encodedby: 'ENCODEDBY', bpm: 'BPM', key: 'KEY', isrc: 'ISRC', grouping: 'GROUPING', compilation: 'COMPILATION',
  conductor: 'CONDUCTOR', lyricist: 'LYRICIST', remixer: 'REMIXER', subtitle: 'SUBTITLE', mood: 'MOOD', language: 'LANGUAGE', sorttitle: 'TITLESORT', sortartist: 'ARTISTSORT',
  sortalbum: 'ALBUMSORT', sortalbumartist: 'ALBUMARTISTSORT',
};

/** Parse a vorbis comment block (without framing). Returns {vendor, comments: [[KEY, value]]} */
export function parseVorbisComment(b, o = 0) {
  const vlen = u32le(b, o); const vendor = utf8(b.subarray(o + 4, o + 4 + vlen)); let p = o + 4 + vlen;
  const n = u32le(b, p); p += 4; const comments = [];
  for (let i = 0; i < n && p + 4 <= b.length; i++) {
    const len = u32le(b, p); p += 4;
    const s = utf8(b.subarray(p, p + len)); p += len;
    const eq = s.indexOf('='); if (eq <= 0) continue;
    comments.push([s.slice(0, eq), s.slice(eq + 1)]);
  }
  return { vendor, comments, end: p };
}
export function buildVorbisComment(vendor, comments) {
  const parts = []; const v = utf8Bytes(vendor || 'NameTag');
  parts.push(w32le(v.length), v, w32le(comments.length));
  for (const [k, val] of comments) { const s = utf8Bytes(`${k}=${val}`); parts.push(w32le(s.length), s); }
  return concat(parts);
}

export function commentsToModel(comments, model) {
  const f = model.fields; const multi = {};
  for (const [kRaw, v] of comments) {
    const k = kRaw.toUpperCase();
    if (k === 'METADATA_BLOCK_PICTURE') { try { model.pictures.push(parsePictureBlock(base64ToBytes(v))); } catch { model.notes.push('Unreadable embedded picture'); } continue; }
    if (k === 'COVERART') { try { const data = base64ToBytes(v); model.pictures.push({ type: 3, mime: mimeFromBytes(data), desc: '', data }); } catch { /* ignore */ } continue; }
    if (k === 'COVERARTMIME') continue;
    if (k === 'TRACKNUMBER') { const [a, b] = splitNumTotal(v); f.track = a; if (b && !f.tracktotal) f.tracktotal = b; continue; }
    if (k === 'DISCNUMBER') { const [a, b] = splitNumTotal(v); f.disc = a; if (b && !f.disctotal) f.disctotal = b; continue; }
    if (k === 'TRACKTOTAL' || k === 'TOTALTRACKS') { f.tracktotal = String(parseInt(v, 10) || v); continue; }
    if (k === 'DISCTOTAL' || k === 'TOTALDISCS') { f.disctotal = String(parseInt(v, 10) || v); continue; }
    const field = MAP[k];
    if (field) { (multi[field] ||= []).push(v); continue; }
    model.custom.push({ key: kRaw, value: v });
  }
  for (const [k, arr] of Object.entries(multi)) f[k] = [...new Set(arr)].join('; ');
  if (f.compilation) f.compilation = f.compilation === '0' ? '' : '1';
  return model;
}

export function modelToComments(model, { embedPictures = false } = {}) {
  const f = model.fields; const out = [];
  for (const [field, key] of Object.entries(WRITE)) {
    const v = f[field]; if (!v) continue;
    if (['artist', 'genre', 'composer', 'albumartist'].includes(field) && v.includes('; ')) for (const x of v.split(/;\s+/)) out.push([key, x]);
    else out.push([key, v]);
  }
  if (f.track) out.push(['TRACKNUMBER', f.track]);
  if (f.tracktotal) out.push(['TRACKTOTAL', f.tracktotal]);
  if (f.disc) out.push(['DISCNUMBER', f.disc]);
  if (f.disctotal) out.push(['DISCTOTAL', f.disctotal]);
  for (const c of model.custom || []) if (c.key) out.push([c.key.replace(/[=~]/g, '_'), c.value ?? '']);
  if (embedPictures) for (const p of model.pictures || []) out.push(['METADATA_BLOCK_PICTURE', bytesToBase64(buildPictureBlock(p))]);
  return out;
}

/** FLAC PICTURE block body */
export function parsePictureBlock(b) {
  let o = 0; const type = u32be(b, o); o += 4;
  const ml = u32be(b, o); o += 4; const mime = ascii(b, o, ml); o += ml;
  const dl = u32be(b, o); o += 4; const desc = utf8(b.subarray(o, o + dl)); o += dl;
  o += 16; const len = u32be(b, o); o += 4;
  const data = b.slice(o, o + len);
  return { type, mime: mime || mimeFromBytes(data), desc, data };
}
export function buildPictureBlock(p) {
  const mime = asciiBytes(p.mime || mimeFromBytes(p.data)); const desc = utf8Bytes(p.desc || '');
  const sz = imageSize(p.data) || { w: 0, h: 0 };
  return concat([w32be(p.type ?? 3), w32be(mime.length), mime, w32be(desc.length), desc, w32be(sz.w), w32be(sz.h), w32be(24), w32be(0), w32be(p.data.length), p.data]);
}
